import React, { useState } from 'react';
import { API } from '../constants.js';
import { FileText, Table, ScanLine, Coins, RefreshCw, AlertTriangle, CheckCircle2, Loader2, Braces, Sparkles, Settings, Image } from 'lucide-react';

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

export function DoclingPanel({ docs = [], onReprocess, isAdmin = false, config = null, health = null, onSaveConfig }) {
  const [openMd, setOpenMd] = useState(null);   // { id, text }
  const [tables, setTables] = useState(null);   // { id, list }
  const [pics, setPics] = useState(null);       // { id, list }
  if (!docs.length && !isAdmin) return null;

  async function viewMarkdown(id) {
    try {
      const r = await fetch(`${API}/api/docling/documents/${encodeURIComponent(id)}/markdown`);
      const text = r.ok ? await r.text() : 'Markdown indisponível.';
      setOpenMd({ id, text });
    } catch { setOpenMd({ id, text: 'Erro ao carregar.' }); }
  }

  async function viewTables(id) {
    if (tables?.id === id) { setTables(null); return; }
    try {
      const r = await fetch(`${API}/api/docling/documents/${encodeURIComponent(id)}/tables`);
      setTables({ id, list: r.ok ? await r.json() : [] });
    } catch { setTables({ id, list: [] }); }
  }

  async function viewPictures(id) {
    if (pics?.id === id) { setPics(null); return; }
    try {
      const r = await fetch(`${API}/api/docling/documents/${encodeURIComponent(id)}/pictures`);
      setPics({ id, list: r.ok ? await r.json() : [] });
    } catch { setPics({ id, list: [] }); }
  }

  return (
    <div className="doclingPanel">
      <div className="doclingHead"><FileText size={14} /> Compreensão documental (Docling)</div>
      {isAdmin && <DoclingAdmin config={config} health={health} onSave={onSaveConfig} />}
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
                  <span title="Tabelas"><Table size={12} /> {d.tableCount ?? st.tables ?? 0} tab.{st.tablesWithWarnings > 0 ? ` (${st.tablesWithWarnings} alerta)` : ''}</span>
                  {d.ocrUsed && <span title="OCR aplicado"><ScanLine size={12} /> OCR</span>}
                  {st.pictureCount > 0 && <span title="Elementos visuais (gráficos, assinaturas, selos)"><Image size={12} /> {st.pictureCount} visual{st.pictureCount > 1 ? 'is' : ''}</span>}
                  {st.semantic && <span title="Busca semântica ativa (seleção dos trechos por relevância)"><Sparkles size={12} /> semântica</span>}
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
                  {(d.tableCount ?? st.tables ?? 0) > 0 && <button onClick={() => viewTables(d.id)}><Table size={13} /> Tabelas</button>}
                  {st.pictureCount > 0 && <button onClick={() => viewPictures(d.id)}><Image size={13} /> Visuais</button>}
                  <a href={`${API}/api/docling/documents/${encodeURIComponent(d.id)}/json`} target="_blank" rel="noreferrer"><Braces size={13} /> JSON</a>
                  <button onClick={() => onReprocess?.(d.id)}><RefreshCw size={13} /> Reprocessar</button>
                </div>
                {pics?.id === d.id && (
                  <div className="doclingPics">
                    {!pics.list.length && <div className="doclingTablesEmpty">Nenhum elemento visual detalhado.</div>}
                    {pics.list.map(p => (
                      <div key={p.index} className="doclingPic">
                        {p.hasImage
                          ? <a href={`${API}/api/docling/documents/${encodeURIComponent(d.id)}/pictures/${p.index}`} target="_blank" rel="noreferrer"><img src={`${API}/api/docling/documents/${encodeURIComponent(d.id)}/pictures/${p.index}`} alt={`Figura ${p.index}`} loading="lazy" /></a>
                          : <div className="doclingPicMissing" title={p.note || ''}>⚠ sem imagem</div>}
                        <span>pág. {p.page ?? '?'}</span>
                      </div>
                    ))}
                  </div>
                )}
                {tables?.id === d.id && (
                  <div className="doclingTables">
                    {!tables.list.length && <div className="doclingTablesEmpty">Nenhuma tabela detalhada.</div>}
                    {tables.list.map(tb => (
                      <div key={tb.index} className={`doclingTableRow ${tb.ok ? '' : 'warn'}`}>
                        <span>Tabela {tb.index} · pág. {tb.page} · {tb.rows}×{tb.cols}{tb.ok ? '' : ' · ⚠ inconsistente'}</span>
                        <a href={`${API}/api/docling/documents/${encodeURIComponent(d.id)}/tables/${tb.index}/csv`} target="_blank" rel="noreferrer">CSV</a>
                      </div>
                    ))}
                  </div>
                )}
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

// Configuração administrativa (só admin): OCR, idioma, tabelas, fórmulas,
// limite de páginas e tamanho de chunk. Alterar reprocessa sob demanda.
function DoclingAdmin({ config, health, onSave }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const base = config?.options || {};
  const cur = form || base;
  const set = (patch) => setForm({ ...cur, ...patch });

  async function save() {
    setSaving(true); setSaved(false);
    const ok = await onSave?.({
      ocr: cur.ocr, lang: cur.lang, tables: cur.tables,
      formulas: cur.formulas, maxPages: cur.maxPages, maxChunkTokens: cur.maxChunkTokens,
    });
    setSaving(false);
    if (ok) { setSaved(true); setForm(null); setTimeout(() => setSaved(false), 2500); }
  }

  const healthLabel = health?.disabled ? 'desligado'
    : health?.ok ? (health.models_loaded ? 'no ar · modelos carregados' : 'no ar · carregando modelos') : 'indisponível';

  return (
    <div className="doclingAdmin">
      <button className="doclingAdminToggle" onClick={() => setOpen(o => !o)}>
        <Settings size={13} /> Configurações (admin)
        <span className={`doclingHealth ${health?.ok ? 'ok' : 'off'}`}>serviço: {healthLabel}</span>
      </button>
      {open && (
        <div className="doclingAdminBody">
          <label>OCR
            <select value={cur.ocr || 'auto'} onChange={e => set({ ocr: e.target.value })}>
              <option value="auto">Automático (só quando precisar)</option>
              <option value="always">Sempre (força OCR em tudo)</option>
              <option value="never">Nunca (só texto nativo)</option>
            </select>
          </label>
          <label>Idioma do OCR
            <input value={cur.lang ?? 'por'} onChange={e => set({ lang: e.target.value })} placeholder="por (ou por+eng)" />
          </label>
          <label className="row"><input type="checkbox" checked={cur.tables ?? true} onChange={e => set({ tables: e.target.checked })} /> Extrair tabelas</label>
          <label className="row"><input type="checkbox" checked={cur.formulas ?? false} onChange={e => set({ formulas: e.target.checked })} /> Processar fórmulas (mais lento)</label>
          <label>Limite de páginas (0 = sem limite)
            <input type="number" min="0" value={cur.maxPages ?? 0} onChange={e => set({ maxPages: Number(e.target.value) })} />
          </label>
          <label>Tokens por chunk
            <input type="number" min="200" max="8000" value={cur.maxChunkTokens ?? 1200} onChange={e => set({ maxChunkTokens: Number(e.target.value) })} />
          </label>
          <div className="doclingAdminActions">
            <button className="primary" onClick={save} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</button>
            {saved && <span className="doclingSaved">✓ salvo — novos documentos usam a nova config</span>}
          </div>
        </div>
      )}
    </div>
  );
}
