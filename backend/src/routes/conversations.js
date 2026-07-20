// Rotas de conversations — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { runAgent, runOrchestrator, setControl, isConversationActive, friendlyApiError } from '../agent.js';
import { runTool } from '../tools.js';
import { classifyTaskResult } from '../taskOutcome.js';
import { workspaceFor, insideBase, realInside } from '../sandbox.js';
import { sanitizeToolProtocolText } from '../toolProtocol.js';
import { deleteConversationDeep } from '../privacy.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, upload, scanOrReject, decodeUploadName, loadAssistant, ensureConversation, enforceDailyLimit, looksLikeFailedAssistantReply } from './helpers.js';

const router = makeRouter();

router.get('/conversations', async (req, res) => {
  if (req.query.all === '1') return res.json(await db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(req.userId));
  const clientId = req.query.client || null;
  const rows = clientId
    ? await db.prepare('SELECT * FROM conversations WHERE user_id=? AND client_id=? ORDER BY updated_at DESC').all(req.userId, clientId)
    : await db.prepare('SELECT * FROM conversations WHERE user_id=? AND client_id IS NULL ORDER BY updated_at DESC').all(req.userId);
  res.json(rows);
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
  });
  res.json({ conversation, messages });
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
  if (!control) return res.status(409).json({ error: 'Não há processamento ativo nesta conversa.' });
  res.json({ ok: true, action, paused: control.paused, stopped: control.stopped });
});

router.post('/conversations/:id/chat', validate(schemas.chat), async (req, res) => {
  // Tipo/tamanho/trim de `message` já garantidos por validate(schemas.chat).
  const text = req.body.message;
  if (isConversationActive(req.params.id)) {
    return res.status(409).json({ error: 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de enviar outra mensagem.' });
  }
  if (!await ensureConversation(req.userId, req.params.id, req.body?.model)) return res.status(404).json({ error: 'Não encontrado' });
  const limitMsg = await enforceDailyLimit(req.userId);
  if (limitMsg) return res.status(429).json({ error: limitMsg });
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // clientGone: o usuário saiu da página/minimizou (conexão SSE fechada). A
  // partir daí, as escritas SSE viram no-op — mas a TAREFA continua rodando.
  let clientGone = false;
  const send = (event) => {
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
  });
  try {
    // Título automático: usa o início da 1ª mensagem em vez de "Nova conversa"
    const conv = await db.prepare('SELECT title FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
    if (conv && (!conv.title?.trim() || conv.title === 'Nova conversa')) {
      const autoTitle = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (autoTitle) await db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?').run(autoTitle, req.params.id, req.userId);
    }
    let result, kind = 'chat', usageAssistantId = req.body?.assistantId || null;
    if (req.body?.orchestrate) {
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
    send({ type: 'done' });
  } catch (err) {
    console.error('[chat]', err);
    send({ type: 'error', content: friendlyApiError(err) });
  } finally {
    clearInterval(heartbeat);
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
