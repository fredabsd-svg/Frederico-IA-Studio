import React, { useState } from 'react';
import { Drawer } from '../components.jsx';
import { SlidersHorizontal, Palette, Bot, Sparkles, KeyRound, Code2, Cable, FolderCog, CalendarClock, Brain, ShieldCheck, BarChart3, Bug, HardDriveDownload, Gauge, Inbox, ChevronRight } from 'lucide-react';

// Aba central de Configurações (repaginação — seção 3): reúne num só lugar o que
// estava espalhado pelo app, organizado por categoria. Cada item apenas ABRE o
// painel existente (não reescreve nada), preservando as funcionalidades.
const ICONS = {
  aparencia: Palette, copiloto: Bug, assistentes: Sparkles, provedor: KeyRound,
  dev: Code2, conectores: Cable, pastas: FolderCog, rotinas: CalendarClock,
  memoria: Brain, privacidade: ShieldCheck, analises: BarChart3, inbox: Inbox,
  backup: HardDriveDownload, gratuito: Gauge, agente: Bot,
};

export function SettingsHub({ onClose, actions = {}, isAdmin, pcFoldersEnabled, freeConfigured }) {
  const TABS = [
    { id: 'geral', label: 'Geral', items: [
      { id: 'aparencia', label: 'Aparência e tema', desc: 'Paleta, espaço de trabalho e densidade.' },
    ] },
    { id: 'agente', label: 'Agente', items: [
      { id: 'copiloto', label: 'Copiloto', desc: 'Diagnósticos, saúde do sistema e permissões/autonomia. (O personagem e a proatividade ficam na engrenagem do Companion.)' },
    ] },
    { id: 'ia', label: 'Inteligência artificial', items: [
      { id: 'provedor', label: 'Provedor de IA', desc: 'Suas chaves de API e provedores.' },
      { id: 'assistentes', label: 'Assistentes', desc: 'Crie e edite assistentes especializados.' },
    ] },
    { id: 'dev', label: 'Desenvolvimento', items: [
      { id: 'dev', label: 'Modo desenvolvedor', desc: 'Planejar, implementar, corrigir e revisar projetos.' },
      { id: 'conectores', label: 'Conectores', desc: 'GitHub e outros serviços externos.' },
      pcFoldersEnabled && { id: 'pastas', label: 'Pastas do PC', desc: 'Libere pastas locais para o assistente.' },
      { id: 'rotinas', label: 'Rotinas', desc: 'Tarefas que rodam sozinhas em horários.' },
    ] },
    { id: 'privacidade', label: 'Privacidade e dados', items: [
      { id: 'memoria', label: 'Memória', desc: 'O que o assistente lembra — ver, editar, apagar.' },
      { id: 'privacidade', label: 'Privacidade e dados (LGPD)', desc: 'Exportar, apagar histórico ou excluir a conta.' },
      { id: 'analises', label: 'Análises de uso', desc: 'Tokens, custos e consumo por modelo.' },
    ] },
    { id: 'avancado', label: 'Avançado', items: [
      { id: 'inbox', label: 'Caixa de entrada', desc: 'Itens e notificações do app.' },
      isAdmin && { id: 'backup', label: 'Backup completo', desc: 'Banco + workspaces (somente administrador).' },
      (isAdmin && freeConfigured) && { id: 'gratuito', label: 'Modo gratuito', desc: 'Usuários, consumo e limites (somente administrador).' },
    ] },
  ];
  const [tab, setTab] = useState('geral');
  const current = TABS.find(t => t.id === tab) || TABS[0];

  const run = (id) => { const fn = actions[id]; if (fn) { fn(); onClose?.(); } };

  return (
    <Drawer title="Configurações" icon={<SlidersHorizontal size={18} />} onClose={onClose} className="settingsHub">
      <div className="shubTabs">
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="shubItems">
        {current.items.filter(Boolean).map(it => {
          const Icon = ICONS[it.id] || SlidersHorizontal;
          const available = !!actions[it.id];
          return (
            <button key={it.id} className="shubItem" disabled={!available} onClick={() => run(it.id)}>
              <span className="shubIcon"><Icon size={18} /></span>
              <span className="shubInfo"><b>{it.label}</b><small>{it.desc}</small></span>
              <ChevronRight size={16} className="shubChevron" />
            </button>
          );
        })}
      </div>
    </Drawer>
  );
}
