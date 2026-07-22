// Assistente passo a passo para configurar a PRÓPRIA chave de API — pensado
// para quem nunca ouviu falar de "API": escolhe o provedor, abre a página
// oficial, segue instruções simples, cola a chave, testa e salva.
import React, { useState } from 'react';
import { KeyRound, Check, X, RefreshCw, ExternalLink, ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';
import { API } from './constants.js';
import { Modal } from './components.jsx';

// Provedores sugeridos (pesquisa jul/2026). Preços e páginas podem mudar —
// os links levam sempre à página oficial de chaves de cada provedor.
export const KEY_PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    badge: 'Recomendado',
    desc: 'Um cadastro só dá acesso a centenas de modelos (DeepSeek, GPT, Claude, Gemini...). Tem modelos gratuitos e pagos.',
    price: 'Sem mensalidade: você paga só o que usar. Há modelos ":free" sem custo (com fila) e modelos pagos que custam centavos.',
    keyUrl: 'https://openrouter.ai/settings/keys',
    base: 'https://openrouter.ai/api/v1',
    modelExample: 'deepseek/deepseek-chat',
    keyPrefix: 'sk-or-',
    steps: [
      'Entre em openrouter.ai e clique em "Sign up" (pode usar a conta do Google).',
      'Confirme o e-mail, se for pedido.',
      'Abra a página de chaves (botão abaixo) e clique em "Create key".',
      'Dê um nome qualquer (ex.: "Frederico Studio") e clique em criar.',
      'Copie a chave exibida (começa com "sk-or-...") — ela aparece uma vez só.'
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    desc: 'O provedor mais barato entre os grandes: ótimo custo-benefício para uso diário com ferramentas.',
    price: 'Pré-pago, sem mensalidade. O modelo deepseek-chat custa centavos por milhão de tokens.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    base: 'https://api.deepseek.com',
    modelExample: 'deepseek-v4-flash',
    keyPrefix: 'sk-',
    steps: [
      'Entre em platform.deepseek.com e crie a conta (e-mail e senha).',
      'Adicione um pequeno crédito em "Billing" (aceita cartão internacional).',
      'Abra a página de chaves (botão abaixo) e clique em "Create new API key".',
      'Copie a chave exibida (começa com "sk-...") — ela aparece uma vez só.'
    ]
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    desc: 'Catálogo NIM com modelos de texto, raciocínio e visão em API compatível com OpenAI.',
    price: 'A NVIDIA oferece uma cota de testes; limites e preços dependem do modelo escolhido.',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    base: 'https://integrate.api.nvidia.com/v1',
    modelExample: 'nvidia/nemotron-3-ultra-550b-a55b',
    keyPrefix: 'nvapi-',
    steps: [
      'Entre em build.nvidia.com com a sua conta NVIDIA.',
      'Abra as configurações de API e gere uma nova chave.',
      'Copie a chave completa — ela começa normalmente com "nvapi-".'
    ]
  },
  {
    id: 'alibaba',
    name: 'Alibaba Model Studio',
    desc: 'Modelos Qwen e outros modelos pelo endpoint internacional compatível com OpenAI.',
    price: 'Cobrança e cotas variam por região. A chave precisa pertencer à mesma região da URL base.',
    keyUrl: 'https://modelstudio.console.alibabacloud.com/',
    base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    modelExample: 'qwen3.7-plus',
    keyPrefix: 'sk-',
    steps: [
      'Entre no Alibaba Cloud Model Studio e selecione a região da sua conta.',
      'Crie uma API Key no espaço de trabalho da região escolhida.',
      'Para outra região, ajuste depois a URL base na tela de provedores.'
    ]
  },
  {
    id: 'groq',
    name: 'Groq',
    desc: 'Respostas muito rápidas com modelos abertos (Llama e outros). Tem um plano gratuito com limites.',
    price: 'Plano gratuito com limites por minuto/dia; planos pagos para mais volume.',
    keyUrl: 'https://console.groq.com/keys',
    base: 'https://api.groq.com/openai/v1',
    modelExample: 'llama-3.3-70b-versatile',
    keyPrefix: 'gsk_',
    steps: [
      'Entre em console.groq.com e crie a conta (pode usar Google ou GitHub).',
      'Abra a página de chaves (botão abaixo) e clique em "Create API Key".',
      'Dê um nome e copie a chave exibida (começa com "gsk_...").'
    ]
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    desc: 'Modelos do Google (Gemini) com um nível gratuito generoso pelo Google AI Studio.',
    price: 'Nível gratuito com limites diários; no modo gratuito o Google pode usar as conversas para melhorar os modelos.',
    keyUrl: 'https://aistudio.google.com/apikey',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    modelExample: 'gemini-2.5-flash',
    keyPrefix: 'AIza',
    steps: [
      'Entre em aistudio.google.com com a sua conta Google.',
      'Abra a página de chaves (botão abaixo) e clique em "Create API key".',
      'Escolha (ou crie) um projeto e confirme.',
      'Copie a chave exibida (começa com "AIza...").'
    ]
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    desc: 'Provedor europeu com um nível gratuito de experimentação amplo (pede verificação por telefone).',
    price: 'Nível "Experiment" gratuito com limites; no gratuito os dados podem ser usados para treino (dá para desativar nas configurações da conta).',
    keyUrl: 'https://console.mistral.ai/api-keys',
    base: 'https://api.mistral.ai/v1',
    modelExample: 'mistral-small-latest',
    keyPrefix: '',
    steps: [
      'Entre em console.mistral.ai e crie a conta.',
      'Confirme o telefone quando for pedido (medida antifraude do provedor).',
      'Abra a página de chaves (botão abaixo) e clique em "Create new key".',
      'Copie a chave exibida — ela aparece uma vez só.'
    ]
  }
];

export function KeyWizard({ showToast, onDone, onClose }) {
  const [step, setStep] = useState(0);              // 0 provedor · 1 instruções · 2 colar/testar · 3 pronto
  const [prov, setProv] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState(null);

  async function runTest() {
    if (!apiKey.trim()) { setTest({ ok: false, error: 'Cole a chave no campo acima antes de testar.' }); return; }
    setTesting(true); setTest(null);
    try {
      const res = await fetch(`${API}/api/provider/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), providerType: prov.id, base_url: prov.base, model: prov.modelExample })
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok !== false) setTest({ ok: true });
      else setTest({ ok: false, error: d.error || 'A chave não foi aceita pelo provedor. Confira se copiou a chave inteira.' });
    } catch (e) { setTest({ ok: false, error: e.message || 'Não foi possível testar a chave.' }); }
    finally { setTesting(false); }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/providers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerType: prov.id, name: prov.name, apiKey: apiKey.trim(), base_url: prov.base, model: prov.modelExample })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      setStep(3);
      onDone?.();
    } catch (e) { showToast(e.message || 'Não foi possível salvar a chave.'); }
    finally { setSaving(false); }
  }

  return <Modal title="Configurar minha própria chave" icon={<KeyRound size={18}/>} onClose={onClose} className="keyWizard">
    {step === 0 && <>
      <p className="muted" style={{ margin: 0 }}>
        A chave de API é como uma "senha de uso" que o provedor de IA te dá. Ela é <b>sua</b>: fica na sua conta
        do provedor, e é ele quem cobra (ou libera de graça) o uso. Escolha um provedor para começar:
      </p>
      <div className="freeOptionList">
        {KEY_PROVIDERS.map(p => (
          <button key={p.id} className="freeOptionCard" onClick={() => { setProv(p); setStep(1); }}>
            <span className="freeOptionHead"><b>{p.name}</b>{p.badge && <span className="badge">{p.badge}</span>}</span>
            <small>{p.desc}</small>
          </button>
        ))}
      </div>
    </>}

    {step === 1 && prov && <>
      <p className="muted" style={{ margin: 0 }}><b>{prov.name}</b> · {prov.price}</p>
      <ol className="wizardSteps">
        {prov.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <a className="wizardLink" href={prov.keyUrl} target="_blank" rel="noreferrer noopener">
        <ExternalLink size={15}/> Abrir a página oficial de chaves do {prov.name}
      </a>
      <div className="pcHint"><ShieldCheck size={14}/> A chave pertence a você. Eventuais cobranças são feitas pelo {prov.name}, direto na sua conta — o aplicativo não cobra nada por isso.</div>
      <div className="modalActions">
        <button onClick={() => { setStep(0); setTest(null); }}><ArrowLeft size={15}/> Voltar</button>
        <div className="spacer"/>
        <button className="primary" onClick={() => setStep(2)}>Já tenho a chave <ArrowRight size={15}/></button>
      </div>
    </>}

    {step === 2 && prov && <>
      <label>Cole aqui a chave do {prov.name}
        <input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setTest(null); }}
          placeholder={prov.keyPrefix ? `${prov.keyPrefix}...` : 'cole a chave aqui'} autoComplete="off" autoFocus/>
      </label>
      {test && (test.ok
        ? <div className="pcHint" style={{ color: 'var(--ok)' }}><Check size={14}/> Chave válida! Pode salvar.</div>
        : <div className="pcHint" style={{ color: 'var(--danger)' }}><X size={14}/> {test.error}</div>
      )}
      <p className="muted small" style={{ margin: 0 }}>🔒 A chave fica criptografada no servidor e nunca aparece por completo depois de salva.</p>
      <div className="modalActions">
        <button onClick={() => { setStep(1); setTest(null); }}><ArrowLeft size={15}/> Voltar</button>
        <div className="spacer"/>
        <button onClick={runTest} disabled={testing || saving}>{testing ? <><span className="spin sm"/> Testando...</> : <><RefreshCw size={15}/> Testar</>}</button>
        <button className="primary" onClick={save} disabled={saving || testing || !apiKey.trim()}>{saving ? 'Salvando...' : 'Salvar e usar'}</button>
      </div>
    </>}

    {step === 3 && prov && <>
      <div className="pcHint" style={{ color: 'var(--ok)' }}><Check size={16}/> <b>Tudo pronto!</b></div>
      <p className="muted" style={{ margin: 0 }}>
        Sua chave do {prov.name} foi validada e os modelos disponíveis foram importados.
        Você pode trocar de modelo a qualquer momento no seletor do chat, adicionar outros provedores e ajustar as chaves em
        Configurações → Provedor de IA.
      </p>
      <div className="modalActions">
        <div className="spacer"/>
        <button className="primary" onClick={onClose}>Começar a conversar</button>
      </div>
    </>}
  </Modal>;
}
