// Página de apresentação (landing) — a "vitrine" mostrada a quem ainda não
// entrou. Explica o produto e leva ao cadastro/login. Ao clicar em qualquer
// chamada para ação, troca para o formulário (LoginScreen) com um botão de
// voltar. Reaproveita a identidade visual do app (landing.css usa os tokens).
import React, { useState } from 'react';
import {
  Sparkles, Bot, FileSpreadsheet, FileText, Building2, Search, Brain,
  ArrowRight, Check, ShieldCheck, KeyRound, Lock, Download
} from 'lucide-react';
import { LoginScreen } from './LoginScreen.jsx';

const FEATURES = [
  { icon: Bot, title: 'Resolve de verdade', text: 'Tem um sandbox Linux real por trás: ele executa, confere e entrega o resultado — não fica só explicando o que você deveria fazer.' },
  { icon: FileSpreadsheet, title: 'Documentos prontos', text: 'Planilhas Excel, documentos Word e PDFs profissionais a partir dos seus dados, já formatados para enviar ao cliente.' },
  { icon: FileText, title: 'Lê seus arquivos', text: 'Anexe PDF, planilhas, imagens e até documentos escaneados — ele lê tudo (com OCR quando precisa) e trabalha em cima.' },
  { icon: Building2, title: 'Consulta CNPJ', text: 'Dados cadastrais oficiais na hora: razão social, situação, CNAE, endereço e quadro de sócios — sem catar em vários sites.' },
  { icon: Search, title: 'Pesquisa na internet', text: 'Legislação, prazos e cotações atuais quando você precisa, sempre mostrando as fontes para você conferir.' },
  { icon: Brain, title: 'Memória e Modo Equipe', text: 'Ele lembra do seu contexto e dos seus clientes e, quando o problema é difícil, aciona vários especialistas de uma vez.' },
];

const STEPS = [
  { n: 1, title: 'Crie sua conta', text: 'Grátis e em segundos — com e-mail e senha, ou pelo GitHub e Google.' },
  { n: 2, title: 'Peça em português', text: 'Converse como você falaria com um colega de trabalho. Anexe arquivos quando precisar.' },
  { n: 3, title: 'Receba pronto', text: 'Planilha, documento ou resposta com fontes — pronto para usar ou mandar para o cliente.' },
];

const TRUST = [
  { icon: ShieldCheck, title: 'Seus dados isolados', text: 'Cada pessoa só enxerga os próprios dados, conversas e arquivos. Nada é compartilhado entre usuários.' },
  { icon: KeyRound, title: 'Sua própria chave', text: 'Use a sua chave de IA (BYOK): você fica no controle do custo e da privacidade das suas informações.' },
  { icon: Lock, title: 'Credenciais protegidas', text: 'Suas chaves e senhas ficam guardadas com criptografia forte no servidor.' },
];

export default function Landing() {
  const [showLogin, setShowLogin] = useState(false);
  const [mode, setMode] = useState('signup');

  const openLogin = (m) => { setMode(m); setShowLogin(true); };

  if (showLogin) {
    return <LoginScreen initialMode={mode} onBack={() => setShowLogin(false)} />;
  }

  return (
    <div className="lp">
      <header className="lpHeader">
        <div className="lpBrand">Frederico <span>AI Studio</span></div>
        <button className="lpNavBtn" onClick={() => openLogin('login')}>Entrar</button>
      </header>

      {/* Hero */}
      <section className="lpHero">
        <div className="lpHeroText">
          <span className="lpKicker"><Sparkles size={15} /> Assistente de IA com sandbox real</span>
          <h1 className="lpH1">O assistente de IA que <span>faz o trabalho</span>, não só responde.</h1>
          <p className="lpLead">
            Feito para contadores e profissionais que lidam com documentos, fisco e clientes.
            Peça em português — ele lê seus arquivos, faz as contas, monta a planilha ou o
            documento e te entrega pronto.
          </p>
          <div className="lpCtas">
            <button className="lpBtn lpBtnPrimary" onClick={() => openLogin('signup')}>
              Criar conta grátis <ArrowRight size={18} />
            </button>
            <button className="lpBtn lpBtnGhost" onClick={() => openLogin('login')}>Já tenho conta</button>
          </div>
          <p className="lpReassure"><Check size={15} /> Grátis para começar · e-mail, GitHub ou Google</p>
        </div>

        {/* Mockup de conversa (mostra o produto sem imagem externa) */}
        <div className="lpMock" aria-hidden="true">
          <div className="lpMockBar"><i /><i /><i /></div>
          <div className="lpBubble lpBubbleUser">Gera uma planilha de DRE a partir desse balancete em PDF 👇</div>
          <div className="lpBubble lpBubbleBot">
            Prontinho! Organizei o DRE com receitas, despesas e o resultado, numa aba limpa e com totais.
            <div className="lpMockFile">
              <span className="fi"><FileSpreadsheet size={18} /></span>
              <span><b>DRE_2025.xlsx</b><small>Excel · 24 KB</small></span>
              <span className="dl"><Download size={13} /> Baixar</span>
            </div>
          </div>
        </div>
      </section>

      {/* Recursos */}
      <section className="lpSection lpCenter">
        <div className="lpCenter">
          <h2 className="lpSectionTitle">Tudo o que você faz na correria, com uma ajuda de verdade</h2>
          <p className="lpSectionSub">Não é um chat que só conversa. É um assistente que executa e entrega.</p>
        </div>
        <div className="lpFeatures">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <article className="lpCard" key={title}>
              <span className="lpCardIcon"><Icon size={22} /></span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Como funciona */}
      <section className="lpSection lpCenter">
        <div className="lpCenter">
          <h2 className="lpSectionTitle">Simples assim</h2>
          <p className="lpSectionSub">Do pedido ao resultado em três passos.</p>
        </div>
        <div className="lpSteps">
          {STEPS.map(({ n, title, text }) => (
            <div className="lpStep" key={n}>
              <span className="lpStepNum">{n}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Confiança / segurança */}
      <section className="lpTrust">
        <div className="lpTrustGrid">
          {TRUST.map(({ icon: Icon, title, text }) => (
            <div className="lpTrustItem" key={title}>
              <span className="ic"><Icon size={22} /></span>
              <div><b>{title}</b><span>{text}</span></div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA final */}
      <section className="lpSection lpFinal">
        <h2 className="lpSectionTitle">Pronto para deixar a papelada com a IA?</h2>
        <p className="lpSectionSub">Crie sua conta e faça o primeiro pedido em menos de um minuto.</p>
        <div className="lpCtas">
          <button className="lpBtn lpBtnPrimary" onClick={() => openLogin('signup')}>
            Criar conta grátis <ArrowRight size={18} />
          </button>
        </div>
      </section>

      <footer>
        <div className="lpFooter">
          <div className="lpBrand">Frederico <span>AI Studio</span></div>
          <span>Feito no Brasil · <button className="lpFootLink" onClick={() => openLogin('login')}>Entrar</button></span>
        </div>
      </footer>
    </div>
  );
}
