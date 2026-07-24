import { useCallback, useState } from 'react';
import { API } from '../constants.js';

// Estado do CHAT próprio do copiloto e da sua caixa de documentos. O contexto é
// isolado por completo do chat principal (o backend garante o isolamento) — aqui
// só orquestramos a interface: histórico, envio, limpar e os documentos.
export function useCopilotChat() {
  const [messages, setMessages] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const loadChat = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API}/api/copilot/chat`);
      if (r.ok) { const d = await r.json(); setMessages(Array.isArray(d.messages) ? d.messages : []); }
    } catch { /* offline */ }
    finally { setLoading(false); setLoaded(true); }
  }, []);

  const send = useCallback(async (text) => {
    const body = String(text || '').trim();
    if (!body || sending) return;
    setSending(true); setError(null);
    // Otimista: mostra a fala do usuário na hora.
    const optimistic = { id: `tmp-${Date.now()}`, role: 'user', content: body, pending: true };
    setMessages(prev => [...prev, optimistic]);
    try {
      const r = await fetch(`${API}/api/copilot/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error || 'Não consegui responder agora.');
        setMessages(prev => prev.filter(m => m.id !== optimistic.id)); // desfaz o otimista
        return;
      }
      setMessages(prev => [
        ...prev.filter(m => m.id !== optimistic.id),
        d.userMessage, d.message,
      ].filter(Boolean));
    } catch {
      setError('Falha de conexão. Tente de novo.');
      setMessages(prev => prev.filter(m => m.id !== optimistic.id));
    } finally { setSending(false); }
  }, [sending]);

  const clearChat = useCallback(async () => {
    try { await fetch(`${API}/api/copilot/chat`, { method: 'DELETE' }); } catch {}
    setMessages([]);
  }, []);

  const loadDocuments = useCallback(async () => {
    setDocsLoading(true);
    try {
      const r = await fetch(`${API}/api/copilot/documents`);
      if (r.ok) setDocuments(await r.json());
    } catch { /* offline */ }
    finally { setDocsLoading(false); }
  }, []);

  const deleteDocument = useCallback(async (id) => {
    setDocuments(prev => prev.filter(d => d.id !== id)); // otimista
    try { await fetch(`${API}/api/copilot/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
  }, []);

  return {
    messages, documents, sending, loading, docsLoading, error, loaded,
    loadChat, send, clearChat, loadDocuments, deleteDocument, setError,
  };
}
