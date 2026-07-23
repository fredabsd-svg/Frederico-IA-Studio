import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../constants.js';

// Estado do processamento documental (Docling) da conversa: descobre se a
// camada está ligada e acompanha o andamento de cada documento. Faz poll leve
// enquanto houver documento em processamento; para assim que tudo conclui.
// Se o Docling estiver desligado, o hook fica inerte (a UI simplesmente não
// mostra nada) — zero impacto no fluxo atual.

const ACTIVE = new Set(['queued', 'processing']);

export function useDocling(conversationId) {
  const [enabled, setEnabled] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [config, setConfig] = useState(null); // { options, overrides }
  const [health, setHealth] = useState(null);
  const [docs, setDocs] = useState([]);
  const timer = useRef(null);

  // Descobre o estado da camada (ligada? admin? config? saúde do serviço).
  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/docling/status`);
      if (!r.ok) return;
      const d = await r.json();
      setEnabled(!!d.enabled);
      setIsAdmin(!!d.isAdmin);
      setConfig({ options: d.options || {}, overrides: d.overrides || {} });
      setHealth(d.health || null);
    } catch {}
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Salva a configuração (somente admin). Recarrega o status ao concluir.
  const saveConfig = useCallback(async (overrides) => {
    const r = await fetch(`${API}/api/docling/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides || {}),
    });
    if (r.ok) await loadStatus();
    return r.ok;
  }, [loadStatus]);

  const refresh = useCallback(async () => {
    if (!conversationId) { setDocs([]); return []; }
    try {
      const r = await fetch(`${API}/api/docling/conversations/${encodeURIComponent(conversationId)}/documents`);
      if (!r.ok) return [];
      const rows = await r.json();
      setDocs(Array.isArray(rows) ? rows : []);
      return rows;
    } catch { return []; }
  }, [conversationId]);

  // Poll enquanto ligado e com documento ativo (ou logo após trocar de conversa).
  useEffect(() => {
    if (!enabled || !conversationId) return;
    let alive = true;
    const tick = async () => {
      const rows = await refresh();
      if (!alive) return;
      const anyActive = rows.some(d => ACTIVE.has(d.status));
      clearTimeout(timer.current);
      // 2s enquanto processa, 20s em repouso (para captar novos uploads).
      timer.current = setTimeout(tick, anyActive ? 2000 : 20000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer.current); };
  }, [enabled, conversationId, refresh]);

  const reprocess = useCallback(async (id) => {
    try { await fetch(`${API}/api/docling/documents/${encodeURIComponent(id)}/reprocess`, { method: 'POST' }); await refresh(); } catch {}
  }, [refresh]);

  const processing = docs.some(d => ACTIVE.has(d.status));
  return { enabled, isAdmin, config, health, docs, processing, refresh, reprocess, saveConfig };
}
