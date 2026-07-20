import { useEffect, useRef, useState } from 'react';
import { API } from '../constants.js';

// Lista, seleção e CRUD de conversas + arquivos da conversa aberta.
// Recebe as dependências do App por parâmetro e devolve { estado, ações }.
export function useConversations({ clientId, model, setModel, showToast, blockConversationChange, askConfirm,
                                   startNewChat, setMessages, setDeveloperSession, setMenuOpen, followActiveRef }) {
  const [conversations, setConversations] = useState([]);
  const [allConvs, setAllConvs] = useState([]);
  const [current, setCurrent] = useState(null);
  const [files, setFiles] = useState([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const creatingConvRef = useRef(null);
  const currentRef = useRef(null);
  useEffect(() => { currentRef.current = current; }, [current]);

  async function fetchConversations(cid = clientId) {
    const res = await fetch(`${API}/api/conversations${cid ? `?client=${encodeURIComponent(cid)}` : ''}`);
    if (res.status === 401) { const e = new Error('auth'); e.auth = true; throw e; }
    if (!res.ok) throw new Error('Falha ao listar conversas.');
    const data = await res.json();
    const rows = Array.isArray(data) ? data : []; // nunca deixa um objeto de erro quebrar o render
    setConversations(rows);
    loadAllConvs(); // mantém a lista global (todos os clientes) para a busca
    return rows;
  }

  // Todas as conversas, de qualquer cliente — usado pela busca da barra lateral
  async function loadAllConvs() {
    try { const d = await (await fetch(`${API}/api/conversations?all=1`)).json(); setAllConvs(Array.isArray(d) ? d : []); } catch {}
  }

  // Cria o registro da conversa só quando ele é realmente necessário (1ª
  // mensagem, anexo ou tarefa). Evita acumular conversas vazias no histórico.
  async function ensureConversation(cid = clientId) {
    if (current) return current;
    // Single-flight: se duas ações "primeiras" (ex.: anexar + enviar) dispararem
    // quase juntas, ambas veem current=null; sem isso, criariam 2 conversas.
    if (creatingConvRef.current) return creatingConvRef.current;
    const p = (async () => {
      try {
        const res = await fetch(`${API}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Nova conversa', model, clientId: cid || null }) });
        if (!res.ok) throw new Error();
        const c = await res.json();
        setConversations(prev => [c, ...prev]);
        setCurrent(c);
        setFiles([]);
        return c;
      } catch {
        showToast('Não foi possível criar a conversa. O servidor está no ar?');
        return null;
      }
    })();
    creatingConvRef.current = p;
    try { return await p; }
    finally { creatingConvRef.current = null; }
  }

  async function openConversation(id) {
    if (blockConversationChange()) return;
    setDeveloperSession(null);
    setLoadingConv(true);
    setMenuOpen(false);
    try {
      const res = await fetch(`${API}/api/conversations/${id}`);
      const data = await res.json();
      setCurrent(data.conversation);
      setMessages(data.messages || []);
      // Restaura o MODELO que estava em uso nesta conversa. Sem isto, ao reabrir
      // (sair e voltar / recarregar) o seletor voltava ao modelo padrão e parecia
      // que "trocou o modelo" sozinho — quebrando o "mesmo estado de antes".
      if (data.conversation?.model && setModel) setModel(data.conversation.model);
      loadFiles(id);
      // Se a conversa AINDA está processando (o usuário saiu e voltou), reconecta
      // ao stream ao vivo e segue acompanhando o andamento — com pausar/parar
      // funcionando — como se nunca tivesse saído. currentRef é atualizado por um
      // efeito; setamos aqui também para o followActiveConversation não abortar.
      if (data.active && followActiveRef?.current) {
        currentRef.current = data.conversation;
        const lastUser = [...(data.messages || [])].reverse().find(m => m.role === 'user');
        followActiveRef.current(id, lastUser?.content || '');
      }
    } catch {
      showToast('Não foi possível abrir a conversa.');
    } finally {
      setLoadingConv(false);
    }
  }

  async function deleteConversation(id, e) {
    e.stopPropagation();
    const confirmed = await askConfirm({
      title: 'Apagar conversa?',
      message: 'A conversa e todos os arquivos dela serão apagados. Essa ação não pode ser desfeita.',
      confirmLabel: 'Apagar conversa',
      destructive: true
    });
    if (!confirmed) return;
    try {
      const res = await fetch(`${API}/api/conversations/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível apagar a conversa.');
      }
      await fetchConversations();
      if (current?.id === id) startNewChat();
    } catch (err) {
      showToast(err.message || 'Não foi possível apagar a conversa.');
    }
  }

  async function loadFiles(id = current?.id) {
    if (!id) return;
    try {
      const res = await fetch(`${API}/api/conversations/${id}/files`);
      const d = await res.json();
      setFiles(Array.isArray(d) ? d : []);
    } catch {}
  }

  return {
    conversations, allConvs, current, setCurrent, currentRef, files, setFiles, loadingConv,
    fetchConversations, loadAllConvs, ensureConversation, openConversation, deleteConversation, loadFiles
  };
}
