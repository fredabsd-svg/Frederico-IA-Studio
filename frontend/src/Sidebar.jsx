import React from 'react';
import { Plus, Search, X, Trash2, Wrench, Inbox, BookMarked, LayoutTemplate, Code2, ListTodo, CalendarClock, Bot, SlidersHorizontal, PanelLeft, LogOut } from 'lucide-react';
import { ClientPicker } from './components/ClientPicker.jsx';

export function Sidebar({
  user,
  conversations, allConvs, current, runs,
  openConversation, startNewChat, deleteConversation,
  clients, clientId, switchClient, addClient, removeClient,
  menuOpen, setMenuOpen,
  sideHidden, toggleSide,
  convFilter, setConvFilter,
  sideScrollRef,
  workspace,
  onOpenTools, onOpenInbox, onOpenTemplates, onOpenDesign,
  onOpenDeveloper, onOpenTasks, onOpenRoutines,
  onOpenAssistants, onOpenSettings,
  tasksActive, tasks,
  onPollTasks,
  onSignOut
}) {
  return (
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Navegação do app">
      <div className="brandRow">
        <div className="brandLead">
          <span className="brandMark" aria-hidden="true">F</span>
          <div className="brand">Frederico <span>AI Studio</span></div>
        </div>
        <button className="sideCollapse" onClick={toggleSide} title="Esconder a barra lateral" aria-label="Esconder a barra lateral"><PanelLeft size={17}/></button>
      </div>
      <button className="new" onClick={startNewChat}><Plus size={16}/> Nova conversa</button>
      <div className="clientLabel">Cliente ou projeto</div>
      <ClientPicker clients={clients} clientId={clientId} onPick={switchClient} onAdd={addClient} onRemove={removeClient}/>
      <div className="convSearch">
        <Search size={15}/>
        <input value={convFilter} onChange={e => setConvFilter(e.target.value)} placeholder="Buscar conversas..."/>
        {convFilter && <button className="convSearchX" onClick={() => setConvFilter('')} aria-label="Limpar busca"><X size={13}/></button>}
      </div>
      <div className="sideScroll" ref={sideScrollRef}>
      <div className="sideSectionTitle">Conversas</div>
      <div className="convList">
        {(() => {
          const q = convFilter.trim().toLowerCase();
          const list = q ? allConvs.filter(c => (c.title || '').toLowerCase().includes(q)) : conversations;
          const otherCount = allConvs.length - conversations.length;
          if (list.length === 0) {
            if (q) return <p className="muted small">Nenhuma conversa encontrada para "{convFilter}".</p>;
            return <p className="muted small">Nenhuma conversa neste cliente ainda.{otherCount > 0 ? ` Há ${otherCount} em outros clientes — use a busca ou troque o cliente acima.` : ''}</p>;
          }
          return list.map(c => (
            <div key={c.id} className={`convItem ${current?.id === c.id ? 'active' : ''}`}>
              <button className="convOpen" onClick={() => openConversation(c.id)} title={c.title}>{c.title}</button>
              {(runs[c.id] ? runs[c.id].busy : c.active) && <span className="spin sm convSpin" title="Esta conversa está processando agora" aria-label="Conversa processando"/>}
              <button className="convDel" onClick={(e) => deleteConversation(c.id, e)} title="Apagar conversa" aria-label="Apagar conversa"><Trash2 size={15}/></button>
            </div>
          ));
        })()}
      </div>
      <nav className="sideBottom" aria-label="Recursos do app">
        <div className="navGroup navGroupProduction">
          <div className="navGroupTitle">Produção</div>
          <button className="studio toolsBtn" onClick={onOpenTools} title="Fluxos prontos: documentos, planilhas, OCR e dashboards"><Wrench size={16}/> Ferramentas</button>
          <button className="studio" onClick={onOpenInbox} title="Acumule documentos por cliente e abra tudo numa conversa"><Inbox size={16}/> Caixa de entrada</button>
          <button className="studio" onClick={onOpenTemplates}><BookMarked size={16}/> Templates</button>
          <button className="studio" onClick={onOpenDesign} title="Gerar site, apresentação ou documento visual e refinar conversando"><LayoutTemplate size={16}/> Modo Design</button>
        </div>
        <div className="navGroup navGroupDeveloper">
          <div className="navGroupTitle">Desenvolvimento</div>
          <button className="studio developerBtn" onClick={onOpenDeveloper} title="Perguntar, planejar, implementar, corrigir ou revisar um projeto"><Code2 size={16}/> Modo desenvolvedor</button>
        </div>
        <div className="navGroup navGroupAutomation">
          <div className="navGroupTitle">Automação</div>
          <button className="studio" onClick={() => { onOpenTasks(); onPollTasks(); }}><ListTodo size={16}/> Tarefas{tasksActive && <span className="badge">{tasks.filter(t => t.status === 'queued' || t.status === 'running').length}</span>}</button>
          <button className="studio" onClick={onOpenRoutines} title="Programe tarefas para rodarem sozinhas"><CalendarClock size={16}/> Rotinas</button>
        </div>
        <div className="navGroup navGroupAdmin">
          <div className="navGroupTitle">Ajustes</div>
          <button className="studio" onClick={onOpenAssistants}><Bot size={16}/> Assistentes</button>
          <button className="studio" onClick={onOpenSettings} title="Todas as configurações num só lugar"><SlidersHorizontal size={16}/> Configurações</button>
        </div>
      </nav>
      </div>
      <div className="sideFoot" title={user?.email || 'Sua conta'}>
        <span className="sideFootUser">{user?.name || user?.email || 'Minha conta'}</span>
        <button className="sideFootOut" title="Sair da conta"
          onClick={async () => { try { await onSignOut(); } catch {} }}>
          <LogOut size={14}/> Sair
        </button>
      </div>
    </aside>
  );
}