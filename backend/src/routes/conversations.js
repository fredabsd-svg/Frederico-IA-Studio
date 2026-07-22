// Rotas de conversations — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { runAgent, runOrchestrator, runMultiModel, normalizeMultiModelConfig, cancelMultiModelSlot, setControl, isConversationActive, countActiveRunsForUser, friendlyApiError, loadCheckpoint, hasCheckpoint } from '../agent.js';
import { openLiveStream, getLiveStream } from '../liveStream.js';
import { runTool } from '../tools.js';
import { classifyTaskResult } from '../taskOutcome.js';
import { workspaceFor, insideBase, realInside } from '../sandbox.js';
import { sanitizeToolProtocolText } from '../toolProtocol.js';
import { deleteConversationDeep } from '../privacy.js';
import { validate, schemas } from '../validation.js';
import { getUserProvider } from '../userProvider.js';
import { enforceFreeTierLimits, bumpFreeTierUsage, logFreeTierEvent, freeTierStatusFor } from '../freeTier.js';
import { acquireFreeSlot, cancelFreeJob, freeQueueSnapshot } from '../freeQueue.js';
import { makeRouter, upload, scanOrReject, decodeUploadName, loadAssistant, ensureConversation, enforceDailyLimit, looksLikeFailedAssistantReply } from './helpers.js';

const router = makeRouter();

router.get('/conversations', async (req, res) => {
  // `active` em cada linha: a conversa está processando AGORA? A barra lateral
  // usa isso para girar o indicador de conversa ativa (multiconversa).
  const withActive = (rows) => rows.map(row => ({ ...row, active: isConversationActive(row.id) }));
  if (req.query.all === '1') return res.json(withActive(await db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(req.userId)));
  const clientId = req.query.client || null;
  const rows = clientId
    ? await db.prepare('SELECT * FROM conversations WHERE user_id=? AND client_id=? ORDER BY updated_at DESC').all(req.userId, clientId)
    : await db.prepare('SELECT * FROM conversations WHERE user_id=? AND client_id IS NULL ORDER BY updated_at DESC').all(req.userId);
  res.json(withActive(rows));
});

router.post('/conversations', validate(schemas.conversationCreate), async (req, res) => {
  const id = nanoid();
  const t = now();
  const title = req.body?.title || 'Nova conversa';
  const model = req.body?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const clientId = req.body?.clientId || null;
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, req.userId, title, model, clientId, t, t);
  workspaceFor(id);
  res.json({ id, title, model, client_id: clientId, created_at: t, updated_at: t });
});

router.get('/conversations/:id', async (req, res) => {
  // Verifica a POSSE antes de tocar nas mensagens (isolamento): se a conversa
  // não é do usuário logado, 404 — nunca cria nem revela dados de outro dono.
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conversation) return res.status(404).json({ error: 'Não encontrado' });
  const messages = await db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC, seq ASC').all(req.params.id);
  // Anexa a cada mensagem os arquivos que ela gerou
  const byMsg = {};
  for (const f of await db.prepare('SELECT id,name,path,size,message_id FROM files WHERE conversation_id=? AND message_id IS NOT NULL').all(req.params.id)) {
    (byMsg[f.message_id] ||= []).push(f);
  }
  messages.forEach((m, index) => {
    if (m.role === 'assistant') {
      m.content = sanitizeToolProtocolText(m.content);
      if (looksLikeFailedAssistantReply(m.content)) {
        const previousUser = [...messages.slice(0, index)].reverse().find(item => item.role === 'user');
        m.failed = true;
        m.retryText = previousUser?.content || '';
      }
    }
    m.files = byMsg[m.id] || [];
    if (m.memory_meta) {
      try { m.memory = JSON.parse(m.memory_meta); } catch {}
    }
    delete m.memory_meta;
    // Execução multimodelo: devolve os cartões por modelo para a interface
    if (m.multi_meta) {
      try { m.multi = JSON.parse(m.multi_meta); } catch {}
    }
    delete m.multi_meta;
    if (m.execution_meta) {
      try { m.execution = JSON.parse(m.execution_meta); } catch {}
    }
    delete m.execution_meta;
  });
  // active: há um processamento rodando AGORA nesta conversa? O front usa isso
  // para, ao reabrir a conversa, reconectar ao stream ao vivo (GET /stream) e
  // seguir acompanhando o andamento em vez de só mostrar o histórico parado.
  // resumable: existe um checkpoint de execução interrompida? O front mostra o
  // botão "Continuar de onde parei" na última mensagem (retomada REAL).
  const active = isConversationActive(req.params.id);
  const resumable = !active && await hasCheckpoint(req.userId, req.params.id);
  // Marca a última mensagem do assistente como retomável (o botão vive nela).
  if (resumable) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { messages[i].resumable = true; break; }
    }
  }
  res.json({ conversation, messages, active, resumable });
});

router.delete('/conversations/:id', async (req, res) => {
  const id = req.params.id;
  const existing = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  if (isConversationActive(id)) {
    return res.status(409).json({ error: 'Esta conversa ainda está concluindo uma resposta. Aguarde terminar ou interrompa o processamento antes de apagá-la.' });
  }
  // Hard delete em profundidade: mensagens, arquivos, índice de memória, fatos
  // extraídos, tarefas associadas e o workspace em disco (ver privacy.js).
  await deleteConversationDeep(req.userId, id);
  res.json({ ok: true });
});

router.post('/conversations/:id/upload', upload.array('files'), async (req, res) => {
  if (!await ensureConversation(req.userId, req.params.id)) return res.status(404).json({ error: 'Não encontrado' });
  const scan = await scanOrReject(res, req.files || []);
  if (!scan) return;
  const ws = workspaceFor(req.params.id);
  const saved = [];
  for (const file of scan.clean) {
    const original = decodeUploadName(file.originalname);
    const safe = original.replace(/[^a-zA-Z0-9._ -]/g, '_');
    const name = `${Date.now()}_${nanoid(8)}_${safe}`;
    const target = path.join(ws.uploads, name);
    fs.writeFileSync(target, file.buffer);
    try { fs.chownSync(target, 1000, 1000); } catch {}
    const id = nanoid();
    await db.prepare('INSERT INTO files (id,conversation_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.params.id, 'upload', original, `uploads/${name}`, file.size, now());
    saved.push({ id, name: original, path: `uploads/${name}`, size: file.size });
  }
  res.json({ files: saved, scanned: scan.scanned, rejected: scan.rejected });
});

router.get('/conversations/:id/files', async (req, res) => {
  if (!await ensureConversation(req.userId, req.params.id)) return res.status(404).json({ error: 'Não encontrado' });
  const ws = workspaceFor(req.params.id);
  const outputFiles = walk(ws.outputs).map(p => {
    if (!realInside(ws.base, p)) return null;
    const rel = path.relative(ws.base, p).replaceAll('\\', '/');
    let size = 0;
    try { size = fs.statSync(p).size; } catch { return null; } // arquivo removido no meio da varredura
    return { id: Buffer.from(rel).toString('base64url'), kind: 'output', name: path.basename(p), path: rel, size };
  }).filter(Boolean);
  const uploaded = await db.prepare('SELECT id,kind,name,path,size,created_at FROM files WHERE conversation_id=?').all(req.params.id);
  res.json([...uploaded, ...outputFiles]);
});

router.delete('/conversations/:id/files/*', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const ws = workspaceFor(req.params.id);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!insideBase(ws.base, target) || !realInside(ws.base, target)) return res.status(400).json({ error: 'Caminho inválido' });
  try { fs.rmSync(target, { force: true }); } catch {}
  await db.prepare('DELETE FROM files WHERE conversation_id=? AND path=?').run(req.params.id, rel.replaceAll('\\', '/'));
  res.json({ ok: true });
});

router.get('/conversations/:id/download/*', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).send('Arquivo não encontrado');
  const ws = workspaceFor(req.params.id);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!insideBase(ws.base, target) || !realInside(ws.base, target) || !fs.existsSync(target)) return res.status(404).send('Arquivo não encontrado');
  res.download(target);
});

// Exporta a conversa como PDF ou Word (gerado dentro do sandbox)
const PY_EXPORT = [
  'import json',
  "d = json.load(open('/workspace/.export.json'))",
  "fmt = '__FMT__'",
  "out = '/workspace/outputs/__OUT__'",
  "role = {'user': 'Voce', 'assistant': 'Assistente'}",
  "if fmt == 'docx':",
  '    from docx import Document',
  '    doc = Document()',
  "    doc.add_heading(d['title'], 0)",
  "    for m in d['messages']:",
  '        p = doc.add_paragraph()',
  "        r = p.add_run(role.get(m['role'], m['role']) + ' - ' + m['created_at'][:16].replace('T', ' '))",
  '        r.bold = True',
  "        doc.add_paragraph(m['content'])",
  '    doc.save(out)',
  'else:',
  '    from reportlab.lib.pagesizes import A4',
  '    from reportlab.lib.styles import getSampleStyleSheet',
  '    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer',
  '    from xml.sax.saxutils import escape',
  '    styles = getSampleStyleSheet()',
  "    story = [Paragraph(escape(d['title']), styles['Title']), Spacer(1, 12)]",
  "    for m in d['messages']:",
  "        story.append(Paragraph('<b>' + role.get(m['role'], m['role']) + '</b> - ' + m['created_at'][:16].replace('T', ' '), styles['Heading4']))",
  "        for line in m['content'].split('\\n'):",
  '            if line.strip():',
  "                story.append(Paragraph(escape(line), styles['BodyText']))",
  '        story.append(Spacer(1, 10))',
  '    SimpleDocTemplate(out, pagesize=A4).build(story)',
  "print('OK')"
].join('\n');

router.post('/conversations/:id/export', async (req, res) => {
  try {
    const format = req.body?.format === 'docx' ? 'docx' : 'pdf';
    const conv = await db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
    if (!conv) return res.status(404).json({ error: 'Não encontrado' });
    const messages = (await db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC, seq ASC').all(req.params.id))
      .map(message => ({
        ...message,
        content: message.role === 'assistant'
          ? sanitizeToolProtocolText(message.content)
          : message.content
      }));
    if (!messages.length) return res.status(400).json({ error: 'A conversa ainda não tem mensagens.' });
    const ws = workspaceFor(req.params.id);
    const jsonPath = path.join(ws.base, '.export.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: conv.title, messages }), 'utf8');
    try { fs.chownSync(jsonPath, 1000, 1000); } catch {}
    const slug = (conv.title || 'conversa').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'conversa';
    const name = `conversa-${slug}.${format}`;
    const result = JSON.parse(await runTool(req.params.id, 'run_python', { code: PY_EXPORT.replace('__FMT__', format).replace('__OUT__', name) }));
    try { fs.rmSync(jsonPath, { force: true }); } catch {}
    if (result.exitCode !== 0) return res.status(500).json({ error: 'Falha ao exportar: ' + String(result.output).slice(-200) });
    res.json({ ok: true, path: `outputs/${name}`, name });
  } catch (err) {
    console.error('[export]', err);
    res.status(500).json({ error: 'Falha ao exportar a conversa.' });
  }
});

// Edição de mensagem (estilo ChatGPT): remove a mensagem indicada e TUDO que
// veio depois dela na conversa, incluindo os arquivos gerados por essas
// mensagens — a conversa é regravada a partir dali.
router.post('/conversations/:id/truncate', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const msg = await db.prepare('SELECT id, seq FROM messages WHERE id=? AND conversation_id=?').get(req.body?.messageId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
  // "Desta mensagem em diante" = mesma ordem de inserção ou posterior (seq).
  const fromMessage = 'seq >= ?';
  const doomed = (await db.prepare(`SELECT id FROM messages WHERE conversation_id=? AND ${fromMessage}`)
    .all(req.params.id, msg.seq)).map(r => r.id);
  if (doomed.length) {
    const ws = workspaceFor(req.params.id);
    const ph = doomed.map(() => '?').join(',');
    const orphanFiles = await db.prepare(`SELECT path FROM files WHERE conversation_id=? AND message_id IN (${ph})`).all(req.params.id, ...doomed);
    for (const f of orphanFiles) {
      const target = path.resolve(ws.base, f.path);
      if (insideBase(ws.base, target)) { try { fs.rmSync(target, { force: true }); } catch {} }
    }
    await db.prepare(`DELETE FROM files WHERE conversation_id=? AND message_id IN (${ph})`).run(req.params.id, ...doomed);
  }
  await db.prepare(`DELETE FROM messages WHERE conversation_id=? AND ${fromMessage}`)
    .run(req.params.id, msg.seq);
  // Privacidade: limpa o índice e os resumos derivados das mensagens removidas
  // (os chunks serão reindexados conforme a conversa continuar)
  await db.prepare('DELETE FROM conversation_chunks WHERE conversation_id=? AND user_id=?').run(req.params.id, req.userId);
  await db.prepare('UPDATE conversations SET summary_short=NULL, summary_long=NULL WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true, removed: doomed.length });
});

// Pausar / continuar / parar o processamento em andamento
router.post('/conversations/:id/control', validate(schemas.control), async (req, res) => {
  const action = req.body.action; // enum garantido por validate(schemas.control)
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const control = setControl(req.params.id, action);
  if (!control) {
    // "Parar" também cancela uma solicitação que AINDA aguarda na fila do modo
    // gratuito (ela não tem controle ativo porque nem começou a processar).
    if (action === 'stop' && cancelFreeJob(req.params.id)) {
      return res.json({ ok: true, action, cancelled: true });
    }
    return res.status(409).json({ error: 'Não há processamento ativo nesta conversa.' });
  }
  res.json({ ok: true, action, paused: control.paused, stopped: control.stopped });
});

// Multimodelo: interrompe UM modelo da execução em andamento, sem derrubar os
// demais (o botão "parar tudo" continua sendo o /control com action=stop).
router.post('/conversations/:id/multimodel/cancel', validate(schemas.multiModelCancelSlot), async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const ok = cancelMultiModelSlot(req.params.id, req.body.slot);
  if (!ok) return res.status(409).json({ error: 'Não há execução multimodelo ativa nesta conversa.' });
  res.json({ ok: true, slot: req.body.slot });
});

// RECONEXÃO ao processamento em andamento. Quando o usuário volta à conversa
// (mesmo dispositivo/sessão) e ela ainda está processando, o front abre este
// SSE: recebe primeiro o REPLAY de tudo que já aconteceu no run (para remontar a
// resposta parcial) e depois os eventos ao vivo, até "done"/"error". Sem corpo
// novo — não dispara outro run, só acompanha o que já roda.
router.get('/conversations/:id/stream', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const live = getLiveStream(req.params.id);
  // 204: não há (mais) nada rodando nem no buffer — o front então confia só no
  // histórico já carregado do banco.
  if (!live) return res.status(204).end();
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let gone = false;
  const heartbeat = setInterval(() => { if (!gone && !res.writableEnded) { try { res.write(': ping\n\n'); } catch { gone = true; } } }, 15000);
  const closeUp = () => { if (gone) return; gone = true; clearInterval(heartbeat); if (!res.writableEnded) res.end(); };
  const write = (event) => {
    if (gone || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { gone = true; }
    // Ao chegar o evento terminal, drenamos e fechamos — o cliente já tem tudo.
    if (event && (event.type === 'done' || event.type === 'error')) closeUp();
  };
  // fromSeq permite retomar sem duplicar caso o cliente reconecte o próprio
  // /stream; por padrão (0) reproduz o run inteiro desde o começo.
  const fromSeq = Number.parseInt(req.query.fromSeq, 10) || 0;
  const unsubscribe = live.subscribe((rec) => write({ ...rec.event, _seq: rec.seq }), fromSeq);
  res.on('close', () => { clearInterval(heartbeat); unsubscribe(); gone = true; });
});

router.post('/conversations/:id/chat', validate(schemas.chat), async (req, res) => {
  // Tipo/tamanho/trim de `message` já garantidos por validate(schemas.chat).
  const text = req.body.message;
  if (isConversationActive(req.params.id)) {
    return res.status(409).json({ error: 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de enviar outra mensagem.' });
  }
  // Multiconversa: várias conversas podem processar AO MESMO TEMPO, mas com um
  // teto por usuário para proteger a VPS (cada execução consome provedor,
  // memória e possivelmente um sandbox). Configurável por env.
  const maxRuns = Math.max(1, Number(process.env.MAX_ACTIVE_RUNS_PER_USER) || 5);
  if (countActiveRunsForUser(req.userId) >= maxRuns) {
    return res.status(429).json({ error: `Você já tem ${maxRuns} conversas processando ao mesmo tempo. Aguarde alguma terminar (o indicador na barra lateral para de girar) ou pare uma delas antes de iniciar outra.` });
  }
  if (!await ensureConversation(req.userId, req.params.id, req.body?.model)) return res.status(404).json({ error: 'Não encontrado' });
  const limitMsg = await enforceDailyLimit(req.userId);
  if (limitMsg) return res.status(429).json({ error: limitMsg });
  // MODO GRATUITO: limites próprios (diário/por minuto/bloqueio) checados ANTES
  // do SSE começar — o front recebe um JSON estruturado (code) e mostra a tela
  // amigável de limite, não um erro técnico.
  const provider = await getUserProvider(req.userId);
  const freeMode = provider.source === 'free';
  if (freeMode) {
    const denial = await enforceFreeTierLimits(req.userId);
    if (denial) {
      logFreeTierEvent({ userId: req.userId, model: provider.model, status: denial.code === 'free_blocked' ? 'blocked' : 'limited', detail: denial.code });
      const status = denial.code === 'free_blocked' ? 403 : 429;
      return res.status(status).json({ error: denial.error, code: denial.code, resetAt: denial.resetAt, used: denial.used, limit: denial.limit });
    }
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // clientGone: o usuário saiu da página/minimizou (conexão SSE fechada). A
  // partir daí, as escritas SSE viram no-op — mas a TAREFA continua rodando.
  let clientGone = false;
  // Stream ao vivo desta conversa: TODO evento é publicado aqui (buffer + fan-out)
  // antes de ir para a resposta atual. Assim, se o usuário reconectar por outra
  // aba/depois de recarregar (GET /stream), ele recebe o replay do que já passou
  // e segue recebendo os próximos eventos — mesmo que ESTA conexão já tenha caído.
  const live = openLiveStream(req.params.id);
  const send = (event) => {
    live.publish(event);
    if (clientGone || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch { clientGone = true; }
  };
  // Pulso (heartbeat): comentário SSE a cada 15s para a conexão nunca ficar
  // "ociosa" durante esperas longas (modelo pensando, pesquisa na web). Sem
  // isso, proxies/gateways cortam com "Upstream idle timeout exceeded". O
  // cliente ignora linhas que não começam com "data:".
  const heartbeat = setInterval(() => { if (!clientGone && !res.writableEnded) { try { res.write(': ping\n\n'); } catch { clientGone = true; } } }, 15000);
  // Se o navegador desconectar (TROCAR DE ABA, MINIMIZAR no celular, rede
  // oscilando), a tarefa NÃO é mais interrompida: ela continua rodando e o
  // resultado é salvo na conversa, então ao voltar o usuário encontra o
  // arquivo/resposta prontos (antes, sair da página abortava tudo com "conexão
  // interrompida" — o bug relatado). Só cancelamos ao desconectar se
  // CANCEL_ON_DISCONNECT=true (comportamento antigo, para economizar tokens).
  // IMPORTANTE: usar o 'close' da RESPOSTA (res), não do pedido (req) — o
  // 'close' do req dispara assim que o corpo do POST termina de chegar.
  const cancelOnDisconnect = String(process.env.CANCEL_ON_DISCONNECT || '').toLowerCase() === 'true';
  res.on('close', () => {
    clientGone = true;
    clearInterval(heartbeat);
    if (cancelOnDisconnect && !res.writableEnded) setControl(req.params.id, 'stop');
    // Job ainda na fila do modo gratuito não sobrevive à desconexão: sem
    // ninguém para receber a resposta, a vaga volta para quem está esperando.
    if (!res.writableEnded) cancelFreeJob(req.params.id);
  });
  let releaseFreeSlot = null;
  try {
    // FILA DO MODO GRATUITO: concorrência limitada na chave da plataforma. O
    // usuário vê os estados (preparando/aguardando/posição) e pode cancelar
    // enquanto espera (POST /control action=stop cancela o job na fila).
    if (freeMode) {
      const snapshot = freeQueueSnapshot();
      send({ type: 'free_queue', state: 'preparing', provider: provider.providerName, model: provider.model });
      if (snapshot.running >= snapshot.concurrency) {
        send({ type: 'free_queue', state: 'waiting', position: snapshot.waiting + 1, total: snapshot.waiting + 1 });
      }
      releaseFreeSlot = await acquireFreeSlot({
        id: req.params.id,
        onPosition: (position, total) => send({ type: 'free_queue', state: 'waiting', position, total })
      });
      send({ type: 'free_queue', state: 'processing' });
    }
    // Título automático: usa o início da 1ª mensagem em vez de "Nova conversa"
    const conv = await db.prepare('SELECT title FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
    if (conv && (!conv.title?.trim() || conv.title === 'Nova conversa')) {
      const autoTitle = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (autoTitle) await db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?').run(autoTitle, req.params.id, req.userId);
    }
    let result, kind = 'chat', usageAssistantId = req.body?.assistantId || null;
    // MULTIMODELO tem prioridade sobre os demais modos: 2+ modelos executam a
    // mesma solicitação (comparação, conselho, debate ou pipeline sequencial).
    const multiConfig = req.body?.multiModel ? normalizeMultiModelConfig(req.body.multiModel) : null;
    if (multiConfig) {
      kind = 'multimodelo'; usageAssistantId = null;
      result = await runMultiModel({
        userId: req.userId,
        conversationId: req.params.id,
        userText: text,
        config: multiConfig,
        webSearch: !!req.body?.webSearch,
        effort: req.body?.effort,
        developer: req.body?.developer,
        onEvent: send
      });
    } else if (req.body?.orchestrate) {
      const assistants = (await Promise.all((req.body?.orchestrateIds || []).map(id => loadAssistant(req.userId, id)))).filter(Boolean);
      kind = 'orquestrador'; usageAssistantId = null;
      const executor = await loadAssistant(req.userId, req.body?.assistantId);
      result = await runOrchestrator({
        userId: req.userId,
        conversationId: req.params.id,
        userText: text,
        model: req.body?.model,
        assistants,
        executor,
        webSearch: !!req.body?.webSearch,
        effort: req.body?.effort,
        developer: req.body?.developer,
        onEvent: send
      });
    } else {
      const assistant = await loadAssistant(req.userId, req.body?.assistantId);
      result = await runAgent({ userId: req.userId, conversationId: req.params.id, userText: text, model: req.body?.model, assistant, webSearch: !!req.body?.webSearch, effort: req.body?.effort, developer: req.body?.developer, onEvent: send });
    }
    const chatOutcome = classifyTaskResult(result);
    if (chatOutcome.status === 'error') {
      send({ type: 'execution_failed', content: chatOutcome.error });
    }
    // Registra o consumo de tokens para o painel de análises
    if (result?.usage) {
      await db.prepare('INSERT INTO usage (id,user_id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(nanoid(), req.userId, req.params.id, usageAssistantId, result.model, kind, result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, now());
    }
    // MODO GRATUITO: contabiliza no limite diário, registra o evento (auditoria/
    // painel admin) e manda o status atualizado (restante/renovação) ao front.
    if (freeMode) {
      const tokens = result?.usage?.total_tokens || 0;
      await bumpFreeTierUsage(req.userId, tokens);
      logFreeTierEvent({ userId: req.userId, model: result?.model || provider.model, status: 'ok', tokens });
      try { send({ type: 'free_status', ...(await freeTierStatusFor(req.userId, { optedIn: true, source: 'free' })) }); } catch {}
    }
    send({ type: 'done' });
  } catch (err) {
    if (err?.code === 'FREE_QUEUE_CANCELLED') {
      // O usuário cancelou enquanto aguardava na fila do modo gratuito — não é
      // erro: encerra silenciosamente sem consumir cota.
      logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'cancelled', detail: 'cancelado na fila' });
      send({ type: 'free_queue', state: 'cancelled' });
      send({ type: 'done' });
    } else if (err?.code === 'FREE_QUEUE_FULL') {
      logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'limited', detail: 'fila cheia' });
      send({ type: 'error', content: 'O modo gratuito está com muitas solicitações agora. Aguarde alguns minutos e tente de novo — ou adicione a sua própria chave de API em Configurações para não depender da fila.' });
    } else {
      console.error('[chat]', err);
      if (freeMode) logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'error', detail: String(err?.message || err).slice(0, 300) });
      send({ type: 'error', content: friendlyApiError(err) });
    }
  } finally {
    releaseFreeSlot?.();
    clearInterval(heartbeat);
    // Encerra o run no registro ao vivo: mantém o buffer por uma janela de
    // carência para quem reconectar no último segundo, depois se apaga sozinho.
    live.finish();
    res.end();
  }
});

// RETOMADA REAL: continua uma tarefa interrompida A PARTIR DO CHECKPOINT (não
// recomeça do zero). Diferente do /chat: NÃO grava uma nova mensagem de
// usuário, carrega o estado salvo (array de mensagens do agente + modelo +
// cadeia de failover) e passa `resume` ao runAgent, que prossegue da próxima
// etapa pendente com um orçamento de ciclos NOVO. Reusa o MESMO mecanismo de
// stream/live do /chat (o front consome igual).
router.post('/conversations/:id/resume', async (req, res) => {
  const conversationId = req.params.id;
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  if (isConversationActive(conversationId)) {
    return res.status(409).json({ error: 'Esta conversa já está processando. Aguarde terminar antes de continuar.' });
  }
  const checkpoint = await loadCheckpoint(req.userId, conversationId);
  if (!checkpoint) {
    return res.status(409).json({ error: 'Não há execução salva para continuar. Envie a mensagem novamente.' });
  }
  const maxRuns = Math.max(1, Number(process.env.MAX_ACTIVE_RUNS_PER_USER) || 5);
  if (countActiveRunsForUser(req.userId) >= maxRuns) {
    return res.status(429).json({ error: `Você já tem ${maxRuns} conversas processando ao mesmo tempo. Aguarde alguma terminar antes de continuar esta.` });
  }
  // MODO GRATUITO: retomar também consome o provedor — valem os mesmos limites
  // e a mesma fila do /chat.
  const provider = await getUserProvider(req.userId);
  const freeMode = provider.source === 'free';
  if (freeMode) {
    const denial = await enforceFreeTierLimits(req.userId);
    if (denial) {
      logFreeTierEvent({ userId: req.userId, model: provider.model, status: denial.code === 'free_blocked' ? 'blocked' : 'limited', detail: denial.code });
      const status = denial.code === 'free_blocked' ? 403 : 429;
      return res.status(status).json({ error: denial.error, code: denial.code, resetAt: denial.resetAt, used: denial.used, limit: denial.limit });
    }
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let clientGone = false;
  const live = openLiveStream(conversationId);
  const send = (event) => {
    live.publish(event);
    if (clientGone || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch { clientGone = true; }
  };
  const heartbeat = setInterval(() => { if (!clientGone && !res.writableEnded) { try { res.write(': ping\n\n'); } catch { clientGone = true; } } }, 15000);
  const cancelOnDisconnect = String(process.env.CANCEL_ON_DISCONNECT || '').toLowerCase() === 'true';
  res.on('close', () => {
    clientGone = true;
    clearInterval(heartbeat);
    if (cancelOnDisconnect && !res.writableEnded) setControl(conversationId, 'stop');
    if (!res.writableEnded) cancelFreeJob(conversationId);
  });
  let releaseFreeSlot = null;
  try {
    if (freeMode) {
      send({ type: 'free_queue', state: 'preparing', provider: provider.providerName, model: provider.model });
      releaseFreeSlot = await acquireFreeSlot({
        id: conversationId,
        onPosition: (position, total) => send({ type: 'free_queue', state: 'waiting', position, total })
      });
      send({ type: 'free_queue', state: 'processing' });
    }
    const meta = checkpoint.meta || {};
    const assistant = meta.assistantId ? await loadAssistant(req.userId, meta.assistantId) : null;
    // O `saved` precisa apontar para a mensagem de usuário REAL (a que originou a
    // tarefa) — buscamos a última da conversa em vez de gravar uma nova.
    const lastUser = await db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC, seq DESC LIMIT 1").get(conversationId);
    const result = await runAgent({
      userId: req.userId,
      conversationId,
      userText: checkpoint.objective,
      model: checkpoint.model,
      assistant,
      webSearch: !!meta.webSearch,
      effort: meta.effort,
      developer: meta.developer,
      resume: checkpoint,
      saveUserMessage: false,
      existingUserMessageId: lastUser?.id || null,
      onEvent: send
    });
    const chatOutcome = classifyTaskResult(result);
    if (chatOutcome.status === 'error') send({ type: 'execution_failed', content: chatOutcome.error });
    if (result?.usage) {
      await db.prepare('INSERT INTO usage (id,user_id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(nanoid(), req.userId, conversationId, meta.assistantId || null, result.model, 'chat', result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, now());
    }
    if (freeMode) {
      const tokens = result?.usage?.total_tokens || 0;
      await bumpFreeTierUsage(req.userId, tokens);
      logFreeTierEvent({ userId: req.userId, model: result?.model || provider.model, status: 'ok', tokens });
      try { send({ type: 'free_status', ...(await freeTierStatusFor(req.userId, { optedIn: true, source: 'free' })) }); } catch {}
    }
    send({ type: 'done' });
  } catch (err) {
    if (err?.code === 'FREE_QUEUE_CANCELLED') {
      logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'cancelled', detail: 'cancelado na fila (retomada)' });
      send({ type: 'free_queue', state: 'cancelled' });
      send({ type: 'done' });
    } else if (err?.code === 'FREE_QUEUE_FULL') {
      logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'limited', detail: 'fila cheia (retomada)' });
      send({ type: 'error', content: 'O modo gratuito está com muitas solicitações agora. Aguarde alguns minutos e tente continuar de novo.' });
    } else {
      console.error('[resume]', err);
      if (freeMode) logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'error', detail: String(err?.message || err).slice(0, 300) });
      send({ type: 'error', content: friendlyApiError(err) });
    }
  } finally {
    releaseFreeSlot?.();
    clearInterval(heartbeat);
    live.finish();
    res.end();
  }
});

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}

export default router;
