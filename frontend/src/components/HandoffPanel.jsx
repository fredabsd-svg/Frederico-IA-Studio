import React, { useEffect, useState } from 'react';
import { Copy, Download, Laptop, Loader, Upload } from 'lucide-react';
import { API } from '../constants.js';
import { handoffState } from '../handoffState.js';

// Handoff local ↔ worktree (Fase 24).
//
// O trabalho da tarefa mora no clone da conversa. Este painel é a ponte com a
// máquina do usuário nos dois sentidos: os comandos que ele roda no clone dele
// para abrir a branch numa worktree ao lado, o patch do que ainda não foi
// publicado, e a devolução — um patch gerado localmente entrando no clone da
// tarefa.
//
// Os comandos vêm PRONTOS do backend: quem sabe a branch, se ela está
// publicada e quantos commits faltam é o git do clone, não o navegador.

function Comando({ item, onCopy }) {
  return (
    <li className="handoffCmd">
      <span className="handoffCmdLabel">{item.label}</span>
      <div className="handoffCmdRow">
        <code>{item.command}</code>
        <button type="button" className="devIconBtn" title="Copiar o comando" onClick={() => onCopy(item.command)}>
          <Copy size={12}/>
        </button>
      </div>
    </li>
  );
}

export function HandoffPanel({ conversationId, busy, askConfirm, showToast }) {
  const [state, setState] = useState({ loading: true, repos: [], error: '' });
  const [patch, setPatch] = useState('');
  const [pending, setPending] = useState(false);

  async function load() {
    setState(s => ({ ...s, loading: true }));
    try {
      const res = await fetch(`${API}/api/conversations/${conversationId}/handoff`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Não foi possível ler o estado do repositório.');
      setState({ loading: false, repos: data.repos || [], error: '' });
    } catch (err) {
      setState({ loading: false, repos: [], error: err.message || 'Não foi possível ler o estado do repositório.' });
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [conversationId, busy]);

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      showToast?.('Comando copiado.', 'ok');
    } catch {
      // Sem permissão de área de transferência (http, navegador antigo): o
      // comando continua visível e selecionável na tela.
      showToast?.('Não foi possível copiar — selecione o comando e copie à mão.');
    }
  }

  // Download por fetch (e não por <a href>) para que uma recusa do backend vire
  // um aviso legível, em vez de um JSON cru numa aba nova.
  async function baixarPatch(repo) {
    try {
      const res = await fetch(`${API}/api/conversations/${conversationId}/handoff/patch?repo=${encodeURIComponent(repo)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Não foi possível gerar o patch.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${repo}.patch`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast?.(err.message || 'Não foi possível gerar o patch.');
    }
  }

  async function aplicar(repo) {
    const ok = await askConfirm({
      title: 'Aplicar patch na tarefa',
      message: `Aplicar este patch no repositório "${repo}" da tarefa?\n\nEle escreve nos arquivos do clone desta conversa. Se não casar com o estado atual, nada é alterado.`,
      confirmLabel: 'Aplicar'
    });
    if (!ok) return;
    setPending(true);
    try {
      const res = await fetch(`${API}/api/conversations/${conversationId}/handoff/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, patch })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Não foi possível aplicar o patch.');
      showToast?.(`Patch aplicado em ${data.files.length} arquivo${data.files.length > 1 ? 's' : ''}.`, 'ok');
      setPatch('');
      load();
    } catch (err) {
      showToast?.(err.message || 'Não foi possível aplicar o patch.');
    } finally {
      setPending(false);
    }
  }

  if (state.loading) return <p className="devRailHint"><Loader size={13} className="esSpin"/> Lendo o repositório da tarefa…</p>;
  if (state.error) return <p className="devRailHint">{state.error}</p>;
  if (!state.repos.length) return <p className="devRailHint">Sem repositório git nesta conversa — o handoff precisa de um clone (github_clone).</p>;

  return (
    <div className="handoff">
      {state.repos.map(repo => {
        const info = handoffState(repo);
        return (
          <div className="handoffRepo" key={repo.name}>
            <div className="handoffHead">
              <Laptop size={14}/><b>{repo.name}</b>
              {repo.branch && <span className="devChangeBranch">{repo.branch}</span>}
            </div>
            <p className="devRailHint">{info.summary}</p>

            {(info.canWorktree || info.canPatch) && <>
              <h5 className="handoffTitle">Levar para o meu computador</h5>
              <ol className="handoffCmds">
                {repo.commands.toLocal.map((item, i) => <Comando key={i} item={item} onCopy={copiar}/>)}
              </ol>
              {info.canPatch && (
                <button type="button" className="devIconBtn handoffDownload" onClick={() => baixarPatch(repo.name)}>
                  <Download size={13}/> Baixar {repo.name}.patch
                </button>
              )}
            </>}

            <h5 className="handoffTitle">Trazer do meu computador</h5>
            <ol className="handoffCmds">
              {repo.commands.toWorktree.map((item, i) => <Comando key={i} item={item} onCopy={copiar}/>)}
            </ol>
            <textarea
              className="handoffPatch"
              value={patch}
              onChange={e => setPatch(e.target.value)}
              spellCheck={false}
              placeholder="Cole aqui o conteúdo inteiro do arquivo .patch gerado no seu computador"
              aria-label={`Patch para aplicar no repositório ${repo.name}`}/>
            <button type="button" className="devIconBtn" disabled={pending || !patch.trim()} onClick={() => aplicar(repo.name)}>
              <Upload size={13}/> {pending ? 'Aplicando…' : 'Aplicar no repositório da tarefa'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
