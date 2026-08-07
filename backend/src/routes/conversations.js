// Rotas de conversations — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { runAgent, runOrchestrator, runMultiModel, normalizeMultiModelConfig, cancelMultiModelSlot, setControl, isConversationActive, countActiveRunsForUser, friendlyApiError, loadCheckpoint, hasCheckpoint } from '../agent.js';
import { loadPipelineRun } from '../agent/pipelineRuns.js';
import { acquireConversationControl, releaseConversationControl } from '../agent/control.js';
import { createRunLog, listConversationRuns } from '../agent/runLog.js';
import { collectConversationChanges } from '../agent/changeSet.js';
import { fileDiff, revertChange } from '../agent/diffView.js';
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
import { makeRouter, upload, scanOrReject, decodeUploadName, loadAssistant, ensureConversation, enforceDailyLimit, looksLikeFailedAssistantReply, beginUpload, enforceUploadLimits, cleanupRequestUploads } from './helpers.js';
import { commitUploadedFile, hashFileStreamSync } from '../uploads.js';
import { runGithubTool } from '../connectors/github.js';
import { projectIdForConversation, getProject } from '../memory/projectStore.js';
import { validateAttachmentManifest } from '../attachments.js';
import { kickProcessing, mimeForName } from '../docling/service.js';
import { purgeIfOrphan } from '../docling/retention.js';
import { resolveDefaultModelRef } from '../defaults.js';
import { recordUsage } from '../usage.js';

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
  const model = req.body?.model || resolveDefaultModelRef();
  const clientId = req.body?.clientId || null;
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, req.userId, title, model, clientId, t, t);
  workspaceFor(id, req.userId);
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

router.post('/conversations/:id/upload', (req, res, next) => {
  // Portão ANTES do multer: recusa pelo Content-Length e limita a concorrência
  // por usuário (ver routes/helpers.js → beginUpload).
  const gate = beginUpload(req, res);
  if (!gate) return;
  res.on('close', gate.release);
  res.on('finish', gate.release);
  next();
}, upload.array('files'), async (req, res) => {
  try {
    if (!await ensureConversation(req.userId, req.params.id)) {
      cleanupRequestUploads(req);
      return res.status(404).json({ error: 'Não encontrado' });
    }
    const ws = workspaceFor(req.params.id, req.userId);
    // Cota de disco: mede a árvore INTEIRA do usuário, não só desta conversa.
    if (!enforceUploadLimits(req, res, { quotaDir: path.dirname(ws.base) })) return;
    const scan = await scanOrReject(res, req.files || [], req);
    if (!scan) return;
    const saved = [];
    for (const file of scan.clean) {
      const original = decodeUploadName(file.originalname);
      const safe = original.replace(/[^a-zA-Z0-9._ -]/g, '_');
      const name = `${Date.now()}_${nanoid(8)}_${safe}`;
      const target = path.join(ws.uploads, name);
      // Hash por streaming ANTES de mover (o arquivo nunca é lido inteiro na RAM).
      const hash = hashFileStreamSync(file.path);
      // F-11: se o antivírus estava degradado, o arquivo vai para
      // uploads/.quarantine/ em vez de uploads/ — o conjunto "verificado" só
      // passa a incluir este arquivo DEPOIS do re-escaneamento bem-sucedido.
      const inQuarantine = scan.status === 'degradado';
      const finalTarget = inQuarantine ? path.join(ws.uploads, '.quarantine', name) : target;
      const finalRel = inQuarantine ? `uploads/.quarantine/${name}` : `uploads/${name}`;
      const size = commitUploadedFile(file.path, finalTarget);
      const id = nanoid();
      const mime = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : mimeForName(original);
      await db.prepare('INSERT INTO files (id,conversation_id,kind,name,path,size,hash,mime,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, req.params.id, 'upload', original, finalRel, size, hash, mime, now());
      if (inQuarantine) {
        // Registro na quarentena para reprocessar quando o clamd voltar.
        db.prepare(
          "INSERT INTO quarantined_uploads (id, conversation_id, user_id, storage_path, original_name, mime, size, hash, status, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)"
        ).run(id, req.params.id, req.userId, finalRel, original, mime, size, hash, now());
        // Docling NÃO roda em quarentena: o conteúdo ainda não é confiável.
      } else {
        // Pré-processa com o Docling em segundo plano (se ligado e tipo suportado);
        // não bloqueia a resposta do upload.
        kickProcessing({ userId: req.userId, conversationId: req.params.id, fileId: id, filePath: finalTarget, filename: original, mime, hash });
      }
      saved.push({ id, name: original, path: finalRel, size, inQuarantine });
    }
    // `scanned` e `scanStatus` dizem a VERDADE sobre a verificação: com o
    // antivírus fora do ar (modo degradado) a interface não pode exibir selo de
    // "arquivo verificado".
    res.json({ files: saved, scanned: scan.scanned, scanStatus: scan.status, rejected: scan.rejected });
  } finally {
    cleanupRequestUploads(req); // temporários somem mesmo em erro/abortos
  }
});

router.get('/conversations/:id/files', async (req, res) => {
  if (!await ensureConversation(req.userId, req.params.id)) return res.status(404).json({ error: 'Não encontrado' });
  const ws = workspaceFor(req.params.id, req.userId);
  const outputFiles = walk(ws.outputs).map(p => {
    if (!realInside(ws.base, p)) return null;
    const rel = path.relative(ws.base, p).replaceAll('\\', '/');
    let size = 0;
    try { size = fs.statSync(p).size; } catch { return null; } // arquivo removido no meio da varredura
    return { id: Buffer.from(rel).toString('base64url'), kind: 'output', name: path.basename(p), path: rel, size };
  }).filter(Boolean);
  const uploaded = await db.prepare('SELECT id,kind,name,path,size,created_at FROM files WHERE conversation_id=?').all(req.params.id);
  const availablePaths = new Set(validateAttachmentManifest(req.userId, req.params.id, uploaded).valid.map(file => file.path));
  res.json([
    ...uploaded.map(file => ({ ...file, available: availablePaths.has(String(file.path || '').replaceAll('\\', '/')) })),
    ...outputFiles
  ]);
});

router.delete('/conversations/:id/files/*', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const ws = workspaceFor(req.params.id, req.userId);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!insideBase(ws.base, target) || !realInside(ws.base, target)) return res.status(400).json({ error: 'Caminho inválido' });
  // Guarda o hash ANTES de apagar, para limpar os derivados do Docling depois.
  const gone = await db.prepare('SELECT hash FROM files WHERE conversation_id=? AND path=?').get(req.params.id, rel.replaceAll('\\', '/'));
  try { fs.rmSync(target, { force: true }); } catch {}
  await db.prepare('DELETE FROM files WHERE conversation_id=? AND path=?').run(req.params.id, rel.replaceAll('\\', '/'));
  // LGPD: se o usuário não tem mais nenhum arquivo com esse conteúdo, apaga os
  // artefatos derivados (JSON/Markdown/chunks/embeddings/figuras).
  if (gone?.hash) { try { await purgeIfOrphan(req.userId, gone.hash); } catch {} }
  res.json({ ok: true });
});

router.get('/conversations/:id/download/*', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).send('Arquivo não encontrado');
  const ws = workspaceFor(req.params.id, req.userId);
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
    const ws = workspaceFor(req.params.id, req.userId);
    const jsonPath = path.join(ws.base, '.export.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: conv.title, messages }), 'utf8');
    try { fs.chownSync(jsonPath, 1000, 1000); } catch {}
    const slug = (conv.title || 'conversa').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'conversa';
    const name = `conversa-${slug}.${format}`;
    const result = JSON.parse(await runTool(req.params.id, 'run_python', { code: PY_EXPORT.replace('__FMT__', format).replace('__OUT__', name) }, { userId: req.userId }));
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
    const ws = workspaceFor(req.params.id, req.userId);
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
  // "Parar" também cancela uma solicitação que AINDA aguarda na fila do modo
  // gratuito. Desde que a rota /chat passou a adquirir o controle ANTES da fila
  // (fechamento do TOCTOU do LiveStream), um job na fila TEM controle ativo —
  // então o cancelamento da fila roda nos dois casos, não só no "sem controle".
  if (action === 'stop') {
    const cancelledInQueue = cancelFreeJob(req.params.id);
    if (!control && cancelledInQueue) return res.json({ ok: true, action, cancelled: true });
  }
  if (!control) {
    return res.status(409).json({ error: 'Não há processamento ativo nesta conversa.' });
  }
  res.json({ ok: true, action, paused: control.paused, stopped: control.stopped });
});

// ---- Ações do GitHub por BOTÃO (modo desenvolvedor) -------------------------
// Disparam github_clone/github_push DIRETO no backend, com o token do usuário,
// SEM passar pela IA nem depender do modo/frase — determinístico e sem gastar
// tokens. Reaproveitam runGithubTool (o mesmo motor das ferramentas github_*),
// escopado à conversa do usuário (posse checada). Resolve o caso em que o commit
// já está pronto no workspace e só falta o push: 1 clique e sobe.
async function conversationGithubAction(req, res, tool) {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const repo = String(req.body?.repo || '').trim();
  if (!repo) return res.status(400).json({ error: 'Nenhum repositório vinculado a esta conversa.' });
  // ESCOPO DA AUTORIZAÇÃO (auditoria DW3): o clique é a autorização, mas o
  // ALVO precisa ser o repositório realmente vinculado ao projeto desta
  // conversa. Sem esta checagem, uma request autenticada podia empurrar
  // qualquer repo/branch do token — fora do escopo que o resto do sistema
  // (githubAccess.js) impõe ao agente. Falha fechada: sem vínculo no servidor,
  // a escrita por botão é recusada (o clone continua exigindo só a posse, pois
  // é leitura com o token do próprio usuário).
  if (tool === 'github_push') {
    const projectId = await projectIdForConversation(req.userId, req.params.id);
    const project = projectId ? await getProject(req.userId, projectId) : null;
    const binding = project?.binding || null;
    if (!binding || binding.type !== 'github' || !binding.repo) {
      return res.status(403).json({ error: 'Esta conversa não tem um repositório GitHub vinculado no servidor. Abra o Modo Desenvolvedor, vincule o repositório ao projeto e tente de novo.' });
    }
    if (binding.repo !== repo) {
      return res.status(403).json({ error: `O repositório informado (${repo}) não é o vinculado a este projeto (${binding.repo}).` });
    }
    if (binding.branch && req.body?.branch && String(req.body.branch) !== binding.branch) {
      return res.status(403).json({ error: `A branch informada (${req.body.branch}) não é a vinculada a este projeto (${binding.branch}).` });
    }
  }
  const args = { repo };
  if (req.body?.branch) args.branch = String(req.body.branch);
  if (tool === 'github_push' && req.body?.commit_message) args.commit_message = String(req.body.commit_message);
  const result = await runGithubTool(tool, args, { userId: req.userId, conversationId: req.params.id });
  if (result?.error) {
    // Sinaliza ao front quando o push só precisa de uma mensagem de commit (há
    // mudanças não commitadas) — aí ele pede o texto e repete.
    const needsCommitMessage = /commit_message|não commitadas/i.test(result.error);
    return res.status(result.recoverable === false ? 422 : 400).json({ ...result, needsCommitMessage });
  }
  res.json(result);
}
router.post('/conversations/:id/github/clone', async (req, res) => conversationGithubAction(req, res, 'github_clone'));
router.post('/conversations/:id/github/push', async (req, res) => conversationGithubAction(req, res, 'github_push'));

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
  // Filtro da reconexão: o cliente envia o último `_seq` que recebeu e o
  // `_runId` do run em que estava. Combinados, eles garantem que:
  //   - se o MESMO run continua rodando, ele recebe só o que perdeu (fromSeq);
  //   - se um run NOVO começou (o servidor iniciou outra execução na mesma
  //     conversa), ele recebe o run novo inteiro — sem isto, o fromSeq do run
  //     ANTIGO pularia os primeiros eventos do novo e a remontagem quebraria.
  const fromSeq = Number.parseInt(req.query.fromSeq, 10) || 0;
  const fromRunId = req.query.runId ? String(req.query.runId) : null;
  const unsubscribe = live.subscribe(
    (rec) => write({ ...rec.event, _seq: rec.seq, _runId: rec.runId || null }),
    { fromSeq, runId: fromRunId }
  );
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
  // O frontend envia o manifesto que estava visível no compositor. Conferimos
  // os mesmos caminhos ANTES de abrir o stream/modelo: se o upload ainda está
  // terminando ou o arquivo sumiu do disco, não deixamos a IA concluir
  // falsamente que "não recebeu anexo".
  const attachmentCheck = validateAttachmentManifest(req.userId, req.params.id, req.body?.attachments || []);
  if (attachmentCheck.missing.length) {
    return res.status(409).json({
      error: 'Um ou mais anexos ainda não estão disponíveis nesta conversa. Aguarde o envio terminar ou remova o anexo indisponível e envie-o novamente.',
      code: 'attachments_not_ready',
      missing: attachmentCheck.missing.map(file => file.name || file.path)
    });
  }
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
  // FECHAMENTO DO TOCTOU: o controle da conversa é adquirido AQUI, de forma
  // síncrona, ANTES de abrir o LiveStream. Sem isto, um segundo POST /chat
  // concorrente passava pelo isConversationActive (checado lá em cima, com
  // vários awaits no meio) e SUBSTITUÍA o LiveStream do run ativo — o run
  // legítimo seguia publicando num objeto fora do Map e a reconexão via um
  // stream vazio. A aquisição é atômica (event loop único) e o controle é
  // repassado ao runner, que não tenta adquirir de novo.
  let control;
  try { control = acquireConversationControl(req.params.id, req.userId); }
  catch {
    return res.status(409).json({ error: 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de enviar outra mensagem.' });
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
  // O runId é gerado AQUI (e passado ao runAgent) para carimbar todos os eventos
  // do run com o mesmo identificador — sem ele, a reconexão não consegue
  // distinguir "ainda estou vendo o mesmo run" de "um run novo começou".
  const runId = nanoid();
  const live = openLiveStream(req.params.id, runId);
  // RUN DURÁVEL (ADR 0002): a rota é o único ponto por onde TODOS os eventos
  // passam — o gravador persiste os estruturais (tool_start/result, run_state,
  // input_required, plan_update, files) para a execução ser reconstruível
  // depois de reload ou restart. Nunca bloqueia nem derruba o stream.
  const runKind = req.body?.multiModel ? 'multimodelo' : (req.body?.orchestrate ? 'orquestrador' : 'chat');
  const runLog = createRunLog({ runId, conversationId: req.params.id, userId: req.userId, kind: runKind });
  const send = (event) => {
    const rec = live.publish(event);
    runLog.record(event);
    if (clientGone || res.writableEnded) return;
    // `_seq`/`_runId` também no stream primário: o cliente do POST /chat passa a
    // ter cursor exato para reconectar sem replay integral nem duplicação.
    try { res.write(`data: ${JSON.stringify({ ...event, _seq: rec.seq, _runId: rec.runId || null })}\n\n`); }
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
  // Estado final do run para o registro durável (o run_state terminal do
  // runAgent tem precedência — ver runLog.finish).
  const runOutcome = { state: null, detail: null, messageId: null };
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
        onEvent: send,
        control
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
        onEvent: send,
        control
      });
    } else {
      const assistant = await loadAssistant(req.userId, req.body?.assistantId);
      result = await runAgent({ userId: req.userId, conversationId: req.params.id, userText: text, model: req.body?.model, assistant, webSearch: !!req.body?.webSearch, effort: req.body?.effort, developer: req.body?.developer, onEvent: send, runIdOverride: runId, control });
    }
    runOutcome.messageId = result?.messageId || null;
    const chatOutcome = classifyTaskResult(result);
    if (chatOutcome.status === 'error') {
      send({ type: 'execution_failed', content: chatOutcome.error });
      runOutcome.state = 'fatal_error';
      runOutcome.detail = String(chatOutcome.error || '').slice(0, 500);
    }
    // Registra o consumo de tokens para o painel de análises
    if (result?.usage) {
      await recordUsage({
        userId: req.userId,
        conversationId: req.params.id,
        assistantId: usageAssistantId,
        model: result.model,
        kind,
        feature: 'chat',
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
      });
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
      runOutcome.state = 'stopped';
      runOutcome.detail = 'Cancelado na fila do modo gratuito.';
    } else if (err?.code === 'FREE_QUEUE_FULL') {
      logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'limited', detail: 'fila cheia' });
      send({ type: 'error', content: 'O modo gratuito está com muitas solicitações agora. Aguarde alguns minutos e tente de novo — ou adicione a sua própria chave de API em Configurações para não depender da fila.' });
      runOutcome.state = 'fatal_error';
      runOutcome.detail = 'Fila do modo gratuito cheia.';
    } else {
      console.error('[chat]', err);
      if (freeMode) logFreeTierEvent({ userId: req.userId, model: provider.model, status: 'error', detail: String(err?.message || err).slice(0, 300) });
      send({ type: 'error', content: friendlyApiError(err) });
      runOutcome.state = 'fatal_error';
      runOutcome.detail = String(err?.message || err).slice(0, 500);
    }
  } finally {
    releaseFreeSlot?.();
    clearInterval(heartbeat);
    // O controle foi adquirido pela ROTA (fechamento do TOCTOU) — o release é
    // idempotente por identidade, então liberar aqui e no runner é seguro.
    releaseConversationControl(req.params.id, control);
    // Fecha o registro durável do run (não bloqueia o encerramento da resposta).
    runLog.finish(runOutcome);
    // Encerra o run no registro ao vivo: mantém o buffer por uma janela de
    // carência para quem reconectar no último segundo, depois se apaga sozinho.
    live.finish();
    res.end();
  }
});

// RUNS DA CONVERSA (Developer Workspace 3.0): devolve as execuções persistidas
// com etapas e plano reconstruídos do event log durável. É o que permite ao
// frontend remontar o terminal e a atividade depois de um reload — inclusive de
// execuções antigas, que antes evaporavam com o buffer em memória.
router.get('/conversations/:id/runs', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ runs: await listConversationRuns(req.userId, req.params.id) });
});

// CHANGESET REAL (Fases 26–27): a verdade do git sobre o(s) clone(s) desta
// conversa — status + numstat lidos pelo backend, sem token e sem sandbox.
// Sem repositório git, devolve lista vazia e a UI mantém o fallback heurístico.
router.get('/conversations/:id/changes', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  res.json(await collectConversationChanges(req.userId, req.params.id));
});

// DIFF de UM arquivo, em hunks (Fase 27). Leitura local, sem token.
router.get('/conversations/:id/diff', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const result = await fileDiff(req.userId, req.params.id, {
    repo: String(req.query.repo || ''),
    file: String(req.query.file || '')
  });
  if (result?.error) return res.status(400).json(result);
  res.json(result);
});

// REVERTER um arquivo inteiro ou UM hunk. Operação destrutiva sobre trabalho
// não commitado: o clique do usuário é a autorização (como no botão de push),
// e o backend confina o alvo ao clone desta conversa. Um hunk é revertido com
// `git apply --reverse` — se o arquivo mudou desde a leitura do diff, o git
// recusa e nada é aplicado.
router.post('/conversations/:id/revert', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  if (isConversationActive(req.params.id)) {
    return res.status(409).json({ error: 'A tarefa ainda está em execução. Pare o processamento antes de reverter alterações — reverter agora pode conflitar com o que a IA está escrevendo.' });
  }
  const hunkIndex = req.body?.hunkIndex;
  const result = await revertChange(req.userId, req.params.id, {
    repo: String(req.body?.repo || ''),
    file: String(req.body?.file || ''),
    hunkIndex: Number.isInteger(hunkIndex) ? hunkIndex : null
  });
  if (result?.error) return res.status(400).json(result);
  res.json(result);
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
  // Coordenador durável (F-15): pipeline run ativo tem precedência sobre
  // checkpoint de agente único. Se o pipeline foi interrompido entre etapas,
  // retoma do currentStage em vez de cair no erro "não há execução salva".
  const activePipeline = await loadPipelineRun(conversationId);
  if (activePipeline) {
    // Reconstrói a execução multimodelo com o config salvo e a última mensagem
    // de usuário da conversa (o pipeline run guarda o config, não o userText).
    const lastUser = await db.prepare("SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC, seq DESC LIMIT 1").get(conversationId);
    const userText = lastUser?.content || '';
    // Mesmo fechamento de TOCTOU do /chat: controle antes do LiveStream.
    let control;
    try { control = acquireConversationControl(conversationId, req.userId); }
    catch { return res.status(409).json({ error: 'Esta conversa já está processando. Aguarde terminar antes de continuar.' }); }
    // ...rota SSE e execução iguais ao /chat (a stream é a mesma)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let clientGone = false;
    const runId = `resume_${nanoid(8)}`;
    const live = openLiveStream(conversationId, runId);
    const runLog = createRunLog({ runId, conversationId, userId: req.userId, kind: 'multimodelo' });
    const runOutcome = { state: null, detail: null, messageId: null };
    const send = (event) => {
      const rec = live.publish(event);
      runLog.record(event);
      if (clientGone || res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify({ ...event, _seq: rec.seq, _runId: rec.runId || null })}\n\n`); }
      catch { clientGone = true; }
    };
    const heartbeat = setInterval(() => { if (!clientGone && !res.writableEnded) { try { res.write(': ping\n\n'); } catch { clientGone = true; } } }, 15000);
    const cancelOnDisconnect = String(process.env.CANCEL_ON_DISCONNECT || '').toLowerCase() === 'true';
    res.on('close', () => { clientGone = true; clearInterval(heartbeat); if (cancelOnDisconnect && !res.writableEnded) setControl(conversationId, 'stop'); });
    try {
      // Modo gratuito e limites iguais ao /chat
      const pResume = await getUserProvider(req.userId);
      if (pResume.source === 'free') {
        const denial = await enforceFreeTierLimits(req.userId);
        if (denial) {
          logFreeTierEvent({ userId: req.userId, model: pResume.model, status: denial.code === 'free_blocked' ? 'blocked' : 'limited', detail: denial.code });
          const st = denial.code === 'free_blocked' ? 403 : 429;
          send({ type: 'error', content: denial.error });
          send({ type: 'done' });
          return res.status(st).end();
        }
      }
      const config = activePipeline.config || {};
      if (!config.models || !Array.isArray(config.models) || config.models.length < 2) {
        send({ type: 'error', content: 'A configuração do pipeline salva está incompleta. Envie a mensagem novamente.' });
        send({ type: 'done' });
        return res.end();
      }
      const result = await runMultiModel({
        userId: req.userId,
        conversationId,
        userText,
        config,
        pipelineResume: activePipeline,
        saveUserMessage: false,
        onEvent: send,
        control
      });
      runOutcome.messageId = result?.messageId || null;
      if (result?.usage) {
        await recordUsage({
          userId: req.userId,
          conversationId,
          assistantId: null,
          model: result.model,
          kind: 'multimodelo',
          feature: 'multimodel',
          promptTokens: result.usage.prompt_tokens,
          completionTokens: result.usage.completion_tokens,
        });
      }
      send({ type: 'done' });
    } catch (err) {
      console.error('[resume/pipeline]', err);
      send({ type: 'error', content: friendlyApiError(err) });
      runOutcome.state = 'fatal_error';
      runOutcome.detail = String(err?.message || err).slice(0, 500);
    } finally {
      clearInterval(heartbeat);
      releaseConversationControl(conversationId, control);
      runLog.finish(runOutcome);
      live.finish();
      res.end();
    }
    return; // pipeline resume tratado — não cai no caminho de runAgent abaixo
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
  // Mesmo fechamento de TOCTOU do /chat: controle antes do LiveStream.
  let control;
  try { control = acquireConversationControl(conversationId, req.userId); }
  catch { return res.status(409).json({ error: 'Esta conversa já está processando. Aguarde terminar antes de continuar.' }); }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let clientGone = false;
  // runId: a retomada continua O run interrompido (checkpoint.runId) — não
  // geramos um novo. Sem isto, o cliente que reconectou com fromSeq do run
  // antigo acharia que estamos num run novo e pediria replay do começo.
  const resumeRunId = checkpoint.runId || nanoid();
  const live = openLiveStream(conversationId, resumeRunId);
  // O run durável é o MESMO do run interrompido: o gravador continua a
  // sequência de eventos e reabre o ended_at (ver createRunLog).
  const runLog = createRunLog({ runId: resumeRunId, conversationId, userId: req.userId, kind: 'chat' });
  const runOutcome = { state: null, detail: null, messageId: null };
  const send = (event) => {
    const rec = live.publish(event);
    runLog.record(event);
    if (clientGone || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify({ ...event, _seq: rec.seq, _runId: rec.runId || null })}\n\n`); }
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
      onEvent: send,
      control,
      // runIdOverride: usar o mesmo do checkpoint (e do live stream) para que a
      // reconexão ao /stream saiba que ESTE run é continuação do anterior.
      runIdOverride: resumeRunId
    });
    runOutcome.messageId = result?.messageId || null;
    const chatOutcome = classifyTaskResult(result);
    if (chatOutcome.status === 'error') {
      send({ type: 'execution_failed', content: chatOutcome.error });
      runOutcome.state = 'fatal_error';
      runOutcome.detail = String(chatOutcome.error || '').slice(0, 500);
    }
    if (result?.usage) {
      await recordUsage({
        userId: req.userId,
        conversationId,
        assistantId: meta.assistantId || null,
        model: result.model,
        kind: 'chat',
        feature: 'chat',
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
      });
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
      runOutcome.state = 'fatal_error';
      runOutcome.detail = String(err?.message || err).slice(0, 500);
    }
  } finally {
    releaseFreeSlot?.();
    clearInterval(heartbeat);
    releaseConversationControl(conversationId, control);
    runLog.finish(runOutcome);
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
