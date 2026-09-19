#!/usr/bin/env node
// Aplica correções de review SSE/cancel/_seq no useChat.js (MCP payload ~43 KB).
//   node frontend/scripts/apply-usechat-sse-fixes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'frontend/src/hooks/useChat.js');
let chat = fs.readFileSync(target, 'utf8');
if (chat.includes('abortControllersRef')) {
  console.log('Nada a fazer — useChat já tem AbortController/cancel.');
  process.exit(0);
}

const steps = [];
function rep(old, neu, label) {
  if (!chat.includes(old)) throw new Error('âncora ausente: ' + label);
  chat = chat.replace(old, neu);
  steps.push(label);
}

rep(
`  const patchRun = (convId, patch) => {
    if (!convId) return;
    const next = { ...runsRef.current, [convId]: { ...(runsRef.current[convId] || {}), ...patch } };
    runsRef.current = next;
    setRuns(next);
  };
  const endRun = (convId) => {
    if (!convId || !(convId in runsRef.current)) return;
    const next = { ...runsRef.current };
    delete next[convId];
    runsRef.current = next;
    setRuns(next);
  };
`,
`  const patchRun = (convId, patch) => {
    if (!convId) return;
    const next = { ...runsRef.current, [convId]: { ...(runsRef.current[convId] || {}), ...patch } };
    runsRef.current = next;
    setRuns(next);
  };
  // WHY: Parar tem de abortar o fetch/SSE local além do POST /control —
  // senão o reader continua aplicando deltas até o backend fechar o socket.
  const abortControllersRef = useRef({}); // { [convId]: AbortController }
  const abortConversationFetch = (convId) => {
    const ac = abortControllersRef.current[convId];
    if (!ac) return;
    try { ac.abort(); } catch {}
    delete abortControllersRef.current[convId];
  };
  const beginConversationFetch = (convId) => {
    abortConversationFetch(convId);
    const ac = new AbortController();
    abortControllersRef.current[convId] = ac;
    return ac;
  };
  const endRun = (convId) => {
    if (!convId || !(convId in runsRef.current)) return;
    abortConversationFetch(convId);
    const next = { ...runsRef.current };
    delete next[convId];
    runsRef.current = next;
    setRuns(next);
  };
`, 'abort helpers');

rep(
`    try {
      const response = await fetch(\`\${API}/api/conversations/\${conversationId}/control\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
`,
`    // WHY: stop invalida a época e aborta o SSE local na hora; o POST /control
    // pede ao backend para interromper o run (fonte de verdade).
    if (action === 'stop') {
      newStreamEpoch(conversationId);
      abortConversationFetch(conversationId);
    }
    try {
      const response = await fetch(\`\${API}/api/conversations/\${conversationId}/control\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
`, 'control stop');

rep(
`        if (ev._seq != null) {
          const prev = liveCursorRef.current[convId] || { runId: null, seq: 0 };
          liveCursorRef.current[convId] = {
            runId: ev._runId || prev.runId,
            seq: Number(ev._seq) || prev.seq
          };
        }
`,
`        // WHY: \`_seq\` pode ser 0 — \`||\` descartaria o zero e atrasaria o fromSeq
        // na reconexão (replay duplicado do primeiro evento).
        if (ev._seq != null) {
          const prev = liveCursorRef.current[convId] || { runId: null, seq: 0 };
          const nextSeq = Number(ev._seq);
          liveCursorRef.current[convId] = {
            runId: ev._runId || prev.runId,
            seq: Number.isFinite(nextSeq) ? nextSeq : prev.seq
          };
        }
`, '_seq');

rep(
`      const params = new URLSearchParams();
      if (cursor?.runId) params.set('runId', cursor.runId);
      if (cursor?.seq) params.set('fromSeq', String(cursor.seq));
`,
`      const params = new URLSearchParams();
      if (cursor?.runId) params.set('runId', cursor.runId);
      // WHY: seq 0 é válido; checar truthy omitia fromSeq e forçava replay.
      if (cursor && cursor.seq != null) params.set('fromSeq', String(cursor.seq));
`, 'fromSeq');

rep(
`      res = await fetch(\`\${API}/api/conversations/\${convId}/stream\${qs ? \`?\${qs}\` : ''}\`);
`,
`      const ac = beginConversationFetch(convId);
      res = await fetch(\`\${API}/api/conversations/\${convId}/stream\${qs ? \`?\${qs}\` : ''}\`, { signal: ac.signal });
`, 'stream signal');

rep(
`    const activeDeveloper = developerSession && (!developerSession.conversationId || developerSession.conversationId === conv.id) ? developerSession : null;
`,
`    // WHY: developer.mode/permissions só desta conversa — nunca vazar a sessão
    // Dev de A para o POST /chat de B (isolamento multimodelo/conversa).
    const activeDeveloper = developerSession && (!developerSession.conversationId || developerSession.conversationId === conv.id) ? developerSession : null;
`, 'developer');

rep(
`      const res = await fetch(\`\${API}/api/conversations/\${conv.id}/chat\`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
`,
`      const ac = beginConversationFetch(conv.id);
      const res = await fetch(\`\${API}/api/conversations/\${conv.id}/chat\`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal
      });
`, 'chat signal');

rep(
`    } catch (err) {
      // A conexão SSE caiu (trocar de aba / minimizar no celular / rede
      // oscilando). A tarefa CONTINUA rodando no servidor.
      if (currentRef.current?.id !== conv.id) {
`,
`    } catch (err) {
      // WHY: abort local (Parar) NÃO é queda de rede — não religar o stream.
      if (err?.name === 'AbortError') {
        endRun(conv.id);
        return;
      }
      // A conexão SSE caiu (trocar de aba / minimizar no celular / rede
      // oscilando). A tarefa CONTINUA rodando no servidor.
      if (currentRef.current?.id !== conv.id) {
`, 'send AbortError');

rep(
`      const res = await fetch(\`\${API}/api/conversations/\${id}/resume\`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
`,
`      const ac = beginConversationFetch(id);
      const res = await fetch(\`\${API}/api/conversations/\${id}/resume\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal });
`, 'resume signal');

rep(
`    } catch {
      // Conexão caiu: a tarefa CONTINUA no servidor. Reconecta ao vivo (ou, se
      // o usuário está noutra conversa, um vigia limpa o indicador ao terminar).
      if (currentRef.current?.id !== id) { watchDetachedRun(id); return; }
`,
`    } catch (err) {
      // WHY: abort local (Parar) NÃO é queda de rede — não religar o stream.
      if (err?.name === 'AbortError') { endRun(id); return; }
      // Conexão caiu: a tarefa CONTINUA no servidor. Reconecta ao vivo (ou, se
      // o usuário está noutra conversa, um vigia limpa o indicador ao terminar).
      if (currentRef.current?.id !== id) { watchDetachedRun(id); return; }
`, 'resume AbortError');

fs.writeFileSync(target, chat);
console.log('OK:', steps.join(', '));
