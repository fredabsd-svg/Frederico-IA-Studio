// Estado e chamadas de API do Modo Design.
//
// Um projeto aberto é uma "fatia grossa": projeto + versão atual + histórico +
// chat. As rotas de geração e reversão já devolvem esse pacote inteiro, então o
// hook substitui o estado de uma vez em vez de remendar campo a campo — é o que
// evita o preview mostrar uma versão e a lista de histórico outra.
import { useCallback, useState } from 'react';
import { API } from '../constants.js';

async function readError(response, fallback) {
  try {
    const data = await response.json();
    return data?.error || fallback;
  } catch {
    return fallback;
  }
}

export function useDesign() {
  const [projects, setProjects] = useState([]);
  const [systems, setSystems] = useState([]);
  const [project, setProject] = useState(null);   // projeto aberto (pacote completo)
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);        // geração em andamento
  const [error, setError] = useState('');

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/design/projects`);
      if (r.ok) setProjects(await r.json());
    } catch {
      setError('Não consegui carregar os projetos de design.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSystems = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/design/systems`);
      if (r.ok) setSystems(await r.json());
    } catch { /* a tela funciona sem design system */ }
  }, []);

  const openProject = useCallback(async (id) => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(id)}`);
      if (!r.ok) { setError(await readError(r, 'Projeto não encontrado.')); return null; }
      const data = await r.json();
      setProject(data);
      return data;
    } catch {
      setError('Não consegui abrir o projeto.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const closeProject = useCallback(() => { setProject(null); setError(''); }, []);

  // Cria o projeto já com a primeira geração. Mesmo quando a IA falha, o
  // backend devolve o projeto criado — abrimos assim mesmo, com o erro visível,
  // para o usuário reformular no chat em vez de recomeçar.
  const createProject = useCallback(async (input) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${API}/api/design/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(data?.error || 'Não consegui criar o projeto.');
        if (data?.project) { await openProject(data.project.id); return data.project; }
        return null;
      }
      await loadProjects();
      return await openProject(data.id);
    } catch {
      setError('Não consegui criar o projeto.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [loadProjects, openProject]);

  // `target` é o elemento clicado na prévia (edição inline). Vai junto do
  // pedido para que o modelo saiba o que NÃO mexer.
  const generate = useCallback(async (projectId, prompt, model = '', target = null) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model, target }),
      });
      const data = await r.json().catch(() => null);
      // Mesmo no erro a resposta traz o pacote atualizado (com a fala do
      // usuário e a explicação no chat) — atualizar aqui é o que faz a
      // mensagem de erro aparecer na conversa, e não só num alerta solto.
      if (data?.id) setProject(data);
      if (!r.ok) { setError(data?.error || 'Não consegui gerar esta versão.'); return false; }
      await loadProjects();
      return true;
    } catch {
      setError('Não consegui gerar esta versão.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [loadProjects]);

  // Gera uma imagem para o projeto via API. Devolve o registro (id, src, mime)
  // em caso de sucesso, ou null em caso de falha — o erro fica em `error`.
  const generateImage = useCallback(async (projectId, prompt, model = '') => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) { setError(data?.error || 'Não consegui gerar a imagem.'); return null; }
      return data;
    } catch {
      setError('Não consegui gerar a imagem.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const listImages = useCallback(async (projectId) => {
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}/images`);
      if (!r.ok) return [];
      return await r.json();
    } catch {
      return [];
    }
  }, []);

  const removeImage = useCallback(async (projectId, imageId) => {
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}`, {
        method: 'DELETE',
      });
      return r.ok;
    } catch { return false; }
  }, []);

  const revert = useCallback(async (projectId, versionId) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId }),
      });
      if (!r.ok) { setError(await readError(r, 'Não consegui voltar para esta versão.')); return false; }
      const data = await r.json();
      // O /revert não devolve o chat (ele não muda ao reverter): preserva o que
      // já está em memória para as bolhas não sumirem da tela.
      setProject(prev => ({ ...(prev || {}), ...data, messages: prev?.messages || [] }));
      return true;
    } catch {
      setError('Não consegui voltar para esta versão.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  // Ajustes finos. O efeito visual JÁ aconteceu no iframe quando o usuário
  // mexeu no controle; esta chamada só torna a mudança permanente. Por isso ela
  // atualiza o projeto em memória de forma otimista: voltar o slider para o
  // valor antigo enquanto a resposta não chega seria um salto na tela.
  const saveAdjustments = useCallback(async (projectId, adjustments) => {
    setProject(prev => (prev?.id === projectId ? { ...prev, adjustments } : prev));
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}/adjustments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjustments }),
      });
      if (!r.ok) { setError(await readError(r, 'Não consegui salvar o ajuste.')); return false; }
      const data = await r.json();
      // O servidor é a autoridade sobre o que foi aceito: um valor recusado
      // (cor fora do formato, medida fora da faixa) some aqui, e o controle
      // volta para o valor do design em vez de mostrar algo que não vale.
      setProject(prev => (prev?.id === projectId ? { ...prev, ...data, messages: prev.messages, versions: prev.versions } : prev));
      return true;
    } catch {
      setError('Não consegui salvar o ajuste.');
      return false;
    }
  }, []);

  const removeProject = useCallback(async (projectId) => {
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      if (!r.ok) return false;
      setProject(prev => (prev?.id === projectId ? null : prev));
      await loadProjects();
      return true;
    } catch { return false; }
  }, [loadProjects]);

  const renameProject = useCallback(async (projectId, title) => {
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!r.ok) return false;
      const data = await r.json();
      setProject(prev => (prev?.id === projectId ? { ...prev, ...data } : prev));
      await loadProjects();
      return true;
    } catch { return false; }
  }, [loadProjects]);

  // Fixa (ou solta, com string vazia) o modelo do projeto. Reusa o PATCH que já
  // renomeia — é a mesma linha do banco, e uma rota própria só para isto seria
  // superfície nova sem ganho.
  const saveModel = useCallback(async (projectId, modelRef) => {
    setProject(prev => (prev?.id === projectId ? { ...prev, modelRef: modelRef || null } : prev));
    try {
      const r = await fetch(`${API}/api/design/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelRef || '' }),
      });
      if (!r.ok) { setError(await readError(r, 'Não consegui trocar o modelo.')); return false; }
      const data = await r.json();
      setProject(prev => (prev?.id === projectId
        ? { ...prev, ...data, messages: prev.messages, versions: prev.versions }
        : prev));
      return true;
    } catch {
      setError('Não consegui trocar o modelo.');
      return false;
    }
  }, []);

  const saveSystem = useCallback(async (input, id = '') => {
    try {
      const r = await fetch(`${API}/api/design/systems${id ? `/${encodeURIComponent(id)}` : ''}`, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!r.ok) { setError(await readError(r, 'Não consegui salvar a marca.')); return null; }
      const data = await r.json();
      await loadSystems();
      return data;
    } catch {
      setError('Não consegui salvar a marca.');
      return null;
    }
  }, [loadSystems]);

  const removeSystem = useCallback(async (id) => {
    try {
      const r = await fetch(`${API}/api/design/systems/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (r.ok) await loadSystems();
      return r.ok;
    } catch { return false; }
  }, [loadSystems]);

  return {
    projects, systems, project, loading, busy, error,
    setError, loadProjects, loadSystems, openProject, closeProject,
    createProject, generate, generateImage, listImages, removeImage,
    revert, removeProject, renameProject,
    saveAdjustments, saveModel, saveSystem, removeSystem,
  };
}
