// Páginas públicas de documentação legal (LGPD): Política de Privacidade em
// /privacidade e Termos de Uso em /termos. São acessíveis SEM login (o rodapé
// da landing, a tela de cadastro e o app apontam para cá) e funcionam tanto no
// Vite (fallback de SPA) quanto no Caddy (try_files -> index.html).
//
// A versão vigente dos termos vive num lugar SÓ: backend/src/privacy.js
// (TERMS_VERSION), exposta publicamente em /api/health. Estas páginas leem de
// lá; o valor abaixo é apenas o fallback exibido se a API estiver fora do ar.
import React, { useEffect, useState } from 'react';
import { ArrowLeft, ShieldCheck, ScrollText } from 'lucide-react';
import { THEMES } from './constants.js';

export const TERMS_VERSION_FALLBACK = '2026-07-20';

// Busca a versão vigente no backend (fonte única); mantém o fallback enquanto
// carrega ou se a API não responder (página legal continua funcionando).
function useTermsVersion() {
  const [version, setVersion] = useState(TERMS_VERSION_FALLBACK);
  useEffect(() => {
    let ativo = true;
    fetch('/api/health')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (ativo && d?.termsVersion) setVersion(d.termsVersion); })
      .catch(() => {});
    return () => { ativo = false; };
  }, []);
  return version;
}

// Identificação do controlador (LGPD, art. 5º, VI). Centralizada aqui para
// facilitar ajustes de razão social/contato sem caçar no texto.
const CONTROLADOR = 'Frederico Assessoria Contábil';
const CONTATO = 'contabil@fredericoassessoria.com.br';

function LegalShell({ icon, title, children }) {
  const termsVersion = useTermsVersion();
  // Páginas públicas: aplica o tema salvo (ou o padrão) como o AuthGate faz,
  // senão a página abre sem as cores do app.
  useEffect(() => {
    const saved = localStorage.getItem('fred_theme');
    const t = THEMES.find(x => x.id === saved) || THEMES[0];
    document.body.className = `${t.mode} t-${t.id}`;
  }, []);
  return (
    <div className="legalPage">
      <header className="legalHeader">
        <a className="legalBack" href="/"><ArrowLeft size={15}/> Voltar ao Frederico IA Studio</a>
      </header>
      <main className="legalBody">
        <span className="legalKicker">{icon} Documento legal</span>
        <h1>{title}</h1>
        <p className="legalMeta">Versão de {formatVersion(termsVersion)} · {CONTROLADOR}</p>
        {children}
        <footer className="legalFooter">
          <a href="/privacidade">Política de Privacidade</a> · <a href="/termos">Termos de Uso</a> · Contato: <a href={`mailto:${CONTATO}`}>{CONTATO}</a>
        </footer>
      </main>
    </div>
  );
}

function formatVersion(v) {
  const [y, m, d] = String(v).split('-');
  return `${d}/${m}/${y}`;
}

export function PrivacyPolicy() {
  return (
    <LegalShell icon={<ShieldCheck size={14}/>} title="Política de Privacidade">
      <p>
        Esta política explica, em linguagem direta, quais dados o <b>Frederico IA Studio</b> coleta,
        para que os usa, com quem os compartilha e como você exerce os seus direitos previstos na
        Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018).
      </p>

      <h2>1. Quem é o responsável pelos seus dados</h2>
      <p>
        O controlador dos dados tratados neste aplicativo é <b>{CONTROLADOR}</b>. Para qualquer
        assunto de privacidade — dúvidas, solicitações ou reclamações — fale com o encarregado pelo
        e-mail <a href={`mailto:${CONTATO}`}>{CONTATO}</a>.
      </p>

      <h2>2. Quais dados coletamos</h2>
      <ul>
        <li><b>Dados de conta:</b> nome, e-mail e senha (a senha é guardada apenas como <i>hash</i> criptográfico — nem nós conseguimos lê-la). No login social (Google/GitHub), recebemos nome, e-mail e foto do provedor escolhido.</li>
        <li><b>Conteúdo que você cria:</b> conversas, mensagens, arquivos enviados e gerados, memórias, assistentes, templates, clientes e rotinas. Esse conteúdo é seu e fica isolado da conta de qualquer outro usuário.</li>
        <li><b>Credenciais que você cadastra:</b> a sua chave de API de IA (BYOK) e o token do conector GitHub, quando você os informa. Ficam gravados <b>criptografados</b> (AES-256-GCM) e nunca são exibidos por completo nem repassados a terceiros.</li>
        <li><b>Registros técnicos:</b> endereço IP e identificação do navegador nas sessões de login e no registro do seu aceite destes documentos (evidência exigida pela LGPD), além de contadores de uso (tokens e mensagens por dia) para aplicar limites.</li>
        <li><b>Cookies:</b> usamos apenas o cookie <b>essencial de sessão</b>, necessário para manter você conectado. Não usamos cookies de publicidade nem ferramentas de rastreamento/analytics de terceiros.</li>
      </ul>

      <h2>3. Para que usamos os dados</h2>
      <ul>
        <li>Prestar o serviço: manter a sua conta, o histórico de conversas, os arquivos e a memória do assistente (base legal: execução de contrato — art. 7º, V).</li>
        <li>Enviar as suas mensagens ao modelo de IA que você escolheu, para gerar as respostas (execução de contrato).</li>
        <li>Segurança: autenticação, isolamento entre usuários, limites de uso e prevenção a abusos (legítimo interesse — art. 7º, IX).</li>
        <li>Cumprir obrigações legais e registrar o seu consentimento (art. 7º, I e II).</li>
      </ul>
      <p>Não vendemos os seus dados nem os usamos para publicidade.</p>

      <h2>4. Com quem os dados são compartilhados</h2>
      <ul>
        <li><b>Provedor de IA:</b> o texto das suas mensagens e o conteúdo dos arquivos que você pede para analisar são enviados ao provedor do modelo escolhido (por exemplo, OpenRouter, DeepSeek ou outro endpoint compatível configurado — no modo BYOK, o da <i>sua própria</i> chave). Esses provedores podem processar os dados <b>fora do Brasil</b> (transferência internacional — art. 33), sob os termos e políticas de privacidade deles. Por isso, <b>evite incluir dados pessoais sensíveis ou sigilosos nas conversas</b>.</li>
        <li><b>Consulta de CNPJ:</b> o número de CNPJ consultado é enviado a serviços públicos de dados cadastrais (BrasilAPI/ReceitaWS).</li>
        <li><b>Pesquisa na internet:</b> quando você ativa a pesquisa, os termos da busca são enviados ao buscador configurado (Google Custom Search ou DuckDuckGo).</li>
        <li><b>GitHub:</b> apenas se você conectar a sua conta, e somente para as operações que você pedir (clonar, alterar e enviar repositórios seus).</li>
        <li><b>Infraestrutura:</b> o aplicativo e o banco de dados rodam em servidor controlado pelo controlador; não há repasse de conteúdo a outras empresas além das listadas acima.</li>
      </ul>

      <h2>5. Como protegemos os dados</h2>
      <ul>
        <li>Senhas guardadas apenas como hash criptográfico (algoritmo do Better Auth, derivado de scrypt).</li>
        <li>Chaves de API e tokens de conectores cifrados com AES-256-GCM antes de tocar o banco.</li>
        <li>Isolamento por usuário: cada consulta ao banco verifica a posse do dado; ninguém enxerga o conteúdo de outra conta.</li>
        <li>Acesso ao site por HTTPS quando publicado com domínio próprio.</li>
        <li>Execuções de código acontecem em um sandbox isolado por conversa, com limites de CPU e memória.</li>
      </ul>

      <h2>6. Por quanto tempo guardamos</h2>
      <ul>
        <li>Enquanto a sua conta existir. Ao apagar uma conversa (ou todo o histórico), a exclusão é <b>definitiva</b>: mensagens, arquivos, índices de memória e os dados derivados são removidos do banco e do disco — não há "lixeira" nem cópia oculta.</li>
        <li>Ao excluir a conta, <b>tudo</b> é removido em definitivo: perfil, sessões, conversas, arquivos, memórias, chaves e consentimentos.</li>
        <li>O operador pode ativar uma rotina de limpeza automática que apaga conversas sem atividade após um período determinado; quando ativa, isso vale para todos os usuários igualmente.</li>
        <li>Cópias de segurança (backups) do servidor, quando existentes, são de acesso restrito ao administrador e expiram com a rotina normal de backup.</li>
      </ul>

      <h2>7. Seus direitos (art. 18 da LGPD)</h2>
      <p>Você pode, a qualquer momento e direto no aplicativo (menu <b>Privacidade e dados</b>):</p>
      <ul>
        <li><b>Exportar os seus dados</b> em formato JSON legível (portabilidade);</li>
        <li><b>Apagar todo o histórico de conversas</b> com um clique;</li>
        <li><b>Excluir a sua conta</b> e todos os dados associados, em definitivo;</li>
        <li>Corrigir os dados de conta e revogar consentimentos.</li>
      </ul>
      <p>
        Para confirmação de tratamento, revisão ou qualquer outro pedido, escreva para{' '}
        <a href={`mailto:${CONTATO}`}>{CONTATO}</a>. Respondemos nos prazos da LGPD. Você também pode
        peticionar à Autoridade Nacional de Proteção de Dados (ANPD).
      </p>

      <h2>8. Uma recomendação importante</h2>
      <p>
        O conteúdo das conversas é transmitido ao provedor de IA para gerar as respostas. Portanto,
        <b> não inclua nas mensagens dados pessoais sensíveis</b> (saúde, biometria, dados de menores),
        senhas, dados bancários completos ou documentos sigilosos que não sejam necessários à tarefa.
        Prefira remover ou mascarar esses trechos antes de enviar.
      </p>

      <h2>9. Alterações desta política</h2>
      <p>
        Se esta política mudar de forma relevante, a data da versão acima será atualizada e o
        aplicativo pedirá o seu aceite novamente no próximo acesso.
      </p>
    </LegalShell>
  );
}

export function TermsOfUse() {
  return (
    <LegalShell icon={<ScrollText size={14}/>} title="Termos de Uso">
      <p>
        Estes termos regulam o uso do <b>Frederico IA Studio</b>, operado por <b>{CONTROLADOR}</b>.
        Ao criar uma conta ou usar o aplicativo, você declara que leu e concorda com eles e com a{' '}
        <a href="/privacidade">Política de Privacidade</a>.
      </p>

      <h2>1. O serviço</h2>
      <p>
        O Frederico IA Studio é um estúdio de IA: permite conversar com modelos de inteligência
        artificial, analisar arquivos, gerar documentos (Excel, Word, PDF e outros) e executar
        tarefas em um ambiente isolado. O aplicativo atua como <b>ponte</b> entre você e o provedor
        de IA configurado — as respostas são geradas pelo modelo escolhido, não pelo aplicativo.
      </p>

      <h2>2. Conta e chave de API</h2>
      <ul>
        <li>Você é responsável por manter a confidencialidade da sua senha e das suas credenciais.</li>
        <li>No modo BYOK ("traga a sua chave"), a chave de API é sua: os custos, limites e termos de uso cobrados pelo provedor de IA (por exemplo, OpenRouter) correm por sua conta e sob o contrato que você tem com ele.</li>
        <li>Forneça informações verdadeiras no cadastro e mantenha o e-mail acessível.</li>
      </ul>

      <h2>3. Uso aceitável</h2>
      <ul>
        <li>Não use o serviço para atividades ilegais, para violar direitos de terceiros, distribuir malware ou tentar burlar o isolamento entre contas e o sandbox.</li>
        <li>Você é o único responsável pelo conteúdo que envia (prompts, arquivos e dados de clientes seus), inclusive por ter base legal para tratá-lo, e pelo uso que fizer do conteúdo gerado.</li>
        <li>Contas que violem estes termos podem ser suspensas ou encerradas.</li>
      </ul>

      <h2>4. Conteúdo gerado por IA — limites e responsabilidade</h2>
      <ul>
        <li>Modelos de IA <b>podem errar</b>: gerar informações incorretas, desatualizadas ou incompletas, inclusive em cálculos, citações de legislação e valores.</li>
        <li>As respostas <b>não constituem aconselhamento contábil, fiscal, jurídico ou financeiro</b>. Elas são um apoio de produtividade e devem ser <b>revisadas por um profissional habilitado</b> antes de qualquer uso oficial (entrega ao fisco, ao cliente, a órgãos públicos etc.).</li>
        <li>Na extensão máxima permitida pela lei, o operador não responde por decisões tomadas com base nas respostas da IA nem por danos indiretos decorrentes do uso do serviço.</li>
      </ul>

      <h2>5. Disponibilidade</h2>
      <p>
        O serviço é fornecido "no estado em que se encontra", sem garantia de disponibilidade
        ininterrupta. Manutenções, atualizações e falhas de provedores externos (IA, buscadores,
        GitHub) podem afetar o funcionamento temporariamente.
      </p>

      <h2>6. Privacidade e dados</h2>
      <p>
        O tratamento de dados pessoais é descrito na <a href="/privacidade">Política de Privacidade</a>.
        Você pode exportar os seus dados, apagar o histórico e excluir a conta a qualquer momento,
        direto no aplicativo — sair é tão fácil quanto entrar.
      </p>

      <h2>7. Propriedade</h2>
      <p>
        O conteúdo que você envia e os arquivos gerados a partir dos seus pedidos são seus. O
        software, a marca e o design do aplicativo pertencem ao operador.
      </p>

      <h2>8. Alterações</h2>
      <p>
        Estes termos podem ser atualizados; mudanças relevantes atualizam a data da versão acima e o
        aplicativo pedirá novo aceite. O uso contínuo após o aceite vale como concordância.
      </p>

      <h2>9. Lei aplicável e foro</h2>
      <p>
        Aplica-se a lei brasileira, em especial o Marco Civil da Internet (Lei nº 12.965/2014), o
        Código de Defesa do Consumidor quando cabível e a LGPD (Lei nº 13.709/2018). Fica eleito o
        foro do domicílio do usuário para dirimir controvérsias.
      </p>
    </LegalShell>
  );
}
