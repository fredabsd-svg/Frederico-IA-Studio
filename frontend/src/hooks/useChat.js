import { useEffect, useRef, useState } from 'react';
import { API } from '../constants.js';
import { takeSseEvents } from '../sse.js';

const toolResultFailed = content => {
  try {
    const result = JSON.parse(content);
    return Boolean(result?.error) || (typeof result?.exitCode === 'number' && result.exitCode !== 0);
  } catch {
    return false;
  }
};

// Envio de mensagem (SSE), controle pausar/continuar/parar e reenvio.
// Recebe as dependências do App por parâmetro e devolve { estado, ações }.
export function useChat({ input, setInput, messages, setMessages, uploads, team, effectiveTeam,
                          listening, recognitionRef, current, currentRef, setCurrent,
                          ensureConversation, fetchConversations, loadFiles,
                          developerSession, setDeveloperSession,
                          model, assistantId, webSearch, effort, setNeedLogin, showToast }) {
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [controlPending, setControlPending] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [nowTick, setNowTick] = useState(0);
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  function setChatBusy(next) {
    busyRef.current = next;
    setBusy(next);
  }
  // Enquanto processa, "bate um relógio" a cada segundo para os contadores vivos
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // ---- Controle: pausar / continuar / parar ----
  async function control(action) {
    if (!current || !busyRef.current || controlPending) return;
    const conversationId = current.id;
    setControlPending(true);
    if (action === 'pause') setStatusText('Pausando...');
    if (action === 'resume') setStatusText('Retomando...');
    if (action === 'stop') setStatusText('Interrompendo...');
    try {
      const response = await fetch(`${API}/api/conversations/${conversationId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Não foi possível controlar o processamento.');
      if (action === 'pause') setPaused(Boolean(result.paused));
      if (action === 'resume' || action === 'stop') setPaused(false);
    } catch (err) {
      setStatusText('');
      showToast(err?.message || 'Não foi possível controlar o processamento.');
    } finally {
      setControlPending(false);
    }
  }

  // Reenvia uma mensagem que falhou: remove o balão de erro (e o balão do
  // usuário) e dispara o envio de novo com o mesmo texto.
  async function retrySend(idx, text) {
    if (busy || !text) return;
    const userMessage = messages[idx - 1];
    const savedUserMessage = userMessage?.role === 'user'
      && userMessage.id
      && !String(userMessage.id).startsWith('local-');
    if (savedUserMessage && current?.id) {
      try {
        const res = await fetch(`${API}/api/conversations/${current.id}/truncate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: userMessage.id })
        });
        if (!res.ok) throw new Error();
      } catch {
        showToast('Não foi possível preparar a nova tentativa. A conversa foi preservada.');
        return;
      }
    }
    setMessages(prev => prev.slice(0, Math.max(0, idx - 1)));
    await loadFiles();
    await sendMessage(text);
  }

  // Recuperação após queda de conexão: a tarefa CONTINUA no servidor e o
  // resultado é salvo, então buscamos a resposta pronta recarregando a conversa
  // (em vez de mostrar "Conexão interrompida"). Roda em segundo plano; quando o
  // último item da conversa for a resposta do assistente já salva, exibe-a.
  async function recoverPendingReply(convId) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4000)); // verifica a cada 4s (até ~4 min)
      if (currentRef.current?.id !== convId) return; // usuário saiu desta conversa
      try {
        const res = await fetch(`${API}/api/conversations/${convId}`);
        if (!res.ok) continue;
        const data = await res.json();
        const msgs = data.messages || [];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant' && String(last.content || '').trim()) {
          if (currentRef.current?.id === convId) { setMessages(msgs); loadFiles(convId); }
          return;
        }
      } catch {}
    }
  }

  async function sendMessage(textArg) {
    const isRetry = typeof textArg === 'string';
    const typed = (isRetry ? textArg : input).trim();
    // "Zero atrito": se o usuário anexou algo (ex.: uma foto) e não escreveu
    // nada, usamos um pedido padrão para a IA ler/analisar o anexo sozinha.
    const text = typed || (!isRetry && uploads.length > 0
      ? 'Leia e analise o(s) arquivo(s)/foto que enviei e me responda com base no conteúdo.'
      : '');
    if (!text || busyRef.current) return;
    if (team && effectiveTeam.length === 0) { showToast('Selecione ao menos 1 assistente no painel da Equipe.'); return; }
    if (listening) recognitionRef.current?.stop();
    setChatBusy(true);
    let conv = current;
    if (!conv) { conv = await ensureConversation(); if (!conv) { setChatBusy(false); return; } }
    if (!isRetry) setInput('');
    const activeDeveloper = developerSession && (!developerSession.conversationId || developerSession.conversationId === conv.id) ? developerSession : null;
    if (activeDeveloper && !activeDeveloper.conversationId) setDeveloperSession({ ...activeDeveloper, conversationId: conv.id });
    setPaused(false);
    setStatusText('Pensando...');
    const assistantMsgId = `local-${Date.now()}`;
    // created_at aqui e' o horario local do envio; ao recarregar, o valor do
    // servidor (server.js) substitui. Sem isto, a mensagem recem-enviada nao
    // tem hora e o separador de data nao consegue agrupa-la.
    const sentAt = new Date().toISOString();
    setMessages(prev => [...prev, { role: 'user', content: text, created_at: sentAt }, { id: assistantMsgId, role: 'assistant', content: '', blocks: [], created_at: sentAt }]);
    let assistantMessageKey = assistantMsgId;
    const update = (fn) => {
      const key = assistantMessageKey;
      setMessages(prev => prev.map(m => m.id === key ? fn(m) : m));
    };

    const body = {
      message: text,
      model,
      assistantId,
      webSearch,
      effort,
      ...(team ? { orchestrate: true, orchestrateIds: effectiveTeam.map(a => a.id) } : {}),
      ...(activeDeveloper ? { developer: { mode: activeDeveloper.mode, projectId: activeDeveloper.projectId, github: activeDeveloper.github || null, rules: activeDeveloper.rules } } : {})
    };
    try {
      const res = await fetch(`${API}/api/conversations/${conv.id}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (res.status === 401) { setChatBusy(false); setStatusText(''); setNeedLogin(true); return; }
      if (!res.ok) {
        let msg = `O servidor respondeu com erro (${res.status}).`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
        update(m => ({ ...m, failed: true, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${msg}` }] }));
        showToast(msg);
        setChatBusy(false); setPaused(false); setStatusText('');
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('A resposta do servidor não pôde ser lida.');
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (done) buffer += decoder.decode();
        const parsed = takeSseEvents(buffer, { flush: done });
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.type === 'status') setStatusText(ev.content || '');
          if (ev.type === 'memory_context') update(m => ({ ...m, memory: ev.memory }));
          if (ev.type === 'delta') update(m => {
            const blocks = [...(m.blocks || [])];
            const last = blocks[blocks.length - 1];
            if (last && last.type === 'text') blocks[blocks.length - 1] = { ...last, content: last.content + ev.content };
            else blocks.push({ type: 'text', content: ev.content });
            return { ...m, blocks, content: (m.content || '') + ev.content };
          });
          if (ev.type === 'tool_start') { setStatusText(`Executando ${ev.name}...`); update(m => ({ ...m, blocks: [...(m.blocks || []), { type: 'tool', name: ev.name, preview: ev.preview, status: 'running', started: Date.now() }] })); }
          if (ev.type === 'tool_result') update(m => {
            const blocks = [...(m.blocks || [])];
            const status = toolResultFailed(ev.content) ? 'error' : 'done';
            for (let i = blocks.length - 1; i >= 0; i--) { if (blocks[i].type === 'tool' && blocks[i].status === 'running') { blocks[i] = { ...blocks[i], status, ended: Date.now(), result: ev.content }; break; } }
            return { ...m, blocks };
          });
          if (ev.type === 'files') update(m => ({ ...m, files: [...(m.files || []), ...ev.files] }));
          if (ev.type === 'file_checks') update(m => ({
            ...m,
            files: (m.files || []).map(file => ev.checks?.[file.path] ? { ...file, check: ev.checks[file.path] } : file)
          }));
          if (ev.type === 'saved') {
            const previousKey = assistantMessageKey;
            assistantMessageKey = ev.assistantMessageId;
            setMessages(prev => {
              const arr = [...prev];
              const ai = arr.findIndex(m => m.id === previousKey);
              if (ai > -1) { arr[ai] = { ...arr[ai], id: ev.assistantMessageId }; if (arr[ai - 1]?.role === 'user') arr[ai - 1] = { ...arr[ai - 1], id: ev.userMessageId }; }
              return arr;
            });
          }
          if (ev.type === 'execution_failed') {
            update(m => ({ ...m, failed: true, retryText: text }));
            if (ev.content) showToast(ev.content);
          }
          if (ev.type === 'error') update(m => ({ ...m, failed: true, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${ev.content}` }] }));
        }
        if (done) break;
      }
    } catch (err) {
      // A conexão SSE caiu (trocar de aba / minimizar no celular / rede
      // oscilando). A tarefa CONTINUA rodando no servidor e salva o resultado —
      // então, em vez de marcar como falha, deixamos um aviso calmo e buscamos
      // a resposta pronta em segundo plano (aparece aqui quando terminar).
      update(m => ({ ...m, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: '\n\n_A conexão caiu, mas a tarefa continua rodando no servidor. O resultado aparece aqui assim que terminar — se preferir, é só recarregar a conversa._' }] }));
      recoverPendingReply(conv.id);
    }
    // Fecha qualquer ferramenta que tenha ficado "rodando"
    update(m => ({ ...m, blocks: (m.blocks || []).map(b => b.type === 'tool' && b.status === 'running' ? { ...b, status: 'done', ended: Date.now() } : b) }));
    setChatBusy(false);
    setPaused(false);
    setStatusText('');
    await loadFiles(conv.id);
    try {
      const rows = await fetchConversations();
      const updated = rows.find(c => c.id === conv.id);
      if (updated) setCurrent(updated);
    } catch {}
  }

  return { busy, busyRef, paused, statusText, controlPending, nowTick, sendMessage, retrySend, control };
}
