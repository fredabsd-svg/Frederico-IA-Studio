import React, { useEffect, useState } from 'react';
import { ShieldCheck, Wifi, WifiOff, Sparkles, AlertTriangle, Check } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';

// Painel "Sandbox e rede": controla a política de rede do container de execução
// isolado por conversa. Ponto-chave que o usuário precisa entender: isto NÃO
// afeta os modelos de IA — as chamadas aos provedores saem do backend, não do
// container. A política só governa o que o CÓDIGO executado dentro de uma
// conversa (bash, git, curl, instalar pacote) consegue alcançar na internet.
const OPTIONS = [
  {
    value: 0,
    icon: Sparkles,
    label: 'Automático (recomendado)',
    desc: 'A rede fica fechada e só abre quando o próprio pedido pede claramente — instalar um pacote, clonar um repositório, baixar ou acessar um serviço. É o mais seguro no dia a dia.',
  },
  {
    value: 2,
    icon: WifiOff,
    label: 'Sempre desligada',
    desc: 'O código dentro das conversas nunca acessa a internet, nem quando o pedido pede. Máxima segurança. Os modelos continuam respondendo normalmente.',
  },
  {
    value: 1,
    icon: Wifi,
    label: 'Sempre ligada',
    desc: 'O código dentro das conversas sempre pode acessar a internet. Mais conveniente para desenvolvimento, porém reduz o isolamento — use com consciência.',
  },
];

export function SandboxPanel({ onClose }) {
  const [policy, setPolicy] = useState(null); // null = carregando
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await (await fetch(`${API}/api/sandbox-config`)).json();
        if (alive) setPolicy([0, 1, 2].includes(data?.sandbox_network_policy) ? data.sandbox_network_policy : 0);
      } catch { if (alive) setPolicy(0); }
    })();
    return () => { alive = false; };
  }, []);

  async function choose(value) {
    if (value === policy) return;
    const prev = policy;
    setPolicy(value);
    setSaving(true);
    setSaved(false);
    try {
      const data = await (await fetch(`${API}/api/sandbox-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandbox_network_policy: value }),
      })).json();
      setPolicy([0, 1, 2].includes(data?.sandbox_network_policy) ? data.sandbox_network_policy : value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setPolicy(prev); // reverte em caso de falha
    } finally {
      setSaving(false);
    }
  }

  return <Drawer title="Sandbox e rede" icon={<ShieldCheck size={18}/>} onClose={onClose} className="sandboxDrawer">
    <p className="drawerIntro">
      Cada conversa executa código num <b>ambiente isolado</b> (sandbox). Aqui você decide se
      esse código pode acessar a internet.
    </p>

    <div className="sandboxNote">
      <ShieldCheck size={15}/>
      <span>
        Isto <b>não afeta os modelos de IA</b>: as respostas do chat, a memória e os embeddings
        saem do servidor do app, não do sandbox. Mesmo com a rede desligada, os modelos continuam
        funcionando 100%. Esta opção só limita o que <b>ferramentas de código</b> (bash, git,
        instalar pacote, baixar arquivo) alcançam dentro de uma conversa.
      </span>
    </div>

    {policy === null
      ? <div className="working"><span className="spin"/><span>Carregando...</span></div>
      : <div className="sandboxOptions" role="radiogroup" aria-label="Política de rede do sandbox">
          {OPTIONS.map(opt => {
            const Icon = opt.icon;
            const sel = policy === opt.value;
            return <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={sel}
              className={`sandboxOption ${sel ? 'sel' : ''}`}
              onClick={() => choose(opt.value)}
              disabled={saving}
            >
              <span className="sandboxOptIcon"><Icon size={18}/></span>
              <span className="sandboxOptInfo">
                <b>{opt.label}{sel && <Check size={15} className="sandboxOptCheck"/>}</b>
                <small>{opt.desc}</small>
              </span>
            </button>;
          })}
        </div>}

    {policy === 1 && <div className="sandboxWarn">
      <AlertTriangle size={15}/>
      <span>Com a rede sempre ligada, o código executado nas conversas pode se comunicar livremente com a internet. Deixe assim apenas se você confia no uso e precisa dessa conveniência.</span>
    </div>}

    {saved && <div className="sandboxSaved"><Check size={14}/> Preferência salva. Vale a partir da próxima mensagem.</div>}
  </Drawer>;
}
