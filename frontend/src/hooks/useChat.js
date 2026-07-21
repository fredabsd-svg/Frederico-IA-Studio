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
// Aplica um patch num cartão (slot) da execução multimodelo da mensagem.
const mmPatch = (m, slot, fn) => {
  if (!m.multi?.models) return m;
  return { ...m, multi: { ...m.multi, models: m.multi.models.map(s => s.slot === slot ? fn(s) : s) } };
};

export function useChat({ input, setInput, messages, setMessages, uploads, team, effectiveTeam,
                          listening, recognitionRef, current, currentRef, setCurrent,
                          ensureConversation, fetchConversations, loadFiles,
                          developerSession, setDeveloperSession, followActiveRef,
                          model, assistantId, webSearch, effort, multiModel, setNeedLogin, showToast }) {
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

  // Consome um stream SSE de chat (POST /chat ou reconexão GET /stream) e vai
  // atualizando a mensagem do assistente apontada por keyRef.key. É a MESMA
  // lógica para o envio normal e para a reconexão — assim, ao voltar à página,
  // o andamento é remontado exatamente como apareceria ao vivo.
  // Retorna { sawDone, sawError } para o chamador decidir se o run acabou.
  async function consumeChatStream(reader, keyRef, text) {
    const update = (fn) => {
      const key = keyRef.key;
      setMessages(prev => prev.map(m => m.id === key ? fn(m) : m));
    };
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false, sawError = false;
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
        // ---- Execução multimodelo: estado ao vivo de cada modelo ----
        if (ev.type === 'mm_start') update(m => ({ ...m, multi: { mode: ev.mode, live: true, models: (ev.models || []).map(s => ({ ...s, status: 'aguardando', text: '' })) } }));
        if (ev.type === 'mm_status') update(m => mmPatch(m, ev.slot, s => ({ ...s, status: ev.status })));
        if (ev.type === 'mm_delta') update(m => mmPatch(m, ev.slot, s => ({ ...s, text: (s.text || '') + ev.content })));
        if (ev.type === 'mm_reset') update(m => mmPatch(m, ev.slot, s => ({ ...s, text: '' })));
        if (ev.type === 'mm_round') update(m => m.multi ? { ...m, multi: { ...m.multi, round: ev.round, rounds: ev.total } } : m);
        if (ev.type === 'mm_done') update(m => ({ ...m, multi: ev.meta }));
        if (ev.type === 'files') update(m => ({ ...m, files: [...(m.files || []), ...ev.files] }));
        if (ev.type === 'file_checks') update(m => ({
          ...m,
          files: (m.files || []).map(file => ev.checks?.[file.path] ? { ...file, check: ev.checks[file.path] } : file)
        }));
        if (ev.type === 'saved') {
          const previousKey = keyRef.key;
          keyRef.key = ev.assistantMessageId;
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
        if (ev.type === 'error') { sawError = true; update(m => ({ ...m, failed: true, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${ev.content}` }] })); }
        if (ev.type === 'done') sawDone = true;
      }
      if (done) break;
    }
    return { sawDone, sawError };
  }

  // Reconecta a um processamento que continua rodando no servidor (usuário
  // voltou à página, minimizou, ou a rede oscilou). Reproduz o run inteiro do
  // zero sobre a mensagem-alvo — por isso zeramos o conteúdo antes, para nunca
  // duplicar texto já aplicado. `ref` é mutável: se ainda não aponta para um
  // balão, cria/reaproveita um (e escreve ref.key) para receber o andamento.
  async function reconnectLiveRun(convId, ref, text = '') {
    if (!ref.key) {
      const placeholderId = `live-${Date.now()}`;
      let reused = false;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        // Se a última já for um balão de assistente ainda em aberto, reusa.
        if (last && last.role === 'assistant' && !String(last.content || '').trim() && (last.blocks || []).length === 0) {
          ref.key = last.id; reused = true;
          return prev;
        }
        return [...prev, { id: placeholderId, role: 'assistant', content: '', blocks: [], created_at: new Date().toISOString() }];
      });
      if (!reused) ref.key = placeholderId;
    }
    setChatBusy(true);
    setPaused(false);
    setStatusText('Retomando...');
    // Remonta do zero: zera o balão-alvo antes do replay para evitar texto dobrado.
    setMessages(prev => prev.map(m => m.id === ref.key ? { ...m, content: '', blocks: [] } : m));
    let res;
    try {
      res = await fetch(`${API}/api/conversations/${convId}/stream`);
    } catch {
      return { attached: false, sawDone: false };
    }
    if (res.status === 204) return { attached: false, sawDone: false }; // nada rodando
    if (!res.ok) return { attached: false, sawDone: false };
    const reader = res.body?.getReader();
    if (!reader) return { attached: false, sawDone: false };
    try {
      const { sawDone } = await consumeChatStream(reader, ref, text);
      return { attached: true, sawDone };
    } catch {
      return { attached: true, sawDone: false };
    }
  }

  // Ao voltar a uma conversa que AINDA processa: reconecta ao stream ao vivo e,
  // se a conexão cair de novo, tenta religar algumas vezes (a tarefa segue no
  // servidor). No fim, recarrega a versão canônica do banco.
  async function followActiveConversation(convId, lastUserText) {
    if (currentRef.current?.id !== convId) return;
    const ref = { key: null };
    for (let attempt = 0; attempt < 40; attempt++) {
      if (currentRef.current?.id !== convId) return; // usuário saiu
      const { attached, sawDone } = await reconnectLiveRun(convId, ref, lastUserText);
      if (sawDone) break;           // run terminou de fato
      if (!attached) break;         // 204/erro: não há mais nada rodando ao vivo
      // Caiu antes do "done": a tarefa pode seguir no servidor. Confere se ainda
      // está ativa; se sim, aguarda e religa.
      if (currentRef.current?.id !== convId) return;
      let stillActive = false;
      try {
        const r = await fetch(`${API}/api/conversations/${convId}`);
        if (r.ok) { const d = await r.json(); stillActive = !!d.active; }
      } catch {}
      if (!stillActive) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    // Reconcilia com o estado final salvo (mensagem canônica + arquivos).
    if (currentRef.current?.id === convId) {
      try {
        const r = await fetch(`${API}/api/conversations/${convId}`);
        if (r.ok) { const d = await r.json(); if (currentRef.current?.id === convId) { setMessages(d.messages || []); loadFiles(convId); } }
      } catch {}
    }
    setChatBusy(false);
    setPaused(false);
    setStatusText('');
  }
  // Ponte para o useConversations: openConversation dispara a reconexão sem
  // depender da ordem de criação dos hooks (ele roda antes do useChat).
  if (followActiveRef) followActiveRef.current = followActiveConversation;

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
    // keyRef é mutável e compartilhado com consumeChatStream/reconnectLiveRun:
    // quando o servidor manda "saved", a chave passa a apontar para o id real.
    const keyRef = { key: assistantMsgId };
    const update = (fn) => {
      const key = keyRef.key;
      setMessages(prev => prev.map(m => m.id === key ? fn(m) : m));
    };

    const body = {
      message: text,
      model,
      assistantId,
      webSearch,
      effort,
      ...(team ? { orchestrate: true, orchestrateIds: effectiveTeam.map(a => a.id) } : {}),
      // Multimodelo: 2+ modelos na mesma mensagem (tem prioridade no backend)
      ...(multiModel ? { multiModel } : {}),
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
      await consumeChatStream(reader, keyRef, text);
    } catch (err) {
      // A conexão SSE caiu (trocar de aba / minimizar no celular / rede
      // oscilando). A tarefa CONTINUA rodando no servidor — então, em vez de
      // marcar como falha, RECONECTAMOS ao stream ao vivo e seguimos mostrando o
      // andamento no mesmo balão. Se de fato não houver mais nada rodando (já
      // terminou), o fallback busca a resposta pronta salva no banco.
      setStatusText('Reconectando...');
      const { attached, sawDone } = await reconnectLiveRun(conv.id, keyRef, text);
      if (!attached) {
        recoverPendingReply(conv.id);
      } else if (!sawDone) {
        // Reconectou mas caiu de novo antes de terminar: acompanha em segundo plano.
        followActiveConversation(conv.id, text);
      }
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

  // Interrompe SÓ um modelo da execução multimodelo em andamento (o botão
  // "Parar" geral continua parando tudo, via control('stop')).
  async function cancelMultiSlot(slot) {
    if (!current?.id) return;
    try {
      const res = await fetch(`${API}/api/conversations/${current.id}/multimodel/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error || 'Não foi possível interromper este modelo.');
      }
    } catch (err) {
      showToast(err?.message || 'Não foi possível interromper este modelo.');
    }
  }

  return { busy, busyRef, paused, statusText, controlPending, nowTick, sendMessage, retrySend, control, cancelMultiSlot };
}
