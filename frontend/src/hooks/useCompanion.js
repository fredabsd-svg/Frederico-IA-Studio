import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../constants.js';

// Estado do Frederico Companion: carrega/salva a configuração e a fila de
// eventos (alertas) do backend, e faz a detecção proativa mínima do MVP —
// transforma falhas de tarefas em alertas discretos, respeitando o modo de
// comportamento escolhido (seção 5) e a permissão de alertas proativos.
//
// A inteligência real continua no núcleo do Studio; aqui só orquestramos a
// camada de experiência e a persistência do estado do personagem.

const DEFAULTS = {
  enabled: true,
  characterName: 'Luma',
  assistantId: null,
  model: '',
  mode: 'auxiliar',
  animationLevel: 'completo',
  permissionLevel: 1,
  voice: false,
  proactiveAlerts: true,
};

export function useCompanion({ tasks = [], showToast } = {}) {
  const [settings, setSettings] = useState(DEFAULTS);
  const [persona, setPersona] = useState(null);
  const [events, setEvents] = useState([]);
  const [options, setOptions] = useState({ modes: [], animationLevels: [], characterPresets: [] });
  const [ready, setReady] = useState(false);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/companion`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.settings) setSettings({ ...DEFAULTS, ...data.settings });
      setPersona(data?.persona || null);
      setEvents(Array.isArray(data?.events) ? data.events : []);
      if (data?.options) setOptions(data.options);
      setReady(true);
    } catch { /* offline: mantém padrões locais */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Salva a configuração (merge otimista + persistência). Devolve a persona
  // resolvida pelo servidor para refletir troca de assistente na hora.
  const saveSettings = useCallback(async (patch) => {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next); // otimista — a interface responde imediatamente
    try {
      const res = await fetch(`${API}/api/companion`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.settings) setSettings({ ...DEFAULTS, ...data.settings });
        setPersona(data?.persona || null);
      }
    } catch {
      showToast?.('Não foi possível salvar a configuração do Companion.');
    }
  }, [showToast]);

  const addEvent = useCallback(async (evt) => {
    try {
      const res = await fetch(`${API}/api/companion/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evt),
      });
      if (res.ok) {
        const created = await res.json();
        setEvents(prev => [created, ...prev.filter(e => e.id !== created.id)]);
        return created;
      }
    } catch { /* silencioso */ }
    return null;
  }, []);

  const patchEvent = useCallback(async (id, patch) => {
    // Otimista: some da lista quando dispensado/resolvido.
    setEvents(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e)
      .filter(e => !['dispensado', 'resolvido'].includes(e.status)));
    try {
      await fetch(`${API}/api/companion/events/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch { /* silencioso */ }
  }, []);

  const dismissEvent = useCallback((id) => patchEvent(id, { status: 'dispensado' }), [patchEvent]);
  const resolveEvent = useCallback((id, result) => patchEvent(id, { status: 'resolvido', result }), [patchEvent]);

  const dismissAll = useCallback(async () => {
    setEvents([]);
    try { await fetch(`${API}/api/companion/events/dismiss-all`, { method: 'POST' }); } catch {}
  }, []);

  // ---- Detecção proativa (MVP): tarefas que passaram a falhar viram alerta.
  // Só dispara nos modos que permitem intervenção e com alertas proativos
  // ligados — nunca em "silencioso", "foco" ou "apresentacao" (seção 5).
  const seenTaskErrors = useRef(new Set());
  const bootstrapped = useRef(false);
  useEffect(() => {
    const s = settingsRef.current;
    const proactiveOn = s.enabled && s.proactiveAlerts && ['auxiliar', 'proativo'].includes(s.mode);
    // Na primeira passada apenas registra o estado atual: não queremos alertar
    // sobre falhas que já existiam antes do usuário abrir o app.
    if (!bootstrapped.current) {
      for (const t of tasks) if (t.status === 'error') seenTaskErrors.current.add(t.id);
      bootstrapped.current = true;
      return;
    }
    for (const t of tasks) {
      if (t.status !== 'error' || seenTaskErrors.current.has(t.id)) continue;
      seenTaskErrors.current.add(t.id);
      if (!proactiveOn) continue;
      addEvent({
        kind: 'tarefa_falhou',
        level: 'aviso',
        title: 'Uma tarefa em segundo plano falhou',
        detail: t.error ? String(t.error).slice(0, 400) : (t.conv_title ? `Tarefa em "${t.conv_title}" não foi concluída.` : 'Uma tarefa não foi concluída.'),
        origin: 'app',
        project: t.conv_title || null,
        proposedAction: 'Posso abrir a conversa e investigar a causa provável.',
        authorization: 'Nível 1 — somente leitura',
      });
    }
  }, [tasks, addEvent]);

  return {
    settings, persona, events, options, ready,
    saveSettings, addEvent, dismissEvent, resolveEvent, dismissAll, reload: load,
  };
}
