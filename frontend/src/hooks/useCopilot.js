import { useCallback, useState } from 'react';
import { API } from '../constants.js';

// Dados do copiloto para as telas (Central de Diagnósticos, Saúde, Permissões).
// Consome as APIs já existentes (/companion/incidents, /health, /permissions).
// Carrega sob demanda quando o painel abre — nada de polling desnecessário.
export function useCopilot() {
  const [incidents, setIncidents] = useState([]);
  const [health, setHealth] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadIncidents = useCallback(async () => {
    try { const r = await fetch(`${API}/api/companion/incidents`); if (r.ok) setIncidents(await r.json()); } catch {}
  }, []);
  const loadHealth = useCallback(async () => {
    try { const r = await fetch(`${API}/api/companion/health`); if (r.ok) setHealth(await r.json()); } catch {}
  }, []);
  const loadPermissions = useCallback(async () => {
    try { const r = await fetch(`${API}/api/companion/permissions`); if (r.ok) setPermissions(await r.json()); } catch {}
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadIncidents(), loadHealth(), loadPermissions()]);
    setLoading(false);
  }, [loadIncidents, loadHealth, loadPermissions]);

  const updateIncident = useCallback(async (id, patch) => {
    try { await fetch(`${API}/api/companion/incidents/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); await loadIncidents(); } catch {}
  }, [loadIncidents]);

  const savePermissions = useCallback(async (patch) => {
    try {
      const r = await fetch(`${API}/api/companion/permissions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (r.ok) await loadPermissions();
      return r.ok;
    } catch { return false; }
  }, [loadPermissions]);

  const emergencyStop = useCallback(async () => {
    try { await fetch(`${API}/api/companion/permissions/emergency-stop`, { method: 'POST' }); await loadPermissions(); } catch {}
  }, [loadPermissions]);

  return { incidents, health, permissions, loading, loadAll, loadIncidents, loadHealth, loadPermissions, updateIncident, savePermissions, emergencyStop };
}
