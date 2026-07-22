import { useEffect, useRef, useState } from 'react';
import { API } from '../constants.js';

// ---- Fila de tarefas ----
// Recebe as dependências do App por parâmetro e devolve { estado, ações }.
export function useTasks({ current, busyRef, openConversation, ensureConversation,
                           input, setInput, listening, recognitionRef,
                           model, assistantId, webSearch, showToast, waitForUploads }) {
  const [tasks, setTasks] = useState([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const prevTasksRef = useRef([]);

  const tasksActive = tasks.some(t => t.status === 'queued' || t.status === 'running');
  useEffect(() => {
    if (!tasksActive && !tasksOpen) return;
    const iv = setInterval(pollTasks, 4000);
    return () => clearInterval(iv);
  }, [tasksActive, tasksOpen, current?.id]);

  async function pollTasks() {
    try {
      const rows = await (await fetch(`${API}/api/tasks`)).json();
      for (const r of rows) {
        const old = prevTasksRef.current.find(p => p.id === r.id);
        if (old && (old.status === 'queued' || old.status === 'running')) {
          if (r.status === 'done') {
            showToast(`✅ Tarefa concluída: ${r.prompt.slice(0, 60)}`, 'ok');
            // Só recarrega se NÃO estiver com uma resposta em andamento na tela,
            // senão o setMessages substituiria o stream ao vivo e ele "sumiria".
            if (r.conversation_id === current?.id && !busyRef.current) { openConversation(current.id); }
          }
          if (r.status === 'error') showToast(`⚠️ Tarefa falhou: ${(r.error || '').slice(0, 100)}`);
        }
      }
      prevTasksRef.current = rows;
      setTasks(rows);
    } catch {}
  }

  async function sendAsTask() {
    const text = input.trim();
    if (!text) return;
    if (busyRef.current) { showToast('Aguarde a resposta atual terminar antes de enviar uma tarefa em segundo plano.'); return; }
    let conv = current;
    if (!conv) { conv = await ensureConversation(); if (!conv) return; }
    const synchronizedFiles = waitForUploads ? await waitForUploads(conv.id) : [];
    if (synchronizedFiles.some(file => file.kind === 'upload' && file.available === false)) {
      showToast('Há anexo indisponível nesta conversa. Remova-o e anexe novamente antes de criar a tarefa.');
      return;
    }
    if (listening) recognitionRef.current?.stop();
    setInput('');
    try {
      const res = await fetch(`${API}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: conv.id, message: text, model, assistantId, webSearch }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível criar a tarefa.');
      showToast('⏳ Tarefa adicionada à fila — acompanhe no botão "Tarefas".', 'ok');
      await pollTasks();
    } catch (err) { showToast(err.message || 'Não foi possível criar a tarefa.'); }
  }

  async function cancelTask(id) {
    try { await fetch(`${API}/api/tasks/${id}/cancel`, { method: 'POST' }); await pollTasks(); } catch {}
  }

  return { tasks, tasksOpen, setTasksOpen, tasksActive, pollTasks, sendAsTask, cancelTask };
}
