import { useCallback, useRef, useState } from 'react';

// `constants.js` usa import.meta.env (Vite): importado DINAMICAMENTE, dentro das
// funções de rede, para as funções puras daqui continuarem testáveis no Node
// (mesmo padrão de useDevProjects.js).
async function apiUrl(path) {
  const { API } = await import('../constants.js');
  return `${API}${path}`;
}

// Teto da referência de modelo enviada (o backend aplica o mesmo).
export const MAX_MODEL_REF_CHARS = 360;

// Modelo da conversa atual, no formato que o backend aceita — ou nada. Em
// Configurações → Companion, "modelo em branco" significa ACOMPANHAR o modelo
// da conversa; sem este campo, o backend nunca sabia qual era e caía no padrão
// da conta.
export function copilotModelField(model) {
  const ref = typeof model === 'string' ? model.trim() : '';
  return ref && ref.length <= MAX_MODEL_REF_CHARS ? { model: ref } : {};
}

// Corpo do POST /api/copilot/chat. Puro para ser testável.
export function copilotChatBody(text, opts = {}, model = null) {
  return {
    text,
    shareContext: opts.shareContext === true,
    conversationId: opts.conversationId || null,
    ...copilotModelField(model),
  };
}

// Estado do painel PRÓPRIO do copiloto: chat, memória (notas), preferências,
// caixa de documentos e as ações que ele executa dentro do Studio.
//
// Sobre o contexto do chat principal: quem decide é o backend (ele conhece as
// preferências e é dono da autorização). Aqui só transportamos a intenção —
// `shareContext` marca "leve o contexto NESTA mensagem" — e mostramos, depois,
// o que de fato foi usado (`used`), sem prometer o que não aconteceu.
// `model`: o modelo da conversa aberta no chat principal (Companion.jsx já o
// recebe como prop). Vai junto nas chamadas que usam o provedor de IA.
export function useCopilotChat({ model = null } = {}) {
  const modelRef = useRef(model);
  modelRef.current = model;
  const [messages, setMessages] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [notes, setNotes] = useState([]);
  const [prefs, setPrefs] = useState(null);
  const [prefsOptions, setPrefsOptions] = useState(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const loadChat = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(await apiUrl(`/api/copilot/chat`));
      if (r.ok) { const d = await r.json(); setMessages(Array.isArray(d.messages) ? d.messages : []); }
    } catch { /* offline */ }
    finally { setLoading(false); setLoaded(true); }
  }, []);

  // `opts.shareContext` só tem efeito se as preferências permitirem — o backend
  // reavalia. `opts.conversationId` diz QUAL conversa principal está aberta.
  const send = useCallback(async (text, opts = {}) => {
    const body = String(text || '').trim();
    if (!body || sending) return;
    setSending(true); setError(null);
    // Otimista: mostra a fala do usuário na hora.
    const optimistic = { id: `tmp-${Date.now()}`, role: 'user', content: body, pending: true };
    setMessages(prev => [...prev, optimistic]);
    try {
      const r = await fetch(await apiUrl(`/api/copilot/chat`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(copilotChatBody(body, opts, modelRef.current)),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error || 'Não consegui responder agora.');
        setMessages(prev => prev.filter(m => m.id !== optimistic.id)); // desfaz o otimista
        return;
      }
      // `used` viaja junto da resposta: é o que a interface exibe como "usei N
      // mensagens do chat principal" — informação do servidor, não suposição.
      const answer = d.message ? { ...d.message, used: d.used || null } : null;
      setMessages(prev => [
        ...prev.filter(m => m.id !== optimistic.id),
        d.userMessage, answer,
      ].filter(Boolean));
    } catch {
      setError('Falha de conexão. Tente de novo.');
      setMessages(prev => prev.filter(m => m.id !== optimistic.id));
    } finally { setSending(false); }
  }, [sending]);

  const clearChat = useCallback(async () => {
    try { await fetch(await apiUrl(`/api/copilot/chat`), { method: 'DELETE' }); } catch {}
    setMessages([]);
  }, []);

  const loadDocuments = useCallback(async () => {
    setDocsLoading(true);
    try {
      const r = await fetch(await apiUrl(`/api/copilot/documents`));
      if (r.ok) setDocuments(await r.json());
    } catch { /* offline */ }
    finally { setDocsLoading(false); }
  }, []);

  const deleteDocument = useCallback(async (id) => {
    setDocuments(prev => prev.filter(d => d.id !== id)); // otimista
    try { await fetch(await apiUrl(`/api/copilot/documents/${encodeURIComponent(id)}`), { method: 'DELETE' }); } catch {}
  }, []);

  // ---- Memória e preferências ----------------------------------------------

  const loadMemory = useCallback(async () => {
    setMemoryLoading(true);
    try {
      const [rn, rp] = await Promise.all([
        fetch(await apiUrl(`/api/copilot/notes`)),
        fetch(await apiUrl(`/api/copilot/prefs`)),
      ]);
      if (rn.ok) setNotes(await rn.json());
      if (rp.ok) { const d = await rp.json(); setPrefs(d.prefs); setPrefsOptions(d.options || null); }
    } catch { /* offline */ }
    finally { setMemoryLoading(false); }
  }, []);

  const savePrefs = useCallback(async (patch) => {
    const next = { ...(prefs || {}), ...patch };
    setPrefs(next); // otimista: os controles respondem na hora
    try {
      const r = await fetch(await apiUrl(`/api/copilot/prefs`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (r.ok) { const d = await r.json(); setPrefs(d.prefs); return d.prefs; }
    } catch { /* offline */ }
    return next;
  }, [prefs]);

  const addNote = useCallback(async (input) => {
    try {
      const r = await fetch(await apiUrl(`/api/copilot/notes`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error || 'Não consegui guardar a nota.'); return null; }
      const note = await r.json();
      setNotes(prev => [note, ...prev]);
      return note;
    } catch { setError('Falha de conexão. Tente de novo.'); return null; }
  }, []);

  const updateNote = useCallback(async (id, patch) => {
    try {
      const r = await fetch(await apiUrl(`/api/copilot/notes/${encodeURIComponent(id)}`), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return null;
      const note = await r.json();
      // Reordena como o servidor: fixadas primeiro, depois as recentes.
      setNotes(prev => {
        const rest = prev.filter(n => n.id !== id);
        return [note, ...rest].sort((a, b) => Number(b.pinned) - Number(a.pinned));
      });
      return note;
    } catch { return null; }
  }, []);

  const deleteNote = useCallback(async (id) => {
    setNotes(prev => prev.filter(n => n.id !== id)); // otimista
    try { await fetch(await apiUrl(`/api/copilot/notes/${encodeURIComponent(id)}`), { method: 'DELETE' }); } catch {}
  }, []);

  // ---- Ações dentro do Studio ----------------------------------------------

  // Salva um texto como template de pedido (acervo do chat principal).
  const saveAsTemplate = useCallback(async (name, content) => {
    try {
      const r = await fetch(await apiUrl(`/api/copilot/actions/template`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error || 'Não consegui salvar o modelo.'); return null; }
      return await r.json();
    } catch { setError('Falha de conexão. Tente de novo.'); return null; }
  }, []);

  // Guarda um texto qualquer na caixa de documentos do copiloto.
  const saveAsDocument = useCallback(async (name, content, kind = 'texto') => {
    try {
      const r = await fetch(await apiUrl(`/api/copilot/documents`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content, kind }),
      });
      if (!r.ok) return null;
      const doc = await r.json();
      setDocuments(prev => [doc, ...prev]);
      return doc;
    } catch { return null; }
  }, []);

  // Resume a conversa do copiloto num documento (usa o provedor configurado).
  const summarizeChat = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(await apiUrl('/api/copilot/actions/summary'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(copilotModelField(modelRef.current)),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Não consegui resumir agora.'); return null; }
      if (d.document) setDocuments(prev => [d.document, ...prev]);
      return d;
    } catch { setError('Falha de conexão. Tente de novo.'); return null; }
  }, []);

  // Ferramentas executivas do Nino. Todas passam pelo backend para manter
  // autorização, escopo por usuário e trilha de auditoria.
  const runExecutiveTool = useCallback(async (tool, payload = {}) => {
    setError(null);
    try {
      const r = await fetch(await apiUrl(`/api/copilot/tools/${encodeURIComponent(tool)}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...copilotModelField(modelRef.current), ...payload }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setError(data.error || 'Não consegui executar a análise.'); return null; }
      return data;
    } catch {
      setError('Falha de conexão. Tente de novo.');
      return null;
    }
  }, []);

  const runExecutiveAction = useCallback(
    (action, content) => runExecutiveTool('executive-action', { action, content }),
    [runExecutiveTool]
  );

  return {
    messages, documents, notes, prefs, prefsOptions,
    sending, loading, docsLoading, memoryLoading, error, loaded,
    loadChat, send, clearChat, loadDocuments, deleteDocument,
    loadMemory, savePrefs, addNote, updateNote, deleteNote,
    saveAsTemplate, saveAsDocument, summarizeChat,
    runExecutiveTool, runExecutiveAction, setError,
  };
}
