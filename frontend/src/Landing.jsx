import React, { useState } from 'react';
import {
  Sparkles, Bot, FileSpreadsheet, FileText, Building2, Search, Brain,
  ArrowRight, Check, ShieldCheck, KeyRound, Lock, Cpu, BadgeCheck,
  Globe, Scale, Layers, Users, MessageSquare, GitBranch, Code2,
  ListChecks, Wrench, Bug, ScanSearch, Rocket, Terminal, Database,
  Eye, Settings2, Workflow, Boxes, ServerCog, CircleCheckBig
} from 'lucide-react';
import { LoginScreen } from './LoginScreen.jsx';
import { DEV_WORK_MODES } from './constants.js';
import { MULTI_MODE_LABEL } from './components/MultiModelBoard.jsx';
import { MULTI_ROLE_OPTIONS } from './components/MultiModelPicker.jsx';

const FEATURES = [
  { icon: Bot, title: 'Resolve de verdade', text: 'Executa código e tarefas num sandbox Linux isolado, confere o resultado e entrega o trabalho pronto.' },
  { icon: FileSpreadsheet, title: 'Documentos prontos', text: 'Gera Excel, Word, PDF, CSV, gráficos e arquivos reais já formatados para usar ou enviar.' },
  { icon: FileText, title: 'Entende seus arquivos', text: 'Lê PDFs, planilhas, imagens e documentos escaneados, com visão e OCR quando necessário.' },
  { icon: Building2, title: 'Consulta CNPJ', text: 'Busca razão social, situação, CNAE, endereço e quadro societário em bases públicas.' },
  { icon: Search, title: 'Pesquisa atualizada', text: 'Pesquisa a internet, abre páginas e organiza a resposta com fontes para você conferir.' },
  { icon: Brain, title: 'Memória controlável', text: 'Mantém contexto entre conversas quando você permite, com painel para revisar, editar e apagar.' },
];

const STEPS = [
  { n: 1, title: 'Crie sua conta', text: 'Entre com e-mail e senha, GitHub ou Google.' },
  { n: 2, title: 'Escolha como trabalhar', text: 'Use o modo gratuito ou conecte a sua própria chave de provedor.' },
  { n: 3, title: 'Peça e receba pronto', text: 'Converse em português, anexe arquivos e acompanhe a execução real.' },
];

const TRUST = [
  { icon: ShieldCheck, title: 'Dados isolados por usuário', text: 'Cada conta acessa somente as próprias conversas, arquivos, configurações e memórias.' },
  { icon: KeyRound, title: 'BYOK ou modo gratuito', text: 'Você escolhe entre usar uma chave própria ou começar com os limites transparentes da plataforma.' },
  { icon: Lock, title: 'Credenciais criptografadas', text: 'Chaves de API e tokens ficam cifrados no servidor e nunca são enviados ao sandbox.' },
  { icon: BadgeCheck, title: 'Verificação de arquivos', text: 'Uploads podem ser verificados por antivírus antes de entrarem no fluxo da IA.' },
  { icon: Globe, title: 'HTTPS e proteção de rede', text: 'Acesso criptografado, isolamento de serviços e filtros contra endereços internos.' },
  { icon: Scale, title: 'LGPD na prática', text: 'Exporte os seus dados, apague o histórico ou exclua a conta diretamente no aplicativo.' },
];

const MULTI_DESCRIPTIONS = {
  compare: 'Respostas paralelas, lado a lado, para comparar qualidade, enfoque e profundidade.',
  council: 'Vários modelos analisam e um coordenador combina as melhores partes numa resposta final.',
  debate: 'Os modelos criticam e revisam as respostas uns dos outros em rodadas controladas.',
  pipeline: 'Especialistas trabalham em sequência: pesquisa, arquitetura, implementação, revisão e teste.',
};

const MULTI_ICONS = {
  compare: Layers,
  council: Users,
  debate: MessageSquare,
  pipeline: Workflow,
};

const DEV_ICON = {
  ask: Eye,
  plan: ListChecks,
  build: Code2,
  fix: Bug,
  review: ScanSearch,
  auto: Rocket,
};

const PROVIDERS = [
  ['openrouter', 'OpenRouter'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'],
  ['gemini', 'Google Gemini'], ['deepseek', 'DeepSeek'], ['mistral', 'Mistral'],
  ['grok', 'xAI'], ['qwen', 'Qwen'], ['meta', 'Meta'],
  ['perplexity', 'Perplexity'], ['cohere', 'Cohere'], ['nvidia', 'NVIDIA'],
];

const MEMORY = [
  { icon: Eye, label: 'Perfil' },
  { icon: Settings2, label: 'Preferências' },
  { icon: Boxes, label: 'Projetos' },
  { icon: Database, label: 'Fatos' },
  { icon: ServerCog, label: 'Manuais' },
];

function SectionHeading({ eyebrow, title, text, tone = 'accent' }) {
  return <div className="lpSectionHead">
    <span className={`lpEyebrow lpEyebrow-${tone}`}>{eyebrow}</span>
    <h2 className="lpSectionTitle">{title}</h2>
    {text && <p className="lpSectionSub">{text}</p>}
  </div>;
}

export default function Landing() {
  const [showLogin, setShowLogin] = useState(false);
  const [mode, setMode] = useState('signup');
  const openLogin = (nextMode) => { setMode(nextMode); setShowLogin(true); };

  if (showLogin) return <LoginScreen initialMode={mode} onBack={() => setShowLogin(false)} />;

  return <div className="lp">
    <header className="lpHeader">
      <a className="lpBrand" href="#top" aria-label="Frederico AI Studio — início">
        <span className="lpBrandMark">F</span>
        <span>Frederico <b>AI Studio</b></span>
      </a>
      <nav className="lpNav" aria-label="Navegação da página">
        <a href="#recursos">Recursos</a>
        <a href="#multimodelo">Multi-modelo</a>
        <a href="#devmode">Modo Dev</a>
        <a href="#seguranca">Segurança</a>
      </nav>
      <div className="lpHeaderActions">
        <button className="lpHeaderLogin" onClick={() => openLogin('login')}>Entrar</button>
        <button className="lpBtn lpBtnPrimary lpBtnSmall" onClick={() => openLogin('signup')}>Criar conta grátis</button>
      </div>
    </header>

    <main id="top">
      <section className="lpHero">
        <div className="lpHeroText">
          <span className="lpKicker"><Sparkles size={15}/> Estúdio de IA com execução real</span>
          <h1 className="lpH1">O assistente de IA que <span>faz o trabalho</span>, não só responde.</h1>
          <p className="lpLead">Use modelos de diferentes provedores com total transparência. Leia arquivos, pesquise, programe, gere documentos e combine várias IAs na mesma tarefa.</p>
          <div className="lpCtas">
            <button className="lpBtn lpBtnPrimary" onClick={() => openLogin('signup')}>Criar conta grátis <ArrowRight size={18}/></button>
            <button className="lpBtn lpBtnGhost" onClick={() => openLogin('login')}>Já tenho conta</button>
          </div>
          <p className="lpReassure"><Check size={15}/> Sem cartão · modo gratuito com limites claros · chave própria quando preferir</p>
        </div>

        <div className="lpMultiMock" aria-label="Exemplo de comparação entre três modelos">
          <div className="lpMockTop">
            <span className="lpMockDots"><i/><i/><i/></span>
            <span className="lpMockStatus"><Layers size={12}/> Comparação · 3 modelos ativos</span>
          </div>
          <div className="lpMockPrompt">Analise este balancete e me diga se o DRE está correto.</div>
          <div className="lpMockGrid">
            <article><span className="blue"><i/> DeepSeek</span><p>Estrutura correta; recomendo destacar margem operacional e líquida.</p></article>
            <article><span className="purple"><i/> Claude</span><p>Encontrei uma diferença entre receita bruta e receita líquida.</p></article>
            <article><span className="green"><i/> GPT</span><p>A conta de despesas administrativas destoa do período anterior.</p></article>
          </div>
          <div className="lpMockCombine"><Boxes size={14}/> Gerar resposta combinada das melhores partes</div>
        </div>
      </section>

      <section id="recursos" className="lpSection">
        <SectionHeading eyebrow="Recursos" title="Um estúdio completo, não apenas outro chat" text="O modelo conversa, usa ferramentas reais, acompanha a execução e entrega arquivos que você pode abrir."/>
        <div className="lpFeatures">
          {FEATURES.map(({ icon: Icon, title, text }) => <article className="lpCard" key={title}>
            <span className="lpCardIcon"><Icon size={22}/></span><h3>{title}</h3><p>{text}</p>
          </article>)}
        </div>
      </section>

      <section id="multimodelo" className="lpBand lpBandMulti">
        <div className="lpBandInner">
          <SectionHeading eyebrow="Multi-modelo" tone="purple" title="Várias IAs trabalhando na mesma mensagem" text="Combine de 2 a 6 modelos, atribua uma função a cada um e escolha como eles devem colaborar."/>
          <div className="lpModeGrid">
            {Object.entries(MULTI_MODE_LABEL).map(([id, label]) => {
              const Icon = MULTI_ICONS[id] || Layers;
              return <article className="lpModeCard" key={id}><span className="lpModeIcon purple"><Icon size={20}/></span><h3>{label}</h3><p>{MULTI_DESCRIPTIONS[id]}</p></article>;
            })}
          </div>
          <div className="lpRoleCloud" aria-label="Funções disponíveis para os modelos">
            {MULTI_ROLE_OPTIONS.slice(0, 10).map(role => <span key={role.id}>{role.label}</span>)}
          </div>
        </div>
      </section>

      <section id="provedores" className="lpSection lpProvidersSection">
        <SectionHeading eyebrow="Transparência" title="O modelo escolhido é o modelo que responde" text="O aplicativo é uma ponte para provedores compatíveis. Sem troca escondida de modelo, sem maquiar o fornecedor e sem prender você a uma única empresa."/>
        <div className="lpRealPoints">
          <div className="lpRealPoint"><KeyRound size={20}/><div><b>Sua chave, sua conta</b><span>Use BYOK e acompanhe custos diretamente no provedor.</span></div></div>
          <div className="lpRealPoint"><Cpu size={20}/><div><b>Modelo explícito</b><span>Nome, provedor, capacidades e custo ficam visíveis antes do envio.</span></div></div>
          <div className="lpRealPoint"><CircleCheckBig size={20}/><div><b>Sem substituição silenciosa</b><span>Fallback só acontece quando configurado e é tratado como recuperação.</span></div></div>
        </div>
        <div className="lpProviderWall">
          {PROVIDERS.map(([file, name]) => <div className="lpProvider" key={file}><img src={`/providers/${file}.png`} alt=""/><span>{name}</span></div>)}
        </div>
        <p className="lpLocalNote"><Terminal size={15}/> Também funciona com endpoints compatíveis e modelos locais expostos por ferramentas como Ollama ou LM Studio.</p>
      </section>

      <section id="devmode" className="lpBand lpDevBand">
        <div className="lpBandInner">
          <SectionHeading eyebrow="Modo Desenvolvedor" tone="green" title="Um ambiente dedicado para trabalhar em projetos" text="Projetos persistentes, arquivos, atividade, alterações e memória ao redor da conversa — com permissões claras por modo."/>
          <div className="lpDevGrid">
            {DEV_WORK_MODES.map(item => {
              const Icon = DEV_ICON[item.id] || Code2;
              return <article className="lpDevCard" key={item.id}>
                <span className={`lpModeIcon ${item.write ? 'green' : 'blue'}`}><Icon size={20}/></span>
                <div><h3>{item.label}</h3><p>{item.short}</p><small>{item.write ? 'Pode editar e executar' : 'Somente leitura'}</small></div>
              </article>;
            })}
          </div>
          <div className="lpDevFlow"><GitBranch size={15}/><b>Fluxo típico:</b> Planejar <ArrowRight size={13}/> Implementar <ArrowRight size={13}/> Revisar <ArrowRight size={13}/> Testar e publicar</div>
        </div>
      </section>

      <section id="memoria" className="lpSection lpMemorySection">
        <SectionHeading eyebrow="Memória" tone="purple" title="Contexto que continua com você" text="A memória é opt-in, pesquisável por significado e separada por usuário. Você pode revisar, editar ou apagar tudo."/>
        <div className="lpMemoryChips">{MEMORY.map(({ icon: Icon, label }) => <span key={label}><Icon size={15}/>{label}</span>)}</div>
        <p className="lpMemoryNote"><Brain size={17}/> O aplicativo usa apenas o contexto relevante para cada pergunta, em vez de despejar todo o histórico em todas as mensagens.</p>
      </section>

      <section id="seguranca" className="lpSection">
        <SectionHeading eyebrow="Segurança e LGPD" tone="green" title="Feito para proteger o que é seu" text="Privacidade não fica escondida num rodapé: ela aparece nas decisões de arquitetura e nos controles da sua conta."/>
        <div className="lpTrustGrid">{TRUST.map(({ icon: Icon, title, text }) => <div className="lpTrustItem" key={title}><Icon size={21}/><div><b>{title}</b><span>{text}</span></div></div>)}</div>
      </section>

      <section className="lpBand lpStepsBand">
        <div className="lpBandInner">
          <SectionHeading eyebrow="Começar" title="Simples assim" text="Do primeiro acesso ao resultado pronto em três passos."/>
          <div className="lpSteps">{STEPS.map(step => <article className="lpStep" key={step.n}><span>{step.n}</span><h3>{step.title}</h3><p>{step.text}</p></article>)}</div>
        </div>
      </section>

      <section className="lpFinal">
        <h2>Pronto para colocar a IA para trabalhar?</h2>
        <p>Crie sua conta e faça o primeiro pedido em menos de um minuto.</p>
        <button className="lpBtn lpBtnPrimary" onClick={() => openLogin('signup')}>Criar conta grátis <ArrowRight size={18}/></button>
      </section>
    </main>

    <footer className="lpFooter">
      <a className="lpBrand" href="#top"><span className="lpBrandMark">F</span><span>Frederico <b>AI Studio</b></span></a>
      <span><a href="/privacidade">Política de Privacidade</a> · <a href="/termos">Termos de Uso</a> · Feito no Brasil · <button onClick={() => openLogin('login')}>Entrar</button></span>
    </footer>
  </div>;
}
