// Base de conhecimento do Studio — a "documentação de bolso" do copiloto.
//
// Por que existe: a dúvida mais comum no painel é "como faço X aqui dentro?", e
// o modelo, sem material, responde por analogia com outros produtos — inventa
// menus que não existem. Estes verbetes descrevem o que está DE FATO no
// aplicativo (fonte: README.md e docs/), e a busca é local: sem rede, sem
// tokens gastos para descobrir o que é relevante. Só os trechos escolhidos
// entram no prompt.
//
// Regra de manutenção: se um recurso for removido ou renomeado, corrija aqui —
// um verbete desatualizado é pior do que verbete nenhum.

// `keywords` são os termos que o usuário realmente digita; o título e o corpo
// também entram na busca. Escrever aqui em minúsculas e sem acento não importa:
// a comparação normaliza os dois lados.
export const KNOWLEDGE = [
  {
    id: 'provedores',
    title: 'Provedores de IA e chaves (BYOK)',
    keywords: ['chave', 'api key', 'provedor', 'openai', 'deepseek', 'openrouter', 'anthropic', 'gemini', 'byok', 'configurar ia', 'chave invalida'],
    content: [
      'As chaves são suas: cada usuário cadastra as próprias em Configurações › Provedor de IA. É possível ter vários provedores ativos ao mesmo tempo.',
      'O modelo usado no chat é escolhido no seletor de modelos; o catálogo é sincronizado a partir do provedor.',
      'Erro "chave inválida ou expirada" indica que o provedor daquele modelo recusou a chave — a mensagem de erro nomeia o provedor e o modelo que falharam.',
    ].join(' '),
  },
  {
    id: 'assistentes',
    title: 'Assistentes personalizados',
    keywords: ['assistente', 'persona', 'instrucoes', 'system prompt', 'agente', 'criar assistente'],
    content: [
      'Um assistente reúne instruções fixas, modelo preferido, ferramentas liberadas e conhecimento próprio.',
      'Serve para não repetir o mesmo enquadramento a cada conversa: o que você escreveria toda vez no início do prompt vira instrução do assistente.',
    ].join(' '),
  },
  {
    id: 'memoria',
    title: 'Memória e contexto das conversas',
    keywords: ['memoria', 'lembrar', 'contexto', 'esqueceu', 'historico', 'semantica', 'pgvector', 'projeto'],
    content: [
      'O Studio tem memória de longo prazo com recuperação semântica: fatos aprendidos nas conversas são guardados e recuperados quando fazem sentido, com painel próprio para revisar, editar e apagar.',
      'A recuperação é por camadas — primeiro a conversa atual, depois as conversas do mesmo projeto, depois a busca semântica global.',
      'Fatos aprendidos automaticamente passam por uma fila de revisão antes de virarem memória, quando a revisão está ligada.',
    ].join(' '),
  },
  {
    id: 'documentos',
    title: 'Gerar Word, Excel, PDF e outros arquivos',
    keywords: ['word', 'docx', 'excel', 'xlsx', 'planilha', 'pdf', 'documento', 'relatorio', 'csv', 'zip', 'grafico'],
    content: [
      'Peça o arquivo direto no chat ("gere uma planilha com...", "monte um relatório em Word") e ele chega pronto para baixar.',
      'Há kits de design prontos para documentos (capa, tabelas, cabeçalhos) e geração de gráficos.',
      'Para o resultado sair certo, diga no pedido: o formato, as seções desejadas e para quem é o documento.',
    ].join(' '),
  },
  {
    id: 'docling',
    title: 'Leitura de PDFs e imagens (Docling e OCR)',
    keywords: ['pdf', 'docling', 'ocr', 'digitalizado', 'escaneado', 'ler documento', 'anexo', 'imagem', 'camera', 'foto'],
    content: [
      'PDFs anexados são processados uma vez (layout, tabelas e texto) e ficam reaproveitáveis nas conversas seguintes, sem reprocessar.',
      'Documentos fotografados pela câmera do celular ou pela webcam passam por OCR e viram texto pesquisável.',
    ].join(' '),
  },
  {
    id: 'multimodelo',
    title: 'Multimodelo e Modo Equipe',
    keywords: ['multimodelo', 'varios modelos', 'comparar', 'equipe', 'lado a lado', 'consolidar', 'custo'],
    content: [
      'O Sistema Multimodelo envia a mesma mensagem para dois ou mais modelos e mostra as respostas lado a lado, com opção de consolidar numa resposta final e de pedir que um modelo critique o outro.',
      'Cada cartão mostra estimativa de custo; dá para definir a função de cada modelo.',
      'O Modo Equipe combina as perspectivas de vários assistentes numa única entrega.',
    ].join(' '),
  },
  {
    id: 'ferramentas',
    title: 'Ferramentas e sandbox',
    keywords: ['ferramenta', 'sandbox', 'docker', 'python', 'bash', 'terminal', 'executar codigo', 'rodar script', 'pesquisa web'],
    content: [
      'O agente executa Python e Bash num container Docker isolado por conversa, além de ler/escrever arquivos do espaço de trabalho, pesquisar na web e consultar CNPJ.',
      'Cada assistente tem sua lista de ferramentas liberadas; comandos destrutivos são bloqueados e ações sensíveis pedem confirmação.',
    ].join(' '),
  },
  {
    id: 'desenvolvedor',
    title: 'Modo Desenvolvedor e conector GitHub',
    keywords: ['desenvolvedor', 'projeto', 'github', 'repositorio', 'commit', 'pull request', 'codigo', 'clone'],
    content: [
      'O Modo Desenvolvedor guarda projetos com memória permanente (arquitetura, decisões, padrões, preferências) e explorador de arquivos.',
      'O conector GitHub clona o repositório, aplica alterações e abre push ou Pull Request; a conversa pode ser vinculada a um projeto para a recuperação de contexto priorizá-lo.',
    ].join(' '),
  },
  {
    id: 'rotinas',
    title: 'Rotinas, tarefas em segundo plano e templates',
    keywords: ['rotina', 'agendamento', 'agendar', 'automatico', 'horario', 'tarefa', 'segundo plano', 'template', 'modelo de pedido'],
    content: [
      'Rotinas rodam tarefas sozinhas em horários marcados. Tarefas longas continuam em segundo plano — dá para trocar de conversa sem perder a execução.',
      'Templates de pedido guardam prompts que você repete; ficam disponíveis no compositor do chat principal.',
      'Uma execução interrompida salva o estado no banco e pode ser retomada de onde parou.',
    ].join(' '),
  },
  {
    id: 'copiloto',
    title: 'O copiloto (Nino) e seu painel',
    keywords: ['nino', 'copiloto', 'avatar', 'painel', 'revisar texto', 'balao', 'personagem', 'memoria do copiloto', 'contexto do chat'],
    content: [
      'O copiloto tem painel próprio, aberto pelo avatar: Conversa, Memória e Documentos. A conversa dele é separada do chat principal.',
      'Por padrão ele não enxerga o chat principal. Em Memória › Preferências você escolhe: nunca, perguntar (padrão — você marca "levar o contexto" na mensagem em que quiser) ou sempre.',
      'A memória do copiloto guarda preferências, temas e lembretes que você escreve; notas fixadas entram sempre no contexto dele.',
      'O balão de revisão de escrita observa o rascunho do chat principal e oferece revisar — nunca troca o texto sozinho.',
    ].join(' '),
  },
  {
    id: 'privacidade',
    title: 'Privacidade, dados e LGPD',
    keywords: ['privacidade', 'lgpd', 'dados', 'exportar', 'excluir conta', 'consentimento', 'seguranca'],
    content: [
      'Em Privacidade e dados dá para exportar tudo o que é seu e excluir a conta. O consentimento é opt-in, desmarcado por padrão, no cadastro.',
      'Os dados ficam no banco da própria instalação; as chaves de IA são de cada usuário.',
    ].join(' '),
  },
  {
    id: 'configuracoes',
    title: 'Central de Configurações',
    keywords: ['configuracao', 'ajustes', 'preferencias', 'aparencia', 'tema', 'onde configuro', 'central'],
    content: [
      'A Central de Configurações reúne aparência, copiloto, provedores de IA, ferramentas, privacidade e administração num lugar só.',
      'As opções do copiloto (nome do personagem, modo, animação, revisão proativa de escrita) ficam na seção do copiloto.',
    ].join(' '),
  },
];

// Normaliza para comparar: minúsculas, sem acento, sem pontuação.
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palavras curtas e conectivos não distinguem nada — pesá-las só traz ruído.
const STOPWORDS = new Set([
  'que', 'como', 'para', 'com', 'uma', 'uns', 'dos', 'das', 'por', 'nao', 'sim',
  'pra', 'meu', 'minha', 'seu', 'sua', 'este', 'esta', 'isso', 'aqui', 'onde',
  'quando', 'qual', 'quais', 'fazer', 'faco', 'tem', 'ter', 'sobre', 'mais',
  'studio', 'voce', 'preciso', 'quero', 'pode', 'posso',
]);

function terms(text) {
  return normalize(text).split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Pontua um verbete contra a pergunta. Palavra-chave batida vale mais que
// palavra solta no corpo — é o que separa "quero uma planilha" (documentos) de
// "planilha de memória" (memória).
// Português flexiona muito: quem escreve "agendo uma rotina automática" não
// casa com as chaves "agendar" e "automatico". Em vez de listar cada flexão,
// aceitamos um prefixo comum longo — vale menos que o acerto exato, então uma
// aproximação sozinha não é suficiente para anexar documentação.
const MIN_PREFIX = 5;
function prefixMatch(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < MIN_PREFIX) return false;
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i >= MIN_PREFIX;
}

export function scoreEntry(entry, query) {
  const qs = new Set(terms(query));
  if (!qs.size) return 0;
  const kw = (entry.keywords || []).map(normalize);
  const title = new Set(terms(entry.title));
  const body = new Set(terms(entry.content));

  let score = 0;
  for (const k of kw) {
    // Expressão de várias palavras ("pull request") conta como frase inteira.
    if (k.includes(' ')) { if (normalize(query).includes(k)) score += 4; continue; }
    if (qs.has(k)) { score += 3; continue; }
    if ([...qs].some(t => t !== k && prefixMatch(t, k))) score += 2;
  }
  for (const t of qs) {
    if (title.has(t)) score += 2;
    else if (body.has(t)) score += 1;
  }
  return score;
}

// Busca os verbetes mais relevantes. `minScore` evita anexar documentação a
// perguntas que nada têm a ver com o Studio (o caso comum).
export function findKnowledge(query, { limit = 2, minScore = 4, entries = KNOWLEDGE } = {}) {
  const scored = entries
    .map(e => ({ entry: e, score: scoreEntry(e, query) }))
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, Math.max(0, limit)).map(s => ({ ...s.entry, score: s.score }));
}
