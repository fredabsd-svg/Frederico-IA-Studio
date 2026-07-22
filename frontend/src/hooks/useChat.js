import { useEffect, useRef, useState } from 'react';
import { API } from '../constants.js';
import { takeSseEvents } from '../sse.js';

// Watchdog do SSE: o servidor manda um heartbeat (": ping") a cada 15s mesmo
// quando o modelo está pensando. Se NADA chegar por este tempo, a conexão
// morreu em silêncio (proxy/rede móvel) — cancelamos o reader e lançamos, e o
// chamador cai na reconexão automática em vez de exibir "Raciocinando..."
// para sempre sem entregar a resposta.
const SSE_STALL_MS = 60000;
async function readWithTimeout(reader, ms = SSE_STALL_MS) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE_STALLED')), ms); })
    ]);
  } finally { clearTimeout(timer); }
}

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
                          model, assistantId, webSearch, effort, multiModel, setNeedLogin, showToast,
                          onFreeEvent, onFreeLimit }) {
  // ---- MULTICONVERSA: estado de execução POR CONVERSA ----
  // Cada conversa ativa tem sua própria entrada { busy, paused, status }.
  // `busy`/`paused`/`statusText` (abaixo) são a projeção da conversa ABERTA —
  // a API para o App continua a mesma. `runs` alimenta o indicador da barra
  // lateral; `anyBusy` diz se HÁ alguma execução em andamento.
  const [runs, setRuns] = useState({});
  const runsRef = useRef({});
  const patchRun = (convId, patch) => {
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
  // ÉPOCAS de stream: cada conversa tem um contador; quem começa a consumir o
  // stream dela (envio ou reconexão/replay) registra a época vigente. Quando um
  // NOVO consumidor assume (ex.: usuário voltou e o replay recomeça do zero), a
  // época avança e o consumidor antigo se descarta sozinho. Sem isso, dois
  // consumidores da MESMA conversa aplicariam os mesmos eventos em dobro
  // (texto duplicado) — o "se misturar" que não pode acontecer.
  const streamEpochsRef = useRef({});
  const newStreamEpoch = (convId) => (streamEpochsRef.current[convId] = (streamEpochsRef.current[convId] || 0) + 1);
  const isLiveEpoch = (convId, epoch) => streamEpochsRef.current[convId] === epoch;

  const currentRunState = (current?.id && runs[current.id]) || {};
  const busy = Boolean(currentRunState.busy);
  const paused = Boolean(currentRunState.paused);
  const statusText = currentRunState.status || '';
  const anyBusy = Object.values(runs).some(r => r?.busy);

  const [controlPending, setControlPending] = useState(false);
  const [nowTick, setNowTick] = useState(0);
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  // Enquanto QUALQUER conversa processa, "bate um relógio" para contadores vivos
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyBusy]);

  // ---- Controle: pausar / continuar / parar (da conversa ABERTA) ----
  async function control(action) {
    const conversationId = currentRef.current?.id;
    if (!conversationId || !runsRef.current[conversationId]?.busy || controlPending) return;
    setControlPending(true);
    if (action === 'pause') patchRun(conversationId, { status: 'Pausando...' });
    if (action === 'resume') patchRun(conversationId, { status: 'Retomando...' });
    if (action === 'stop') patchRun(conversationId, { status: 'Interrompendo...' });
    try {
      const response = await fetch(`${API}/api/conversations/${conversationId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Não foi possível controlar o processamento.');
      if (action === 'pause') patchRun(conversationId, { paused: Boolean(result.paused) });
      if (action === 'resume' || action === 'stop') patchRun(conversationId, { paused: false });
    } catch (err) {
      patchRun(conversationId, { status: '' });
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

  // Vigia em segundo plano uma conversa ativa da qual o usuário SAIU e cujo
  // consumidor local morreu (queda de SSE com o usuário em outra conversa):
  // quando o servidor terminar, apaga o "girando" da barra lateral e atualiza a
  // lista. Se alguém reconectar à conversa (época avança), este vigia se retira.
  async function watchDetachedRun(convId) {
    const epoch = streamEpochsRef.current[convId] || 0;
    for (let i = 0; i < 360; i++) { // ~30 min
      await new Promise(r => setTimeout(r, 5000));
      if (streamEpochsRef.current[convId] !== epoch) return; // outro consumidor assumiu
      if (!runsRef.current[convId]?.busy) return;            // já foi encerrado
      try {
        const res = await fetch(`${API}/api/conversations/${convId}`);
        if (res.ok) {
          const data = await res.json();
          if (!data.active) {
            endRun(convId);
            fetchConversations().catch(() => {});
            return;
          }
        }
      } catch {}
    }
  }

  // Consome um stream SSE de chat (POST /chat ou reconexão GET /stream) e vai
  // atualizando a mensagem do assistente apontada por keyRef.key. É a MESMA
  // lógica para o envio normal e para a reconexão — assim, ao voltar à página,
  // o andamento é remontado exatamente como apareceria ao vivo.
  // MULTICONVERSA: todo evento visual é aplicado SÓ se a conversa deste stream
  // (convId) ainda é a aberta — trocar de conversa no meio nunca mistura texto
  // de uma na outra. `epoch` identifica este consumidor: se outro assumir a
  // mesma conversa (replay ao reabrir), este se descarta e cancela o reader.
  // Retorna { sawDone, sawError, stale } para o chamador decidir o que fazer.
  async function consumeChatStream(reader, keyRef, text, convId, epoch) {
    const update = (fn) => {
      if (currentRef.current?.id !== convId) return; // nunca pintar em outra conversa
      const key = keyRef.key;
      setMessages(prev => prev.map(m => m.id === key ? fn(m) : m));
    };
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false, sawError = false;
    while (true) {
      let step;
      try {
        step = await readWithTimeout(reader);
      } catch (err) {
        try { reader.cancel(); } catch {}
        throw err; // o chamador reconecta ao stream ao vivo
      }
      if (!isLiveEpoch(convId, epoch)) {
        // Outro consumidor assumiu esta conversa (ex.: o usuário voltou e o
        // replay recomeçou do zero). Sai de cena sem tocar em mais nada.
        try { reader.cancel(); } catch {}
        return { sawDone, sawError, stale: true };
      }
      const { done, value } = step;
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      const parsed = takeSseEvents(buffer, { flush: done });
      buffer = parsed.rest;
      for (const ev of parsed.events) {
        if (ev.type === 'status') patchRun(convId, { status: ev.content || '' });
        // ---- Modo gratuito: estados da fila e status atualizado ----
        if (ev.type === 'free_queue') {
          if (ev.state === 'preparing') patchRun(convId, { status: 'Preparando solicitação (modo gratuito)...' });
          if (ev.state === 'waiting') patchRun(convId, { status: `Aguardando na fila do modo gratuito (posição ${ev.position || 1})... Você pode cancelar no botão Parar.` });
          if (ev.state === 'processing') patchRun(convId, { status: 'Processando com o modelo gratuito...' });
          if (ev.state === 'cancelled') patchRun(convId, { status: 'Solicitação cancelada.' });
        }
        if (ev.type === 'free_status') onFreeEvent?.(ev);
        if (ev.type === 'memory_context') update(m => ({ ...m, memory: ev.memory }));
        if (ev.type === 'run_state') update(m => ({ ...m, execution: ev.execution }));
        if (ev.type === 'prompt_meta') update(m => ({ ...m, prompt: ev.prompt }));
        if (ev.type === 'delta') update(m => {
          const blocks = [...(m.blocks || [])];
          const last = blocks[blocks.length - 1];
          if (last && last.type === 'text') blocks[blocks.length - 1] = { ...last, content: last.content + ev.content };
          else blocks.push({ type: 'text', content: ev.content });
          return { ...m, blocks, content: (m.content || '') + ev.content };
        });
        if (ev.type === 'tool_start') { patchRun(convId, { status: `Executando ${ev.name}...` }); update(m => ({ ...m, blocks: [...(m.blocks || []), { type: 'tool', name: ev.name, preview: ev.preview, detail: ev.detail || '', status: 'running', started: Date.now() }] })); }
        if (ev.type === 'tool_result') update(m => {
          const blocks = [...(m.blocks || [])];
          const status = toolResultFailed(ev.content) ? 'error' : 'done';
          for (let i = blocks.length - 1; i >= 0; i--) { if (blocks[i].type === 'tool' && blocks[i].status === 'running') { blocks[i] = { ...blocks[i], status, ended: Date.now(), result: ev.content, ...(ev.thumb ? { thumb: ev.thumb } : {}) }; break; } }
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
          if (currentRef.current?.id === convId) setMessages(prev => {
            const arr = [...prev];
            const ai = arr.findIndex(m => m.id === previousKey);
            if (ai > -1) { arr[ai] = { ...arr[ai], id: ev.assistantMessageId }; if (arr[ai - 1]?.role === 'user') arr[ai - 1] = { ...arr[ai - 1], id: ev.userMessageId }; }
            return arr;
          });
        }
        if (ev.type === 'execution_failed') {
          update(m => ({ ...m, failed: true, retryText: text, execution: { state: 'fatal_error', terminal: true, detail: ev.content || 'A execução falhou.' } }));
          if (ev.content) showToast(ev.content);
        }
        if (ev.type === 'error') { sawError = true; update(m => ({ ...m, failed: true, retryText: text, execution: { state: 'fatal_error', terminal: true, detail: ev.content || 'Erro inesperado.' }, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${ev.content}` }] })); }
        // Checkpoint salvo: a tarefa dá para RETOMAR de onde parou (botão Continuar).
        if (ev.type === 'resumable') update(m => ({ ...m, resumable: Boolean(ev.value) }));
        if (ev.type === 'done') sawDone = true;
      }
      if (done) break;
    }
    return { sawDone, sawError, stale: false };
  }

  // Reconecta a um processamento que continua rodando no servidor (usuário
  // voltou à página, minimizou, ou a rede oscilou). Reproduz o run inteiro do
  // zero sobre a mensagem-alvo — por isso zeramos o conteúdo antes, para nunca
  // duplicar texto já aplicado. `ref` é mutável: se ainda não aponta para um
  // balão, cria/reaproveita um (e escreve ref.key) para receber o andamento.
  // Assume o posto de ÚNICO consumidor da conversa (avança a época): qualquer
  // consumidor anterior da mesma conversa se descarta sozinho.
  async function reconnectLiveRun(convId, ref, text = '') {
    if (currentRef.current?.id !== convId) return { attached: false, sawDone: false };
    const epoch = newStreamEpoch(convId);
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
    patchRun(convId, { busy: true, paused: false, status: 'Retomando...' });
    // Remonta do zero: zera o balão-alvo antes do replay para evitar texto dobrado.
    if (currentRef.current?.id === convId) {
      setMessages(prev => prev.map(m => m.id === ref.key ? { ...m, content: '', blocks: [] } : m));
    }
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
      const { sawDone, stale } = await consumeChatStream(reader, ref, text, convId, epoch);
      return { attached: true, sawDone, stale };
    } catch {
      return { attached: true, sawDone: false, stale: !isLiveEpoch(convId, epoch) };
    }
  }

  // Ao voltar a uma conversa que AINDA processa: reconecta ao stream ao vivo e,
  // se a conexão cair de novo, tenta religar algumas vezes (a tarefa segue no
  // servidor). No fim, recarrega a versão canônica do banco.
  async function followActiveConversation(convId, lastUserText) {
    if (currentRef.current?.id !== convId) return;
    const ref = { key: null };
    for (let attempt = 0; attempt < 40; attempt++) {
      if (currentRef.current?.id !== convId) { watchDetachedRun(convId); return; } // usuário saiu
      const { attached, sawDone, stale } = await reconnectLiveRun(convId, ref, lastUserText);
      if (stale) return;            // outro consumidor assumiu esta conversa
      if (sawDone) break;           // run terminou de fato
      if (!attached) break;         // 204/erro: não há mais nada rodando ao vivo
      // Caiu antes do "done": a tarefa pode seguir no servidor. Confere se ainda
      // está ativa; se sim, aguarda e religa.
      if (currentRef.current?.id !== convId) { watchDetachedRun(convId); return; }
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
    endRun(convId);
    fetchConversations().catch(() => {});
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
    if (!text) return;
    // MULTICONVERSA: só a conversa ABERTA bloqueia o envio — outras conversas
    // processando em paralelo não impedem esta de receber uma mensagem.
    if (current?.id && runsRef.current[current.id]?.busy) return;
    if (team && effectiveTeam.length === 0) { showToast('Selecione ao menos 1 assistente no painel da Equipe.'); return; }
    if (listening) recognitionRef.current?.stop();
    let conv = current;
    if (!conv) { conv = await ensureConversation(); if (!conv) return; }
    if (runsRef.current[conv.id]?.busy) return; // corrida rara (duplo clique)
    // currentRef é sincronizado por efeito (roda DEPOIS do render); na 1ª
    // mensagem de uma conversa nova ele ainda apontaria para null e os gates
    // descartariam os primeiros eventos. Atualiza já — mesmo truque do
    // openConversation.
    if (currentRef.current?.id !== conv.id) currentRef.current = conv;
    if (!isRetry) setInput('');
    const activeDeveloper = developerSession && (!developerSession.conversationId || developerSession.conversationId === conv.id) ? developerSession : null;
    if (activeDeveloper && !activeDeveloper.conversationId) setDeveloperSession({ ...activeDeveloper, conversationId: conv.id });
    const epoch = newStreamEpoch(conv.id);
    patchRun(conv.id, { busy: true, paused: false, status: 'Pensando...' });
    const assistantMsgId = `local-${Date.now()}`;
    // created_at aqui e' o horario local do envio; ao recarregar, o valor do
    // servidor (server.js) substitui. Sem isto, a mensagem recem-enviada nao
    // tem hora e o separador de data nao consegue agrupa-la.
    const sentAt = new Date().toISOString();
    // _key: chave de render ESTÁVEL, independente do id. Sem ela, quando o evento
    // "saved" troca o id temporário pelo id real do banco, a chave React mudava e
    // a bolha remontava no meio do streaming — recolhendo o painel de execução e
    // reprocessando o markdown. As mensagens vindas do servidor não têm _key e
    // seguem usando o id (também estável).
    setMessages(prev => [...prev, { _key: `u-${assistantMsgId}`, role: 'user', content: text, created_at: sentAt }, { _key: assistantMsgId, id: assistantMsgId, role: 'assistant', content: '', blocks: [], created_at: sentAt }]);
    // keyRef é mutável e compartilhado com consumeChatStream/reconnectLiveRun:
    // quando o servidor manda "saved", a chave passa a apontar para o id real.
    const keyRef = { key: assistantMsgId };
    const update = (fn) => {
      if (currentRef.current?.id !== conv.id) return;
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
    let outcome = null;
    try {
      const res = await fetch(`${API}/api/conversations/${conv.id}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (res.status === 401) { endRun(conv.id); setNeedLogin(true); return; }
      if (!res.ok) {
        let msg = `O servidor respondeu com erro (${res.status}).`;
        let payload = null;
        try { payload = await res.json(); if (payload?.error) msg = payload.error; } catch {}
        // Limite/bloqueio do MODO GRATUITO: em vez de um erro técnico no chat,
        // abre a tela amigável com as opções (aguardar, chave própria, tutorial).
        if (payload?.code && String(payload.code).startsWith('free_') && onFreeLimit) {
          setMessages(prev => prev.filter(m => m.id !== keyRef.key && !(m.role === 'user' && m.created_at === sentAt && m.content === text)));
          setInput(text); // devolve o texto para reenviar depois
          onFreeLimit({ ...payload, retryText: text });
          endRun(conv.id);
          return;
        }
        update(m => ({ ...m, failed: true, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${msg}` }] }));
        showToast(msg);
        endRun(conv.id);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('A resposta do servidor não pôde ser lida.');
      outcome = await consumeChatStream(reader, keyRef, text, conv.id, epoch);
    } catch (err) {
      // A conexão SSE caiu (trocar de aba / minimizar no celular / rede
      // oscilando). A tarefa CONTINUA rodando no servidor.
      if (currentRef.current?.id !== conv.id) {
        // O usuário está em OUTRA conversa: nada a redesenhar aqui. Um vigia em
        // segundo plano apaga o "girando" quando o servidor terminar; se o
        // usuário voltar antes, o openConversation reconecta e reassume.
        watchDetachedRun(conv.id);
        return;
      }
      // Usuário ainda está NESTA conversa: reconecta ao stream ao vivo e segue
      // mostrando o andamento no mesmo balão. Se não houver mais nada rodando
      // (já terminou), o fallback busca a resposta pronta salva no banco.
      patchRun(conv.id, { status: 'Reconectando...' });
      const r = await reconnectLiveRun(conv.id, keyRef, text);
      if (r.stale) return; // outro consumidor assumiu — ele é o dono do estado
      if (!r.attached) {
        recoverPendingReply(conv.id);
        outcome = { sawDone: false, sawError: false, stale: false };
      } else if (!r.sawDone) {
        // Reconectou mas caiu de novo antes de terminar: o follow assume o
        // acompanhamento (e a limpeza do estado) em segundo plano.
        followActiveConversation(conv.id, text);
        return;
      } else {
        outcome = { sawDone: true, sawError: false, stale: false };
      }
    }
    if (outcome?.stale) return; // outro consumidor assumiu esta conversa
    // Fecha qualquer ferramenta que tenha ficado "rodando"
    update(m => ({ ...m, blocks: (m.blocks || []).map(b => b.type === 'tool' && b.status === 'running' ? { ...b, status: 'done', ended: Date.now() } : b) }));
    endRun(conv.id);
    if (currentRef.current?.id === conv.id) await loadFiles(conv.id);
    try {
      const rows = await fetchConversations();
      const updated = rows.find(c => c.id === conv.id);
      if (updated && currentRef.current?.id === conv.id) setCurrent(updated);
    } catch {}
  }

  // RETOMADA REAL: continua uma tarefa interrompida A PARTIR DO CHECKPOINT do
  // servidor (POST /resume) — NÃO reenvia o texto nem cria mensagem nova de
  // usuário. Faz stream para um balão de assistente novo (o balão interrompido,
  // com o parcial + aviso, permanece acima). Multiconversa-aware (mesma época/
  // gate por conversa do envio normal).
  async function resumeRun(convId) {
    const id = convId || current?.id;
    if (!id) return;
    if (runsRef.current[id]?.busy) return; // já processando
    if (currentRef.current?.id !== id) return;
    const epoch = newStreamEpoch(id);
    patchRun(id, { busy: true, paused: false, status: 'Retomando de onde parei...' });
    const assistantMsgId = `local-resume-${Date.now()}`;
    const keyRef = { key: assistantMsgId };
    setMessages(prev => {
      // Tira o marcador de retomável da mensagem interrompida (o botão sai) e
      // acrescenta o balão que vai receber a continuação.
      const cleared = prev.map(m => m.resumable ? { ...m, resumable: false } : m);
      return [...cleared, { id: assistantMsgId, role: 'assistant', content: '', blocks: [], created_at: new Date().toISOString() }];
    });
    const update = (fn) => {
      if (currentRef.current?.id !== id) return;
      setMessages(prev => prev.map(m => m.id === keyRef.key ? fn(m) : m));
    };
    let outcome = null;
    try {
      const res = await fetch(`${API}/api/conversations/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (res.status === 401) { endRun(id); setNeedLogin(true); return; }
      if (!res.ok) {
        let msg = `Não foi possível continuar (${res.status}).`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
        showToast(msg);
        // Sem checkpoint (409) ou erro: remove o balão vazio que criamos.
        setMessages(prev => prev.filter(m => m.id !== keyRef.key));
        endRun(id);
        // Recarrega para o botão refletir o estado real do servidor.
        try { const r = await fetch(`${API}/api/conversations/${id}`); if (r.ok) { const d = await r.json(); if (currentRef.current?.id === id) setMessages(d.messages || []); } } catch {}
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('A resposta do servidor não pôde ser lida.');
      outcome = await consumeChatStream(reader, keyRef, '', id, epoch);
    } catch {
      // Conexão caiu: a tarefa CONTINUA no servidor. Reconecta ao vivo (ou, se
      // o usuário está noutra conversa, um vigia limpa o indicador ao terminar).
      if (currentRef.current?.id !== id) { watchDetachedRun(id); return; }
      patchRun(id, { status: 'Reconectando...' });
      const r = await reconnectLiveRun(id, keyRef, '');
      if (r.stale) return;
      if (!r.attached) { recoverPendingReply(id); outcome = { sawDone: false, stale: false }; }
      else if (!r.sawDone) { followActiveConversation(id, ''); return; }
      else outcome = { sawDone: true, stale: false };
    }
    if (outcome?.stale) return;
    update(m => ({ ...m, blocks: (m.blocks || []).map(b => b.type === 'tool' && b.status === 'running' ? { ...b, status: 'done', ended: Date.now() } : b) }));
    endRun(id);
    if (currentRef.current?.id === id) await loadFiles(id);
    try { const rows = await fetchConversations(); const u = rows.find(c => c.id === id); if (u && currentRef.current?.id === id) setCurrent(u); } catch {}
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

  return { busy, busyRef, paused, statusText, controlPending, nowTick, runs, anyBusy, sendMessage, retrySend, resumeRun, control, cancelMultiSlot };
}
