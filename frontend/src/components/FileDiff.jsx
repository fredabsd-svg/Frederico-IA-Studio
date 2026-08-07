import React, { useEffect, useState } from 'react';
import { Loader, RotateCcw, X } from 'lucide-react';
import { API } from '../constants.js';

// Diff de UM arquivo, em hunks, com reversão (Fase 27).
//
// Abre a partir da aba "Alterações" (ChangeSet real). Cada hunk pode ser
// desfeito isoladamente — o backend reverte com `git apply --reverse` e recusa
// se o arquivo mudou desde a leitura, então o pior caso é "recarregue e tente
// de novo", nunca um patch aplicado no lugar errado.
//
// Reverter é DESTRUTIVO sobre trabalho não commitado: cada ação passa por
// confirmação explícita, com o alvo nomeado.

export function FileDiff({ conversationId, repo, file, onClose, onReverted, askConfirm, showToast }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [pending, setPending] = useState(false);

  async function load() {
    setState({ loading: true, data: null, error: '' });
    try {
      const params = new URLSearchParams({ repo, file });
      const res = await fetch(`${API}/api/conversations/${conversationId}/diff?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Não foi possível ler o diff.');
      setState({ loading: false, data, error: '' });
    } catch (err) {
      setState({ loading: false, data: null, error: err.message || 'Não foi possível ler o diff.' });
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [conversationId, repo, file]);

  async function reverter(hunkIndex) {
    const alvo = hunkIndex == null
      ? `todas as alterações de ${file}`
      : `o trecho ${hunkIndex + 1} de ${file}`;
    const ok = await askConfirm({
      title: 'Desfazer alteração',
      message: `Desfazer ${alvo}?\n\nIsto descarta o trabalho não commitado desse trecho e não pode ser desfeito pelo aplicativo.`,
      confirmLabel: 'Desfazer'
    });
    if (!ok) return;
    setPending(true);
    try {
      const res = await fetch(`${API}/api/conversations/${conversationId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, file, ...(hunkIndex == null ? {} : { hunkIndex }) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Não foi possível desfazer.');
      showToast?.(data.removed ? 'Arquivo novo descartado.' : 'Alteração desfeita.', 'ok');
      onReverted?.();
      if (data.removed || hunkIndex == null) onClose?.();
      else load();
    } catch (err) {
      showToast?.(err.message || 'Não foi possível desfazer.');
    } finally {
      setPending(false);
    }
  }

  const hunks = state.data?.hunks || [];
  return (
    <div className="fileDiff">
      <div className="fileDiffHead">
        <code title={file}>{file}</code>
        {state.data?.untracked && <span className="devFileKind">novo</span>}
        <button type="button" className="devIconBtn" disabled={pending} onClick={() => reverter(null)}
          title="Desfazer todas as alterações deste arquivo">
          <RotateCcw size={13}/> Desfazer tudo
        </button>
        <button type="button" className="devIconBtn" onClick={onClose} aria-label="Fechar o diff"><X size={14}/></button>
      </div>
      {state.loading && <p className="devRailHint"><Loader size={13} className="esSpin"/> Lendo o diff…</p>}
      {state.error && <p className="devRailHint">{state.error}</p>}
      {!state.loading && !state.error && !hunks.length && <p className="devRailHint">Sem alterações neste arquivo.</p>}
      {hunks.map(hunk => (
        <div className="diffHunk" key={hunk.index}>
          <div className="diffHunkHead">
            <code>{hunk.header}</code>
            <span className="diffHunkStat"><ins>+{hunk.additions}</ins> <del>−{hunk.deletions}</del></span>
            {!state.data?.untracked && (
              <button type="button" className="devIconBtn" disabled={pending} onClick={() => reverter(hunk.index)}
                title="Desfazer apenas este trecho">
                <RotateCcw size={12}/> Desfazer trecho
              </button>
            )}
          </div>
          <pre className="diffBody">
            {hunk.lines.map((line, i) => (
              <span key={i} className={line.startsWith('+') ? 'diffAdd' : line.startsWith('-') ? 'diffDel' : 'diffCtx'}>{line || ' '}{'\n'}</span>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
