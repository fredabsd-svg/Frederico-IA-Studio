import { useState } from 'react';
import { API, TOOL_INFO, TEMPLATES, emptyForm } from '../constants.js';

// Assistentes (lista/seleção) + Assistant Studio (formulário de criar/editar).
// Recebe as dependências do App por parâmetro e devolve { estado, ações }.
export function useAssistants({ model, setModel, showToast, askConfirm }) {
  const [assistants, setAssistants] = useState([]);
  const [assistantId, setAssistantId] = useState(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());

  async function loadAssistants() {
    try {
      const res = await fetch(`${API}/api/assistants`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      const firstLoad = !assistantId; // ainda não havia assistente selecionado
      setAssistants(rows);
      setAssistantId(prev => (prev && rows.some(a => a.id === prev)) ? prev : (rows[0]?.id || null));
      // Só alinha o modelo ao assistente no PRIMEIRO carregamento. Recarregar a
      // lista depois (ex.: após salvar um assistente) NÃO pode sobrescrever um
      // modelo que o usuário trocou à mão — quem seleciona um assistente é o
      // pickAssistant, que já cuida do modelo.
      if (firstLoad) {
        const chosen = rows[0];
        if (chosen?.model) setModel(chosen.model);
      }
    } catch {}
  }

  function pickAssistant(id) {
    setAssistantId(id);
    const a = assistants.find(x => x.id === id);
    if (a?.model) setModel(a.model);
  }

  // ---- Assistant Studio ----
  function openStudioNew() { setForm(emptyForm()); setStudioOpen(true); }
  function openStudioEdit(a) {
    setForm({ id: a.id, name: a.name, emoji: a.emoji || 'bot', color: a.color || '', model: a.model || model, system_prompt: a.system_prompt || '', template: '', tools: Array.isArray(a.tools) ? a.tools : TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20, ...(a.personality || {}) } });
    setStudioOpen(true);
  }
  function applyTemplate(key) {
    const t = TEMPLATES.find(x => x.key === key);
    if (!t) { setForm(f => ({ ...f, template: '' })); return; }
    // Só herda o ícone do template se a pessoa ainda não escolheu um: 'bot' é
    // o padrão de emptyForm(), e '🤖' era o padrão antes da migração.
    const untouched = f => f.emoji === 'bot' || f.emoji === '🤖';
    setForm(f => ({ ...f, template: key, system_prompt: t.prompt, emoji: untouched(f) ? t.emoji : f.emoji, name: f.name || t.label }));
  }
  function toggleTool(name) {
    setForm(f => ({ ...f, tools: f.tools.includes(name) ? f.tools.filter(t => t !== name) : [...f.tools, name] }));
  }
  function setSlider(key, val) { setForm(f => ({ ...f, personality: { ...f.personality, [key]: Number(val) } })); }

  async function saveAssistant() {
    if (!form.name.trim() || !form.system_prompt.trim()) { showToast('Preencha o nome e as instruções do assistente.'); return; }
    try {
      const payload = { name: form.name, emoji: form.emoji, color: form.color || null, model: form.model || model, system_prompt: form.system_prompt, tools: form.tools, personality: form.personality };
      const url = form.id ? `${API}/api/assistants/${form.id}` : `${API}/api/assistants`;
      const res = await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error();
      const saved = await res.json();
      const wasCreate = !form.id;
      await loadAssistants();
      // Ao CRIAR, seleciona o novo assistente (e adota o modelo dele). Ao EDITAR,
      // preserva a seleção e o modelo atuais — chamar pickAssistant aqui jogava o
      // modelo de volta ao padrão do assistente, descartando a escolha manual do
      // usuário só por ter salvo uma edição qualquer.
      if (saved?.id && wasCreate) pickAssistant(saved.id);
      setStudioOpen(false);
    } catch {
      showToast('Não foi possível salvar o assistente.');
    }
  }

  async function deleteAssistant() {
    if (!form.id) return;
    const confirmed = await askConfirm({
      title: 'Excluir assistente?',
      message: 'O assistente será removido. As conversas existentes continuarão preservadas.',
      confirmLabel: 'Excluir assistente',
      destructive: true
    });
    if (!confirmed) return;
    try {
      await fetch(`${API}/api/assistants/${form.id}`, { method: 'DELETE' });
      setStudioOpen(false);
      const res = await fetch(`${API}/api/assistants`);
      const data = await res.json();
      // Mesmo guard de loadAssistants: uma resposta de erro ({error}) não pode
      // virar estado — assistants precisa ser sempre um array (o App filtra).
      const rows = Array.isArray(data) ? data : [];
      setAssistants(rows);
      if (assistantId === form.id) pickAssistant(rows[0]?.id || null);
    } catch {
      showToast('Não foi possível excluir o assistente.');
    }
  }

  return {
    assistants, assistantId, studioOpen, setStudioOpen, form, setForm,
    loadAssistants, pickAssistant, openStudioNew, openStudioEdit,
    applyTemplate, toggleTool, setSlider, saveAssistant, deleteAssistant
  };
}
