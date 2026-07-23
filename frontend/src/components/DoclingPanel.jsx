import React, { useState } from 'react';
import { API } from '../constants.js';
import { FileText, Table, ScanLine, Coins, RefreshCw, AlertTriangle, CheckCircle2, Loader2, Braces } from 'lucide-react';

// Painel de compreensão documental (Docling): mostra, por documento processado,
// o andamento e as estatísticas (páginas, tabelas, OCR, economia de tokens) e dá
// acesso ao Markdown otimizado e ao JSON completo. Fica no drawer de arquivos.
// Só aparece quando a camada está ligada e há documentos.

const STATUS_LABEL = {
  queued: 'Na fila', processing: 'Processando…', done: 'Pronto',
  done_warnings: 'Pronto (com alertas)', partial: 'Parcial', failed: 'Falhou',
};
const STAGE_LABEL = {
  recebido: 'Enviando documento', analisando: 'Analisando estrutura',
  convertendo: 'Extraindo conteúdo', exportando: 'Gerando Markdown',
  'concluído': 'Documento pronto', cache: 'Recuperado do cache',
};

function StatusIcon({ status }) {
  if (status === 'processing' || status === 'queued') return <Loader2 size={15} className="spinIcon" />;
  if (status === 'failed') return <AlertTriangle size={15} />;
  if (status === 'done_warnings' || status === 'partial') return <AlertTriangle size={15} />;
  return <CheckCircle2 size={15} />;
}

export function DoclingPanel({ docs = [], onReprocess }) {
  const [openMd, setOpenMd] = useState(null); // { id, text }
  if (!docs.length) return null;

  async function viewMarkdown(id) {
    try {
      const r = await fetch(`${API}/api/docling/documents/${encodeURIComponent(id)}/markdown`);
      const text = r.ok ? await r.text() : 'Markdown indisponível.';
      setOpenMd({ id, text });
    } catch { setOpenMd({ id, text: 'Erro ao carregar.' }); }
  }

  return (
    <div className="doclingPanel">
      <div className="doclingHead"><FileText size={14} /> Compreensão documental (Docling)</div>
      {docs.map(d => {
        const st = d.stats || {};
        return (
          <div key={d.id} className={`doclingDoc status-${d.status}`}>
            <div className="doclingDocTop">
              <span className="doclingName" title={d.filename}><StatusIcon status={d.status} /> {d.filename || 'documento'}</span>
              <span className="doclingStatus">{STATUS_LABEL[d.status] || d.status}</span>
            </div>

            {(d.status === 'processing' || d.status === 'queued') && (
              <div className="doclingStage">{STAGE_LABEL[st.stage] || 'Preparando conteúdo para a IA…'}</div>
            )}

            {['done', 'done_warnings', 'partial'].includes(d.status) && (
              <>
                <div className="doclingStats">
                  <span title="Páginas"><FileText size={12} /> {d.pageCount ?? st.pages ?? '?'} pág.</span>
                  <span title="Tabelas"><Table size={12} /> {d.tableCount ?? st.tables ?? 0} tab.</span>
                  {d.ocrUsed && <span title="OCR aplicado"><ScanLine size={12} /> OCR</span>}
                  {typeof st.savedPercent === 'number' && (
                    <span title="Economia de tokens vs. conteúdo integral"><Coins size={12} /> −{st.savedPercent}% tokens</span>
                  )}
                </div>
                {typeof st.tokensOptimized === 'number' && (
                  <div className="doclingTokens">
                    {st.tokensOriginal?.toLocaleString('pt-BR')} → <strong>{st.tokensOptimized?.toLocaleString('pt-BR')}</strong> tokens enviados
                  </div>
                )}
                <div className="doclingActions">
                  <button onClick={() => viewMarkdown(d.id)}><FileText size={13} /> Markdown</button>
                  <a href={`${API}/api/docling/documents/${encodeURIComponent(d.id)}/json`} target="_blank" rel="noreferrer"><Braces size={13} /> JSON</a>
                  <button onClick={() => onReprocess?.(d.id)}><RefreshCw size={13} /> Reprocessar</button>
                </div>
              </>
            )}

            {d.status === 'failed' && (
              <div className="doclingError">
                {d.error || 'Não foi possível processar. O modelo pode ler o arquivo pelo método tradicional.'}
                <button onClick={() => onReprocess?.(d.id)}><RefreshCw size={12} /> Tentar de novo</button>
              </div>
            )}
          </div>
        );
      })}

      {openMd && (
        <div className="doclingMdModal" onClick={() => setOpenMd(null)}>
          <div className="doclingMdBox" onClick={e => e.stopPropagation()}>
            <div className="doclingMdHead">Markdown enviado à IA <button onClick={() => setOpenMd(null)}>Fechar</button></div>
            <pre>{openMd.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
