// Modo gratuito — componentes de interface:
//   FreeOnboarding  · escolha do primeiro acesso ("Começar gratuitamente" x
//                     "Configurar minha própria chave"), com aviso transparente
//   FreeModeBadge   · chip no topo do chat com modelo e mensagens restantes
//   FreeModeDrawer  · detalhes: provedor, modelo, fila, renovação, comparação
//   FreeLimitModal  · tela amigável quando o limite gratuito é atingido
import React from 'react';
import { Sparkles, KeyRound, Check, Clock, RefreshCw, Zap, GraduationCap, X } from 'lucide-react';
import { API } from './constants.js';
import { Modal, Drawer } from './components.jsx';

const hourOf = (iso) => { try { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const prettyModel = (id) => String(id || '').replace(/:free$/, '').split('/').pop();

export async function fetchFreeStatus() {
  try {
    const res = await fetch(`${API}/api/free-tier/status`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ---- Primeiro acesso: as duas portas de entrada ----
export function FreeOnboarding({ status, showToast, onStarted, onOpenWizard, onClose }) {
  const [starting, setStarting] = React.useState(false);
  async function startFree() {
    setStarting(true);
    try {
      const res = await fetch(`${API}/api/free-tier/opt-in`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: true })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      showToast('Modo gratuito ativado! Pode começar a conversar.', 'ok');
      onStarted?.();
    } catch (e) { showToast(e.message || 'Não foi possível ativar o modo gratuito.'); }
    finally { setStarting(false); }
  }

  return <Modal title="Bem-vindo(a)! Como você quer começar?" icon={<Sparkles size={18}/>} onClose={onClose} className="freeOnboarding">
    <p className="muted" style={{ margin: 0 }}>
      Para conversar com a IA, o aplicativo precisa de um "provedor de inteligência artificial".
      Você pode começar agora mesmo, sem configurar nada:
    </p>
    <div className="freeOptionList">
      <button className="freeOptionCard freeOptionPrimary" onClick={startFree} disabled={starting}>
        <span className="freeOptionHead"><Sparkles size={16}/> <b>Começar gratuitamente</b>{starting && <span className="spin sm"/>}</span>
        <small>Sem cadastro em outros sites e sem cartão. Usa os modelos gratuitos da plataforma ({status?.provider || 'OpenRouter'}), com limite de {status?.limitPerDay ?? '—'} mensagens por dia.</small>
      </button>
      <button className="freeOptionCard" onClick={onOpenWizard}>
        <span className="freeOptionHead"><KeyRound size={16}/> <b>Configurar minha própria chave de API</b></span>
        <small>Um assistente passo a passo te guia: escolher o provedor, criar a conta, colar e testar a chave. Respostas mais rápidas e sem fila.</small>
      </button>
    </div>
    <div className="pcHint freeNotice">
      <b>Sobre o modo gratuito</b><br/>
      Esse modo permite testar o aplicativo sem configurar uma chave de API. Como utiliza modelos
      gratuitos, as respostas podem demorar mais, existir fila de processamento e haver limites
      diários ou temporários de mensagens. Para obter respostas mais rápidas, maior estabilidade e
      acesso a modelos avançados, você poderá adicionar sua própria chave de API nas configurações.
    </div>
  </Modal>;
}

// ---- Chip no topo do chat (só quando o modo gratuito está ativo) ----
export function FreeModeBadge({ status, onClick }) {
  if (!status?.active) return null;
  return <button className="freeBadge" onClick={onClick}
    title="Você está no modo gratuito — clique para ver detalhes, limites e como configurar a sua chave">
    <Sparkles size={13}/>
    <span className="freeBadgeLabel">Modo gratuito</span>
    <span className="freeBadgeCount">{status.remaining}/{status.limitPerDay}</span>
  </button>;
}

// ---- Detalhes e comparação ----
export function FreeModeDrawer({ status, onRefresh, onOpenWizard, onClose }) {
  const queue = status?.queue || {};
  const queueBusy = (queue.waiting || 0) > 0 || (queue.running || 0) >= (queue.concurrency || 1);
  return <Drawer title="Modo gratuito" icon={<Sparkles size={18}/>} onClose={onClose} className="freeDrawer">
    <p className="drawerIntro">
      Você está utilizando o modo gratuito do Frederico Studio. Esse modo permite testar o aplicativo
      sem configurar uma chave de API — com algumas limitações, listadas abaixo com transparência.
    </p>
    <div className="statRow">
      <div className="stat"><b>{status?.remaining ?? '—'}</b><span>mensagens restantes hoje</span></div>
      <div className="stat"><b>{status?.usedToday ?? 0}/{status?.limitPerDay ?? '—'}</b><span>usadas / limite diário</span></div>
      <div className="stat"><b>{hourOf(status?.resetAt) || '—'}</b><span>renovação do limite</span></div>
    </div>
    <div className="field">
      <span className="fieldLabel">Como sua mensagem é atendida</span>
      <div className="freeInfoRows">
        <div><span>Provedor</span><b>{status?.provider || '—'}</b></div>
        <div><span>Modelo em uso</span><b>{prettyModel(status?.model) || '—'}</b></div>
        <div><span>Modelos de reserva</span><b>{(status?.models || []).slice(1).map(prettyModel).join(', ') || '—'}</b></div>
        <div><span>Fila agora</span><b>{queueBusy ? `${queue.waiting || 0} esperando · ${queue.running || 0} processando` : 'sem fila no momento'}</b></div>
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        A solicitação sai do seu navegador para o servidor do aplicativo, e só o servidor fala com o
        provedor — a chave gratuita nunca fica no seu dispositivo.
      </p>
    </div>
    <div className="field">
      <span className="fieldLabel">Gratuito x chave própria</span>
      <table className="atable freeCompare">
        <thead><tr><th></th><th>Modo gratuito</th><th>Chave própria</th></tr></thead>
        <tbody>
          <tr><td>Custo</td><td>R$ 0</td><td>Você paga ao provedor (centavos)</td></tr>
          <tr><td>Velocidade</td><td>Pode ter fila</td><td>Sem fila do app</td></tr>
          <tr><td>Limite diário</td><td>{status?.limitPerDay ?? '—'} mensagens</td><td>O do seu plano no provedor</td></tr>
          <tr><td>Modelos</td><td>Somente gratuitos</td><td>Todos do seu provedor</td></tr>
          <tr><td>Estabilidade</td><td>Modelos podem mudar</td><td>Você escolhe e mantém</td></tr>
        </tbody>
      </table>
    </div>
    <div className="modalActions">
      <button onClick={onRefresh}><RefreshCw size={15}/> Atualizar</button>
      <div className="spacer"/>
      <button className="primary" onClick={onOpenWizard}><KeyRound size={15}/> Configurar minha chave</button>
    </div>
  </Drawer>;
}

// ---- Limite atingido: tela amigável com opções ----
export function FreeLimitModal({ info, onRetry, onOpenWizard, onClose }) {
  const blocked = info?.code === 'free_blocked';
  const minute = info?.code === 'free_minute';
  return <Modal title={blocked ? 'Modo gratuito suspenso' : 'Limite gratuito atingido'} icon={<Clock size={18}/>} onClose={onClose} className="freeLimitModal">
    <p className="muted" style={{ margin: 0 }}>
      {blocked
        ? 'Seu acesso ao modo gratuito foi suspenso por uso fora do esperado. Você ainda pode usar o aplicativo normalmente com a sua própria chave de API.'
        : minute
          ? 'Você enviou muitas mensagens seguidas no modo gratuito. Aguarde um instante — é uma pausa curta, para manter o serviço estável para todos.'
          : <>O limite gratuito foi atingido. Você poderá continuar quando o limite for renovado{info?.resetAt ? <> (por volta das <b>{hourOf(info.resetAt)}</b>)</> : ''} ou adicionar sua própria chave de API para continuar usando o aplicativo agora.</>}
    </p>
    <div className="freeOptionList">
      {!blocked && <button className="freeOptionCard" onClick={onClose}>
        <span className="freeOptionHead"><Clock size={15}/> <b>Aguardar a renovação</b></span>
        <small>{minute ? 'Espere alguns segundos e envie de novo.' : `O contador zera ${info?.resetAt ? `às ${hourOf(info.resetAt)}` : 'à meia-noite'} e você ganha novas mensagens gratuitas.`}</small>
      </button>}
      {minute && <button className="freeOptionCard" onClick={onRetry}>
        <span className="freeOptionHead"><RefreshCw size={15}/> <b>Tentar novamente</b></span>
        <small>Reenvia a última mensagem agora.</small>
      </button>}
      <button className="freeOptionCard freeOptionPrimary" onClick={onOpenWizard}>
        <span className="freeOptionHead"><Zap size={15}/> <b>Configurar minha própria chave</b></span>
        <small>Sem fila e sem limite do app: um passo a passo simples te guia em poucos minutos.</small>
      </button>
      <button className="freeOptionCard" onClick={onOpenWizard}>
        <span className="freeOptionHead"><GraduationCap size={15}/> <b>Como obter uma chave? (tutorial)</b></span>
        <small>Entenda o que é uma chave de API, onde criar a conta e quanto custa (alguns provedores têm nível gratuito).</small>
      </button>
    </div>
    <div className="modalActions">
      <div className="spacer"/>
      <button onClick={onClose}><X size={15}/> Fechar</button>
    </div>
  </Modal>;
}
