import React, { useState } from 'react';
import {
  ArrowRight, Check, FileSpreadsheet, FileText, ScanText, Building2, Search, Brain,
  Layers, Code2, LayoutTemplate, TerminalSquare, ShieldCheck, KeyRound, Lock, BadgeCheck,
  Globe, Scale, Cpu, CircleCheckBig, Plus
} from 'lucide-react';
import { LoginScreen } from './LoginScreen.jsx';

// Landing pública. Regras (Regra 1.1 + skill de design SaaS):
// - só anuncia o que o código faz hoje — nada de número, logo de cliente ou
//   depoimento inventado;
// - UM chamado principal ("Criar conta grátis"), repetido no topo e no fim;
// - o herói mostra o PRODUTO de verdade (captura do app), com o conteúdo da
//   conversa rotulado como ilustrativo.

// "Você escreve → você recebe": os mesmos exemplos do README, que descrevem
// entregas que o app produz de fato (kits de documento, visão/OCR, CNPJ, web).
const EXEMPLOS = [
  { pede: 'Monte uma planilha de fluxo de caixa com estes lançamentos', recebe: 'Arquivo .xlsx com fórmulas recalculadas e conferidas' },
  { pede: 'Faça um relatório em Word a partir deste PDF', recebe: 'Arquivo .docx com tabelas estilizadas, rodapé paginado e capa quando o documento é longo' },
  { pede: 'Fotografei esta nota fiscal — extraia os dados', recebe: 'Leitura por visão ou OCR, sem você digitar nada' },
  { pede: 'Consulte o CNPJ desta empresa', recebe: 'Razão social, situação, CNAE, endereço e sócios' },
  { pede: 'Pesquise as mudanças da reforma tributária e resuma', recebe: 'Resumo com as fontes abertas para você conferir' }
];

const PASSOS = [
  { titulo: 'Crie sua conta', texto: 'E-mail e senha, GitHub ou Google. Sem cartão de crédito.' },
  { titulo: 'Escolha o modelo de IA', texto: 'Conecte a sua chave de um provedor ou use o modo gratuito, quando o administrador o habilita.' },
  { titulo: 'Peça e receba pronto', texto: 'Escreva em português, anexe arquivos e acompanhe cada etapa da execução até o arquivo final.' }
];

const RECURSOS = [
  { icon: TerminalSquare, titulo: 'Execução real', texto: 'O código roda num ambiente isolado; o resultado é conferido antes de ser entregue.' },
  { icon: FileSpreadsheet, titulo: 'Excel, Word e PDF', texto: 'Arquivos diagramados por kits próprios, com auditoria de formatação.' },
  { icon: ScanText, titulo: 'Leitura de documentos', texto: 'PDFs, planilhas, imagens e digitalizados, com OCR e tabelas.' },
  { icon: Building2, titulo: 'Consulta de CNPJ', texto: 'Dados cadastrais de bases públicas, direto na conversa.' },
  { icon: Search, titulo: 'Pesquisa na internet', texto: 'Abre as páginas, resume e mostra de onde veio cada informação.' },
  { icon: Brain, titulo: 'Memória sob controle', texto: 'Opcional, pesquisável e editável; você revisa e apaga quando quiser.' },
  { icon: Layers, titulo: 'Vários modelos juntos', texto: 'Compare, faça um conselho, um debate ou uma sequência de especialistas.' },
  { icon: Code2, titulo: 'Modo Desenvolvedor', texto: 'Projetos, permissões por modo e publicação no GitHub com confirmação.' },
  { icon: LayoutTemplate, titulo: 'Modo Design', texto: 'Sites, apresentações e peças visuais refinadas conversando.' }
];

const PROVEDORES = [
  ['openrouter', 'OpenRouter'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'],
  ['gemini', 'Google Gemini'], ['deepseek', 'DeepSeek'], ['mistral', 'Mistral'],
  ['grok', 'xAI'], ['qwen', 'Qwen'], ['meta', 'Meta'], ['perplexity', 'Perplexity']
];

const SEGURANCA = [
  { icon: ShieldCheck, titulo: 'Dados isolados por conta', texto: 'Cada pessoa vê só as próprias conversas, arquivos e memórias.' },
  { icon: Lock, titulo: 'Chaves cifradas', texto: 'Chaves de API e tokens ficam criptografados e nunca vão para o ambiente de execução.' },
  { icon: BadgeCheck, titulo: 'Antivírus nos anexos', texto: 'Quando o antivírus está ativo, o arquivo só chega à IA depois de verificado.' },
  { icon: Globe, titulo: 'Proteção de rede', texto: 'HTTPS, serviços internos isolados e bloqueio de endereços internos.' },
  { icon: KeyRound, titulo: 'Sua chave, seu custo', texto: 'O uso é cobrado pelo provedor da sua chave, sem intermediário.' },
  { icon: Scale, titulo: 'LGPD na prática', texto: 'Exporte seus dados, apague o histórico ou exclua a conta pelo app.' }
];

const DUVIDAS = [
  { p: 'Preciso de cartão de crédito?', r: 'Não. A conta é gratuita. O custo de IA é o do provedor da sua chave — ou nenhum no modo gratuito, quando o administrador da instalação o habilita, com limite diário.' },
  { p: 'Quais modelos de IA posso usar?', r: 'Qualquer provedor compatível com a API da OpenAI, como OpenRouter, DeepSeek, Groq, Gemini e Mistral. Modelos locais (Ollama, LM Studio) funcionam quando o administrador libera endereços locais. O modelo que você escolhe é o que responde — não há troca escondida.' },
  { p: 'O conteúdo da conversa vai para o provedor de IA?', r: 'Sim: o texto e os trechos necessários vão ao provedor do modelo escolhido para gerar a resposta. Evite incluir dados sensíveis desnecessários. Os detalhes estão na Política de Privacidade.' },
  { p: 'Onde ficam meus arquivos?', r: 'No servidor onde o Studio está instalado, separados por conta. Cada conversa tem o próprio espaço de arquivos, e você baixa ou apaga o que quiser.' },
  { p: 'Posso apagar tudo?', r: 'Sim. Em Configurações › Privacidade você exporta seus dados, apaga o histórico ou exclui a conta.' }
];

export default function Landing() {
  const [showLogin, setShowLogin] = useState(false);
  const [mode, setMode] = useState('signup');
  const openLogin = (nextMode) => { setMode(nextMode); setShowLogin(true); };

  if (showLogin) return <LoginScreen initialMode={mode} onBack={() => setShowLogin(false)} />;

  return <div className="lp">
    <a className="lpSkip" href="#conteudo">Pular para o conteúdo</a>
    <header className="lpHeader">
      <a className="lpBrand" href="#top" aria-label="Frederico IA Studio — início">
        <span className="lpBrandMark" aria-hidden="true">F</span>
        <span>Frederico <b>IA Studio</b></span>
      </a>
      <nav className="lpNav" aria-label="Seções da página">
        <a href="#como-funciona">Como funciona</a>
        <a href="#recursos">Recursos</a>
        <a href="#seguranca">Segurança</a>
        <a href="#duvidas">Dúvidas</a>
      </nav>
      <div className="lpHeaderActions">
        <button type="button" className="lpBtn lpBtnQuiet" onClick={() => openLogin('login')}>Entrar</button>
        <button type="button" className="lpBtn lpBtnPrimary" onClick={() => openLogin('signup')}>Criar conta grátis</button>
      </div>
    </header>

    <main id="top">
      <section className="lpHero" id="conteudo">
        <div className="lpHeroText">
          <p className="lpKicker">Estúdio de IA em português</p>
          <h1>Peça em português.<br/>Receba o arquivo pronto.</h1>
          <p className="lpLead">Planilhas com fórmulas, documentos Word diagramados, PDFs e código — feitos de verdade num ambiente isolado, com o modelo de IA que você escolher.</p>
          <div className="lpCtas">
            <button type="button" className="lpBtn lpBtnPrimary lpBtnLg" onClick={() => openLogin('signup')}>Criar conta grátis <ArrowRight size={18} aria-hidden="true"/></button>
            <button type="button" className="lpBtn lpBtnLg" onClick={() => openLogin('login')}>Já tenho conta</button>
          </div>
          <p className="lpReassure"><Check size={15} aria-hidden="true"/> Sem cartão de crédito · sua chave de IA ou o modo gratuito</p>
        </div>
        <figure className="lpShot">
          {/* A imagem acompanha o TEMA do app (classe no <body>), não o do
              sistema operacional — senão a captura clara aparecia numa página escura. */}
          <img className="lpShotDark" src="/landing/produto-dark.jpg" width="1280" height="780" fetchPriority="high"
            alt="Tela do Frederico IA Studio: conversa em que o assistente entrega a planilha fluxo-de-caixa-setembro.xlsx verificada, com a barra lateral de conversas à esquerda."/>
          <img className="lpShotLight" src="/landing/produto-light.jpg" width="1280" height="780" loading="lazy"
            alt="Tela do Frederico IA Studio no tema claro: conversa em que o assistente entrega a planilha fluxo-de-caixa-setembro.xlsx verificada."/>
          <figcaption>Tela real do app. O conteúdo da conversa é ilustrativo.</figcaption>
        </figure>
      </section>

      <section className="lpSection" aria-labelledby="t-exemplos">
        <h2 id="t-exemplos" className="lpH2">O que você pede — e o que chega na conversa</h2>
        <dl className="lpExamples">
          {EXEMPLOS.map(e => <div className="lpExample" key={e.pede}>
            <dt>“{e.pede}”</dt>
            <dd><ArrowRight size={15} aria-hidden="true"/> {e.recebe}</dd>
          </div>)}
        </dl>
      </section>

      <section className="lpSection" id="como-funciona" aria-labelledby="t-como">
        <h2 id="t-como" className="lpH2">Como funciona</h2>
        <ol className="lpSteps">
          {PASSOS.map((p, i) => <li key={p.titulo}><span className="lpStepN" aria-hidden="true">{i + 1}</span><h3>{p.titulo}</h3><p>{p.texto}</p></li>)}
        </ol>
      </section>

      <section className="lpSection" id="recursos" aria-labelledby="t-recursos">
        <h2 id="t-recursos" className="lpH2">Um estúdio de trabalho, não só um chat</h2>
        <p className="lpSub">O modelo conversa, usa ferramentas reais, mostra cada etapa e entrega arquivos que você abre e envia.</p>
        <ul className="lpFeatures">
          {RECURSOS.map(({ icon: Icon, titulo, texto }) => <li key={titulo}>
            <Icon size={20} aria-hidden="true"/><div><h3>{titulo}</h3><p>{texto}</p></div>
          </li>)}
        </ul>
      </section>

      <section className="lpSection lpModels" aria-labelledby="t-modelos">
        <div>
          <h2 id="t-modelos" className="lpH2">O modelo que você escolhe é o que responde</h2>
          <ul className="lpChecks">
            <li><Cpu size={18} aria-hidden="true"/> Nome, provedor, capacidades e preço visíveis antes do envio.</li>
            <li><CircleCheckBig size={18} aria-hidden="true"/> Troca de modelo só com aviso — nunca em silêncio.</li>
            <li><KeyRound size={18} aria-hidden="true"/> Sua chave, sua conta no provedor, seu controle de custo.</li>
          </ul>
        </div>
        <ul className="lpProviders" aria-label="Alguns fabricantes de modelos disponíveis por provedores compatíveis">
          {PROVEDORES.map(([arquivo, nome]) => <li key={arquivo}><img src={`/providers/${arquivo}.png`} alt="" width="20" height="20" loading="lazy"/>{nome}</li>)}
        </ul>
      </section>

      <section className="lpSection" id="seguranca" aria-labelledby="t-seg">
        <h2 id="t-seg" className="lpH2">Feito para proteger o que é seu</h2>
        <ul className="lpFeatures lpFeatures2">
          {SEGURANCA.map(({ icon: Icon, titulo, texto }) => <li key={titulo}>
            <Icon size={20} aria-hidden="true"/><div><h3>{titulo}</h3><p>{texto}</p></div>
          </li>)}
        </ul>
      </section>

      <section className="lpSection lpFaq" id="duvidas" aria-labelledby="t-duvidas">
        <h2 id="t-duvidas" className="lpH2">Dúvidas frequentes</h2>
        {DUVIDAS.map(d => <details key={d.p}>
          <summary>{d.p}<Plus size={18} aria-hidden="true"/></summary>
          <p>{d.r}</p>
        </details>)}
      </section>

      <section className="lpFinal" aria-labelledby="t-final">
        <h2 id="t-final" className="lpH2">Comece pelo primeiro pedido</h2>
        <p>Crie a conta, escolha o modelo e peça o que precisa — em português.</p>
        <button type="button" className="lpBtn lpBtnPrimary lpBtnLg" onClick={() => openLogin('signup')}>Criar conta grátis <ArrowRight size={18} aria-hidden="true"/></button>
      </section>
    </main>

    <footer className="lpFooter">
      <span className="lpBrand"><span className="lpBrandMark" aria-hidden="true">F</span><span>Frederico <b>IA Studio</b></span></span>
      <nav aria-label="Rodapé">
        <a href="/privacidade">Política de Privacidade</a>
        <a href="/termos">Termos de Uso</a>
        <button type="button" onClick={() => openLogin('login')}>Entrar</button>
      </nav>
    </footer>
  </div>;
}
