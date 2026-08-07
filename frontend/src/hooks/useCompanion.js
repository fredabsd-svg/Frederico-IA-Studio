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
  characterName: 'Nino',
  assistantId: null,
  model: '',
  mode: 'auxiliar',
  animationLevel: 'completo',
  permissionLevel: 1,
  voice: false,
  proactiveAlerts: true,
  proactiveWriting: true,
  writingSensitivity: 'media',
};

export function useCompanion({ tasks = [], uploads = [], devConversationId = null, showToast } = {}) {
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

  // Recarrega só a lista de eventos (poll leve) para refletir os alertas que o
  // monitoramento do backend cria de forma assíncrona.
  const refreshEvents = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/companion/events`);
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows)) setEvents(rows);
    } catch { /* silencioso */ }
  }, []);

  // Poll dos eventos enquanto o Companion está ativo (barato: só GET). Para
  // quando desativado para não bater no servidor à toa.
  useEffect(() => {
    if (!settings.enabled) return;
    const id = setInterval(refreshEvents, 45_000);
    return () => clearInterval(id);
  }, [settings.enabled, refreshEvents]);

  // Monitoramento de Git: enquanto há uma conversa de desenvolvimento ativa e o
  // modo permite intervir, verifica periodicamente se há alterações sem commit /
  // commits sem push. O backend cuida da deduplicação (não repete o alerta).
  useEffect(() => {
    const s = settingsRef.current;
    const canWatch = s.enabled && s.proactiveAlerts && ['auxiliar', 'proativo'].includes(s.mode);
    if (!canWatch || !devConversationId) return;
    let stopped = false;
    async function tick() {
      try {
        const res = await fetch(`${API}/api/companion/monitor/git`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: devConversationId }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.event && !stopped) setEvents(prev => [data.event, ...prev.filter(e => e.id !== data.event.id)]);
        }
      } catch { /* silencioso */ }
    }
    const first = setTimeout(tick, 8_000); // dá tempo do sandbox/clonagem
    const id = setInterval(tick, 90_000);
    return () => { stopped = true; clearTimeout(first); clearInterval(id); };
  }, [devConversationId, settings.enabled, settings.mode, settings.proactiveAlerts]);

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
  const seenUploads = useRef(new Set());
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

  // Antecipação por metadados: novos anexos geram uma proposta útil sem enviar
  // o conteúdo do arquivo ao Nino. A primeira carga é apenas registrada para
  // não transformar arquivos antigos em uma enxurrada de alertas.
  const bootstrappedUploads = useRef(false);
  useEffect(() => {
    const list = Array.isArray(uploads) ? uploads : [];
    const entries = list.map(f => ({ file: f, key: String(f.id || f.path || f.name || '') })).filter(item => item.key);
    const keys = entries.map(item => item.key);
    if (!bootstrappedUploads.current) {
      keys.forEach(key => seenUploads.current.add(key));
      bootstrappedUploads.current = true;
      return;
    }
    const fresh = entries.filter(item => !seenUploads.current.has(item.key)).map(item => item.file);
    keys.forEach(key => seenUploads.current.add(key));
    const s = settingsRef.current;
    if (!fresh.length || !s.enabled || !s.proactiveAlerts || !['auxiliar', 'proativo'].includes(s.mode)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/companion/suggestions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: fresh.map(f => ({ name: f.name, path: f.path, mime: f.mime, size: f.size })) }),
        });
        if (!res.ok || cancelled) return;
        const suggestions = await res.json();
        for (const item of suggestions.slice(0, 3)) {
          if (cancelled) break;
          await addEvent({
            kind: `antecipacao_${item.id || 'intencao'}`, level: item.severity || 'info',
            title: 'Posso antecipar o próximo passo', detail: item.suggestion,
            origin: 'metadados_do_anexo', proposedAction: item.action?.label || item.suggestion,
            authorization: item.action ? 'Aguardando sua confirmação' : 'Nenhuma ação executada sem sua confirmação',
          });
        }
      } catch { /* sugestão não bloqueia o upload */ }
    })();
    return () => { cancelled = true; };
  }, [uploads, addEvent, settings.enabled, settings.mode, settings.proactiveAlerts]);

  return {
    settings, persona, events, options, ready,
    saveSettings, addEvent, dismissEvent, resolveEvent, dismissAll, reload: load, refreshEvents,
  };
}
