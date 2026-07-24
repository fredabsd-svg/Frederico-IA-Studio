// Relevance Scorer — analisa o prompt atual e pontua memórias/conversas
// candidatas com critérios SEPARADOS, descartando conteúdo irrelevante.
//
// Causa-raiz que este módulo corrige:
//   1. Perfil/preferências/fixadas eram injetados incondicionalmente (sem
//      filtragem semântica) — agora passam pelo mesmo crivo de relevância.
//   2. Thresholds semânticos muito baixos (0.25/0.3) deixavam passar
//      correspondências fracas por sobreposição de palavras genéricas.
//   3. Recência tinha peso excessivo (15-20%), permitindo que uma conversa
//      recente sobre outro tema superasse uma antiga diretamente relacionada.
//   4. O sistema preenchia cota (sempre tentava retornar `limit` resultados)
//      mesmo quando só 1-2 eram relevantes.
//
// Este módulo é puro (sem I/O, sem DB) para permitir testes isolados.

// ─── Domínios de assunto ───────────────────────────────────────────────
// Cada domínio tem um conjunto de palavras-chave (normalizadas, sem acento)
// que indicam pertencimento. A detecção é por frequência ponderada — não
// basta uma palavra isolada para mudar de domínio.

const DOMAINS = {
  software: {
    label: 'software',
    keywords: [
      'aplicativo', 'app', 'software', 'codigo', 'code', 'bug', 'deploy',
      'frontend', 'backend', 'api', 'github', 'git', 'commit', 'branch',
      'docker', 'container', 'servidor', 'server', 'database', 'banco de dados',
      'sql', 'postgres', 'migracao', 'migration', 'teste', 'test', 'pytest',
      'jest', 'node', 'npm', 'python', 'react', 'jsx', 'tsx', 'typescript',
      'javascript', 'css', 'html', 'streaming', 'websocket', 'sse',
      'system prompt', 'prompt', 'modelo', 'llm', 'ia', 'ai', 'openrouter',
      'openai', 'anthropic', 'claude', 'gpt', 'gemini', 'deepseek',
      'agente', 'agent', 'tool', 'ferramenta', 'sandbox', 'multi modelo',
      'multimodelo', 'multi-modelo', 'embedding', 'vector', 'memoria',
      'contexto', 'token', 'parser', 'middleware', 'rota', 'route',
      'endpoint', 'config', 'configuracao', 'variavel de ambiente',
      'env', 'build', 'compile', 'compilar', 'lint', 'ruff', 'eslint',
      'pipeline', 'ci', 'cd', 'watchdog', 'orchestrator', 'loop',
      'provider', 'provedor', 'catalogo', 'catalog', 'modelo de ia',
      'dev', 'desenvolvedor', 'desenvolvimento', 'programacao', 'programming',
      'algoritmo', 'algorithm', 'estrutura de dados', 'refatoracao',
      'refactor', 'revisao de codigo', 'code review', 'pull request', 'pr',
      'merge', 'rebase', 'checkout', 'clone', 'repositorio', 'repo',
      'json', 'yaml', 'xml', 'schema', 'validacao', 'validation',
      'assincrono', 'async', 'promise', 'callback', 'event loop',
      'cache', 'redis', 'queue', 'fila', 'worker', 'cron', 'scheduler',
      'autenticacao', 'auth', 'jwt', 'token', 'sessao', 'session',
      'cookie', 'cors', 'ssl', 'tls', 'https', 'http',
      'log', 'logging', 'debug', 'trace', 'stack trace', 'exception',
      'erro', 'error', 'crash', 'fallback', 'retry', 'timeout',
      'rate limit', 'throttle', 'debounce', 'polling', 'websocket',
      'indexacao', 'indexer', 'chunk', 'chunking', 'semantic', 'semantica',
      'cosine', 'cosseno', 'hnsw', 'pgvector', 'vector store',
      'context builder', 'retrieval', 'recuperacao', 'policy', 'politica',
      'free tier', 'modo gratuito', 'economy mode', 'modo economia',
      'vision', 'ocr', 'docling', 'pdf', 'markdown', 'html to pdf',
      'layout', 'tela', 'login', 'botao', 'clicar', 'clique', 'pagina',
      'interface', 'menu', 'formulario', 'aba', 'painel', 'design',
      'responsivo', 'mobile', 'desktop', 'aplicacao', 'funcionalidade',
      'companion', 'monitor', 'health', 'incident', 'audit', 'auditoria',
      'repair', 'stream guard', 'checkpoint', 'persistence', 'persistencia',
      'orchestrator', 'multi model', 'model capabilities', 'model knowledge',
      'prompt registry', 'prompt policy', 'assistant policy',
      'tool protocol', 'live stream', 'scheduling', 'task outcome',
      'sandbox', 'pc folders', 'connectors', 'catalog sync',
      'model ref', 'model matrix', 'provider catalog', 'user provider',
      'crypto', 'clamav', 'validation', 'migrate', 'seed',
      'agent loop', 'agent js', 'agent control', 'developer team',
      'model unavailable', 'output delivery', 'vision test',
      'prompt cache', 'repair awaiting', 'page shot', 'artifacts',
      'execution state', 'control', 'outputs', 'web research',
      'assistant policy', 'prompt policy', 'prompt registry',
    ],
    weight: 1.0,
    strongKeywords: [
      'agent loop', 'streaming sse', 'pgvector', 'context builder',
      'multi modelo', 'multimodelo', 'multi-modelo', 'system prompt',
      'prompt registry', 'prompt policy', 'assistant policy',
      'github clone', 'watchdog', 'stream guard', 'free tier',
      'modo gratuito', 'economy mode', 'modo economia',
      'model capabilities', 'model knowledge', 'tool protocol',
      'agent control', 'developer team', 'prompt cache',
      'repair awaiting', 'page shot', 'execution state',
      'catalog sync', 'model ref', 'model matrix',
      'vector store', 'hnsw', 'retrieval policy', 'politica de recuperacao',
      'context builder 2', 'contextbuilder',
    ],
  },
  accounting: {
    label: 'accounting',
    keywords: [
      'contabilidade', 'contabil', 'balanco', 'balanco patrimonial',
      'dre', 'demonstracao', 'resultado', 'fluxo de caixa', 'dfc',
      'fluxo', 'caixa', 'metodo direto', 'metodo indireto',
      'plano de contas', 'conta contabil', 'lancamento', 'lancamentos',
      'debito', 'credito', 'partida dobrada', 'razao', 'diario',
      'livro', 'livro razao', 'livro diario', 'balancete',
      'patrimonio', 'ativo', 'passivo', 'receita', 'despesa',
      'custo', 'custos', 'margem', 'lucro', 'prejuizo',
      'depreciacao', 'amortizacao', 'exaustao',
      'provisao', 'reserva', 'capital', 'social',
      'cpc', 'ifrs', 'nbr', 'norma contabil',
      'sped', 'ecf', 'ecd', 'epp', 'lucro real', 'lucro presumido',
      'lucro arbitrado', 'simples nacional', 'mei', 'anexo',
      'irpj', 'csll', 'pis', 'cofins', 'irrf',
      'contribuicao', 'tributo', 'tributario', 'tributacao',
      'imposto', 'iss', 'issqn', 'icms', 'ipi',
      'retencao', 'retencoes', 'tributos retidos',
      'nota fiscal', 'nf', 'nfse', 'nfe', 'cte', 'mdfe',
      'certificado digital', 'ecac', 'receita federal',
      'refis', 'parcelamento', 'debito tributario',
      'credito tributario', 'incentivo fiscal',
      'escritorio', 'cliente', 'crc', 'contador',
      'obrigacao', 'obrigacoes', 'entrega', 'prazo',
      'aviso previo', 'rescisao', 'demissao', 'clt',
      'folha', 'holerite', 'inss', 'fgts',
      'sefip', 'caged', 'esocial', 'rais',
      'dominio sistemas', 'conectividade social',
      'dfc', 'dva', 'dmpl', 'drea',
      'analise horizontal', 'analise vertical',
      'indice', 'liquidez', 'rentabilidade', 'endividamento',
      'giro', 'prazo medio', 'ponto de equilibrio',
      'orcamento', 'budget', 'fluxo de caixa projetado',
      'conciliacao', 'conciliacao bancaria', 'conciliacao contabil',
      'batimento', 'batimento contabil', 'cruzamento',
      'extrato', 'extrato bancario', 'conciliacao',
      'recibo', 'comprovante', 'comprovacao',
      'alteracao contratual', 'contrato social',
      'abertura de empresa', 'constituicao', 'registro',
      'baixa', 'encerramento', 'extincao',
      'refaz', 'refazimento', 'retroativo',
      'substituicao tributaria', 'st', 'diferimento',
      'apropriacao', 'rateio', 'centro de custo',
      'imobilizado', 'intangivel', 'estoque',
      'fornecedor', 'cliente', 'credor', 'devedor',
      'pagamento', 'recebimento', 'titulo', 'conta a pagar',
      'conta a receber', 'bordero', 'remessa',
      'guia', 'darf', 'dare', 'dje',
      'declaracao', 'declarações', 'obrigacao acessoria',
      'tocantins', 'to', 'sefaz', 'sefaz to',
    ],
    weight: 1.0,
    strongKeywords: [
      'aviso previo', 'rescisao', 'demissao', 'clt',
      'fluxo de caixa', 'dfc', 'dre', 'balanco patrimonial',
      'lucro real', 'lucro presumido', 'lucro arbitrado',
      'simples nacional', 'irpj', 'csll', 'cofins', 'irrf',
      'sped', 'ecf', 'ecd', 'esocial', 'sefip',
      'nota fiscal', 'nfse', 'nfe', 'cte',
      'retencao', 'tributos retidos', 'substituicao tributaria',
      'credito tributario', 'debito tributario',
      'conciliacao bancaria', 'conciliacao contabil',
      'batimento contabil', 'plano de contas',
      'partida dobrada', 'livro razao', 'livro diario',
      'balancete', 'demonstracao de resultado',
      'ponto de equilibrio', 'margem de contribuicao',
      'alteracao contratual', 'contrato social',
      'abertura de empresa', 'encerramento',
      'holerite', 'fgts', 'inss',
      'dominio sistemas', 'conectividade social',
      'certificado digital', 'receita federal',
      'analise horizontal', 'analise vertical',
      'indice de liquidez', 'rentabilidade', 'endividamento',
      'prazo medio', 'centro de custo',
      'imobilizado', 'intangivel',
      'conta a pagar', 'conta a receber',
      'obrigacao acessoria', 'declaracao',
      'metodo direto', 'metodo indireto',
      'depreciacao', 'amortizacao', 'exaustao',
      'provisao', 'reserva', 'capital social',
      'cpc', 'ifrs', 'norma contabil',
      'pis', 'icms', 'iss', 'issqn', 'ipi',
      'anexo', 'mei', 'epp',
      'refis', 'parcelamento',
      'incentivo fiscal', 'diferimento',
      'rateio', 'apropriacao',
      'estoque', 'fornecedor', 'credor', 'devedor',
      'bordero', 'remessa', 'guia', 'darf',
      'extrato bancario', 'recibo', 'comprovante',
      'extincao', 'refazimento', 'retroativo',
      'pagamento', 'recebimento', 'titulo',
      'orcamento', 'budget',
    ],
  },
  finance: {
    label: 'finance',
    keywords: [
      'financeiro', 'financas', 'investimento', 'investir',
      'renda', 'rendimento', 'juros', 'taxa', 'selic',
      'cdi', 'cdb', 'lci', 'lca', 'tesouro',
      'acao', 'acoes', 'fii', 'etf', 'fundo',
      'carteira', 'portfolio', 'diversificacao',
      'risco', 'retorno', 'volatilidade', 'sharpe',
      'emprestimo', 'financiamento', 'credito',
      'amortizacao', 'sac', 'price', 'sistema',
      'moeda', 'cambio', 'dolar', 'euro', 'cambio',
      'inflacao', 'ipca', 'igpm', 'ipc',
      'pib', 'crescimento', 'recessao',
      'mercado', 'bolsa', 'b3', 'bovespa',
      'dividendo', 'jcp', 'juros sobre capital proprio',
      'valor presente', 'valor futuro', 'vpl', 'tir',
      'payback', 'roi', 'roic', 'roe', 'roa',
      'ponto de equilibrio', 'margem de contribuicao',
      'custo de capital', 'wacc', 'capm',
      'fluxo de caixa descontado', 'valuation',
      'orçamento de capital', 'capex', 'opex',
    ],
    weight: 0.85,
    strongKeywords: [
      'fluxo de caixa descontado', 'valuation', 'vpl', 'tir',
      'payback', 'roi', 'roic', 'roe', 'roa',
      'wacc', 'capm', 'ponto de equilibrio',
      'margem de contribuicao', 'custo de capital',
      'selic', 'cdi', 'cdb', 'lci', 'lca',
      'tesouro direto', 'dividendo', 'jcp',
      'juros sobre capital proprio',
      'volatilidade', 'sharpe', 'diversificacao',
      'carteira', 'portfolio', 'fii', 'etf',
      'inflacao', 'ipca', 'igpm',
      'dolar', 'euro', 'cambio', 'moeda',
      'emprestimo', 'financiamento', 'amortizacao', 'sac', 'price',
      'rendimento', 'juros', 'taxa',
      'investimento', 'renda', 'fundo',
      'bolsa', 'b3', 'bovespa', 'mercado',
    ],
  },
  general: {
    label: 'general',
    keywords: [],
    weight: 0,
  },
};

// ─── Normalização de texto ─────────────────────────────────────────────
function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Índice de domínios pré-computado ─────────────────────────────────
// As palavras-chave são normalizadas UMA vez no carregamento do módulo
// (antes eram renormalizadas ~500x a cada chamada de detecção de domínio,
// que roda várias vezes por candidato). Cada termo guarda seu peso de hit
// (1 para keyword comum, 2 para strongKeyword) e, se for curto (<=3), a
// RegExp de fronteira de palavra já compilada.
const DOMAIN_INDEX = (() => {
  const idx = [];
  for (const [name, dom] of Object.entries(DOMAINS)) {
    if (name === 'general') continue;
    const terms = [];
    const push = (kw, w) => {
      const n = normalize(kw);
      if (!n) return;
      terms.push({ n, w, re: n.length <= 3 ? new RegExp(`\\b${n}\\b`) : null });
    };
    for (const kw of dom.keywords) push(kw, 1);
    for (const kw of (dom.strongKeywords || [])) push(kw, 2);
    idx.push({ name, weight: dom.weight, terms });
  }
  return idx;
})();

// Pontua um texto normalizado contra todos os domínios e devolve o domínio
// dominante (mínimo 2 hits ponderados para evitar ruído). Fonte única de
// verdade usada por analyzePrompt e detectContentDomain.
function scoreDomains(normalized) {
  const scores = {};
  for (const d of DOMAIN_INDEX) {
    let hits = 0;
    for (const t of d.terms) {
      if (t.re) { if (t.re.test(normalized)) hits += t.w; }
      else if (normalized.includes(t.n)) hits += t.w;
    }
    scores[d.name] = hits * d.weight;
  }
  let domain = 'general';
  let maxHits = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score > maxHits) { maxHits = score; domain = name; }
  }
  // Domínio "fraco" (soft): a maior inclinação, mesmo abaixo do mínimo de 2.
  // Usado para não deixar o filtro cego em pedidos curtos (ex.: "olha o app
  // e acha bugs" tem só 1 hit de software, mas ainda assim NÃO deve puxar
  // memória contábil).
  let softDomain = null;
  let softMax = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score > softMax) { softMax = score; softDomain = name; }
  }
  return { domain: maxHits < 2 ? 'general' : domain, scores, maxHits, softDomain: softMax > 0 ? softDomain : null };
}

// Domínio efetivo do prompt: o domínio forte quando existe; senão, a
// inclinação fraca (soft). É o que decide compatibilidade/penalidade de
// desvio, para que pedidos curtos não escapem do crivo.
function effectiveDomain(analysis) {
  return analysis.domain !== 'general' ? analysis.domain : (analysis.softDomain || 'general');
}

// ─── Análise do prompt ────────────────────────────────────────────────
// Identifica intenção, assunto, projeto, domínio e entidades.
// Não usa LLM — é análise lexical rápida (rodada a cada mensagem).

const INTENT_PATTERNS = [
  { intent: 'code_review', re: /\b(revis|analise|audit|auditoria|bug|problema|erro|melhoria|corrig|refator|refactor|qualidade)\b.*\b(codigo|app|aplicativo|software|sistema|projeto|repositorio|backend|frontend)\b/ },
  { intent: 'code_review', re: /\b(revis|analise|audit|auditoria)\b.*\b(profunda|profundo|completa|completo)\b.*\b(app|aplicativo|software|sistema|projeto)\b/ },
  { intent: 'development', re: /\b(criar|gerar|implementar|desenvolver|escrever|codar|programar|build|compilar|instalar|configurar|deploy)\b.*\b(codigo|app|aplicativo|software|sistema|projeto|funcionalidade|feature|endpoint|rota|api)\b/ },
  { intent: 'tax_analysis', re: /\b(tributo|tributari|imposto|retencao|nota fiscal|irpj|csll|pis|cofins|icms|iss|simples|lucro real|lucro presumido|sped|ecf|ecd)\b/ },
  { intent: 'accounting_analysis', re: /\b(analise|analizar|demonstr|balanco|fluxo de caixa|dfc|dre|patrimonial|contabil|lancamento|conciliacao|batimento)\b/ },
  { intent: 'text_improvement', re: /\b(melhore|melhorar|reescreva|reescrita|corrija|corrigir|revise|revisar|ajuste|ajustar)\b.*\b(frase|texto|paragrafo|redacao|email|mensagem|documento)\b/ },
  { intent: 'document_generation', re: /\b(gerar|criar|produzir|montar|elaborar)\b.*\b(relatorio|documento|planilha|excel|word|pdf|carta|comunicado|notificacao)\b/ },
  { intent: 'question', re: /\b(qual|quais|como|o que|o q|por que|porque|quando|onde|quem|posso|devo|deveria|pode|podemos)\b/ },
];

const PROJECT_PATTERNS = [
  { project: 'frederico-ia-studio', re: /\b(frederico|ia studio|ai studio|estudio de ia|estudio de inteligencia|meu aplicativo|meu app|o aplicativo|o app|o sistema)\b/i },
  { project: 'contabilidade', re: /\b(escritorio|contabilidade|contabil|clientes?|crc|sped|dominio sistemas)\b/i },
];

export function analyzePrompt(text) {
  const normalized = normalize(text);
  const lower = String(text || '').toLowerCase();

  // Intenção
  let intent = 'general';
  for (const { intent: i, re } of INTENT_PATTERNS) {
    if (re.test(normalized) || re.test(lower)) { intent = i; break; }
  }

  // Domínio: pontua palavras-chave de cada domínio (índice pré-computado).
  const { domain, scores: domainScores, softDomain } = scoreDomains(normalized);

  // Projeto
  let project = null;
  for (const { project: p, re } of PROJECT_PATTERNS) {
    if (re.test(text || '')) { project = p; break; }
  }

  // Entidades: termos importantes extraídos (substantivos longos, nomes próprios)
  const words = normalized.split(/\s+/).filter(w => w.length > 3);
  const entityFreq = {};
  for (const w of words) entityFreq[w] = (entityFreq[w] || 0) + 1;
  const entities = Object.entries(entityFreq)
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);

  return {
    intent,
    domain,
    softDomain,
    domainScores,
    project,
    entities,
    normalized,
    raw: String(text || ''),
    length: normalized.length,
  };
}

// ─── Detecção de domínio de um conteúdo (memória ou conversa) ──────────
export function detectContentDomain(text) {
  const { domain, scores, maxHits } = scoreDomains(normalize(text));
  return { domain, scores, maxHits };
}

// ─── Pontuação de memórias ─────────────────────────────────────────────
// pontuação_memória =
//     relação com a intenção atual
//   + relação com o projeto atual
//   + utilidade para personalização
//   + importância permanente
//   + correspondência de entidades
//   - risco de desvio de contexto
//
// A recência NÃO é critério principal para memórias.

const MEMORY_INTENT_MAP = {
  code_review: ['software', 'general'],
  development: ['software', 'general'],
  accounting_analysis: ['accounting', 'finance'],
  tax_analysis: ['accounting'],
  text_improvement: ['general'],
  document_generation: ['accounting', 'general'],
  question: ['general', 'software', 'accounting'],
  general: ['general', 'software', 'accounting', 'finance'],
};

export function scoreMemory(memory, promptAnalysis, semanticSim = 0) {
  const analysis = promptAnalysis;
  // Domínio efetivo: usa a inclinação fraca quando não há domínio forte,
  // para que pedidos curtos (ex.: "olha o app e acha bugs") ainda barrem
  // memórias de outro domínio.
  const eff = effectiveDomain(analysis);
  const content = String(memory.content || '');
  const contentDomain = detectContentDomain(content);

  // 1. Relação com a intenção atual (0-0.25)
  const validDomains = MEMORY_INTENT_MAP[analysis.intent] || ['general'];
  let intentScore = 0;
  const intentMatchesDomain = validDomains.includes(contentDomain.domain);
  const effMismatch = eff !== 'general' && contentDomain.domain !== 'general' && contentDomain.domain !== eff;
  if (intentMatchesDomain && !effMismatch) {
    intentScore = 0.25;
  } else if (eff === 'general' || contentDomain.domain === 'general') {
    // Se o prompt é genérico (sem inclinação) ou a memória é genérica, não penaliza tanto
    intentScore = 0.10;
  } else if (contentDomain.domain !== eff) {
    // Domínio diferente do prompt — penalidade forte
    intentScore = -0.20;
  }

  // 2. Relação com o projeto atual (0-0.15)
  let projectScore = 0;
  if (analysis.project && contentDomain.domain === 'software' && analysis.project === 'frederico-ia-studio') {
    projectScore = 0.15;
  } else if (analysis.project === 'contabilidade' && contentDomain.domain === 'accounting') {
    projectScore = 0.15;
  }

  // 3. Utilidade para personalização (0-0.15)
  // Memórias de perfil/preferência têm utilidade estrutural, mas só se
  // o domínio for compatível ou genérico.
  let personalizationScore = 0;
  if (memory.type === 'perfil' || memory.type === 'preferencia') {
    if (contentDomain.domain === 'general' || (validDomains.includes(contentDomain.domain) && !effMismatch)) {
      personalizationScore = 0.15;
    } else if (contentDomain.domain !== eff && eff !== 'general') {
      personalizationScore = -0.10; // preferência de outro domínio = desvio
    }
  }
  if (memory.pinned) {
    // Pinned tem um pequeno boost, mas NÃO ignora a relevância
    personalizationScore += 0.05;
  }

  // 4. Importância permanente (0-0.10)
  const importanceScore = 0.10 * ((memory.importance || 3) / 5);

  // 5. Correspondência de entidades (0-0.15)
  let entityScore = 0;
  if (analysis.entities.length && contentDomain.domain !== 'general') {
    const contentNorm = normalize(content);
    let matches = 0;
    for (const ent of analysis.entities.slice(0, 10)) {
      if (ent.length > 3 && contentNorm.includes(ent)) matches++;
    }
    entityScore = 0.15 * Math.min(1, matches / 3);
  }

  // 6. Similaridade semântica (0-0.30)
  const semanticScore = 0.30 * Math.max(0, semanticSim);

  // 7. Risco de desvio de contexto (0-0.20 penalidade)
  let diversionRisk = 0;
  if (effMismatch) {
    diversionRisk = 0.20;
  }
  // Memória genérica (sem domínio claro) em prompt específico: leve risco
  if (eff !== 'general' && contentDomain.domain === 'general' && content.length < 50) {
    diversionRisk = Math.max(diversionRisk, 0.05);
  }

  const total = intentScore + projectScore + personalizationScore + importanceScore + entityScore + semanticScore - diversionRisk;

  // Motivo
  const reasons = [];
  if (semanticSim >= 0.4) reasons.push(`similaridade semântica ${(semanticSim * 100).toFixed(0)}%`);
  if (contentDomain.domain === eff && eff !== 'general') reasons.push(`mesmo domínio (${contentDomain.domain})`);
  if (projectScore > 0) reasons.push(`relacionado ao projeto ${analysis.project}`);
  if (memory.pinned) reasons.push('memória fixada');
  if (memory.type === 'perfil' || memory.type === 'preferencia') reasons.push(`${memory.type} permanente`);
  if (entityScore > 0) reasons.push('entidades correspondentes');
  if (diversionRisk >= 0.20) reasons.push(`descartada: domínio ${contentDomain.domain} ≠ ${eff}`);
  if (total < MEMORY_THRESHOLD && !reasons.some(r => r.startsWith('descartada'))) {
    reasons.push(`pontuação ${total.toFixed(2)} abaixo do threshold ${MEMORY_THRESHOLD}`);
  }

  return {
    score: total,
    semanticSim,
    domain: contentDomain.domain,
    shouldInclude: total >= MEMORY_THRESHOLD && diversionRisk < 0.20,
    reason: reasons.join('; ') || 'sem motivo suficiente',
  };
}

// ─── Pontuação de conversas antigas ────────────────────────────────────
// pontuação_conversa =
//     similaridade semântica
//   + continuidade da tarefa
//   + correspondência do projeto
//   + correspondência de funcionalidades
//   + decisões anteriores relacionadas
//   + recência com peso secundário
//   - diferença de assunto
//
// Uma conversa recente sobre outro tema deve perder para uma conversa
// antiga diretamente relacionada.

export function scoreConversation(chunk, promptAnalysis, semanticSim = 0) {
  const analysis = promptAnalysis;
  const eff = effectiveDomain(analysis);
  const content = String(chunk.content || '');
  const title = String(chunk.source_title || '');
  const fullText = `${title} ${content}`;
  const contentDomain = detectContentDomain(fullText);

  // 1. Similaridade semântica (0-0.40) — peso principal
  const semanticScore = 0.40 * Math.max(0, semanticSim);

  // 2. Continuidade da tarefa (0-0.15)
  // Detecta se a conversa continua o mesmo tipo de tarefa
  let continuityScore = 0;
  const chunkIntent = detectIntentFromContent(content);
  if (chunkIntent === analysis.intent && analysis.intent !== 'general') {
    continuityScore = 0.15;
  }

  // 3. Correspondência do projeto (0-0.10)
  let projectScore = 0;
  if (analysis.project && contentDomain.domain === 'software' && analysis.project === 'frederico-ia-studio') {
    projectScore = 0.10;
  } else if (analysis.project === 'contabilidade' && contentDomain.domain === 'accounting') {
    projectScore = 0.10;
  }

  // 4. Correspondência de funcionalidades (0-0.10)
  let featureScore = 0;
  if (contentDomain.domain === eff && eff !== 'general') {
    featureScore = 0.10;
  }

  // 5. Decisões anteriores relacionadas (0-0.10)
  // Detecta marcadores de decisão no conteúdo
  const decisionMarkers = /\b(decid|corrig|arrum|consert|implement|mudanc|alterac|ajust|remov|adicion|refator)\b/i;
  if (decisionMarkers.test(content) && contentDomain.domain === eff) {
    featureScore += 0.10;
  }

  // 6. Recência com peso secundário (0-0.05) — peso MUITO menor que antes
  let recencyScore = 0;
  const created = chunk.created_at || chunk.updated_at;
  if (created) {
    const days = Math.max(0, (Date.now() - new Date(created).getTime()) / 86400000);
    recencyScore = 0.05 * Math.exp(-days / 180); // decai em 6 meses
  }

  // 7. Diferença de assunto (penalidade 0-0.30)
  const subjectMismatch = eff !== 'general' && contentDomain.domain !== 'general' && contentDomain.domain !== eff;
  let subjectPenalty = 0;
  if (subjectMismatch) {
    subjectPenalty = 0.30;
    // Penalidade extra se o título parece do domínio certo mas o conteúdo é de outro
    const titleDomain = detectContentDomain(title);
    if (titleDomain.domain === eff) {
      subjectPenalty = 0.35; // título enganoso — penaliza mais
    }
  }

  const total = semanticScore + continuityScore + projectScore + featureScore + recencyScore - subjectPenalty;

  // Motivo
  const reasons = [];
  if (semanticSim >= 0.35) reasons.push(`similaridade semântica ${(semanticSim * 100).toFixed(0)}%`);
  if (continuityScore > 0) reasons.push('continuidade de tarefa');
  if (projectScore > 0) reasons.push(`projeto ${analysis.project}`);
  if (contentDomain.domain === eff && eff !== 'general') reasons.push(`mesmo domínio (${contentDomain.domain})`);
  if (decisionMarkers.test(content) && contentDomain.domain === eff) reasons.push('contém decisões anteriores');
  if (subjectPenalty >= 0.30) reasons.push(`descartada: assunto ${contentDomain.domain} ≠ ${eff}`);
  if (total < CONVERSATION_THRESHOLD && !reasons.some(r => r.startsWith('descartada'))) {
    reasons.push(`pontuação ${total.toFixed(2)} abaixo do threshold ${CONVERSATION_THRESHOLD}`);
  }

  return {
    score: total,
    semanticSim,
    domain: contentDomain.domain,
    shouldInclude: total >= CONVERSATION_THRESHOLD && subjectPenalty < 0.30,
    reason: reasons.join('; ') || 'sem motivo suficiente',
  };
}

function detectIntentFromContent(text) {
  const normalized = normalize(text);
  for (const { intent: i, re } of INTENT_PATTERNS) {
    if (re.test(normalized)) return i;
  }
  return 'general';
}

// ─── Thresholds ────────────────────────────────────────────────────────
// Memórias: threshold mais baixo porque perfil/preferência podem ser úteis
// mesmo com baixa similaridade semântica (são estruturais, não topicais).
export const MEMORY_THRESHOLD = 0.25;

// Conversas: threshold mais alto porque chunks de conversas são ruidosos
// e uma correspondência fraca é mais provável de ser irrelevante.
export const CONVERSATION_THRESHOLD = 0.30;

// ─── Validação semântica antes da inclusão ─────────────────────────────
// Responde internamente: "Este conteúdo ajuda diretamente a entender ou
// executar o pedido atual?"
export function validateRelevance(content, promptAnalysis, scoreResult) {
  if (!scoreResult.shouldInclude) {
    return { valid: false, reason: scoreResult.reason };
  }
  // Verificação final: se o domínio é claramente diferente e o prompt é
  // específico, descarta mesmo que a pontuação passou (pode ter passado
  // por importância/pinned sem relevância real).
  const contentDomain = detectContentDomain(content);
  const eff = effectiveDomain(promptAnalysis);
  if (eff !== 'general' && contentDomain.domain !== 'general' && contentDomain.domain !== eff) {
    return { valid: false, reason: `domínio ${contentDomain.domain} incompatível com ${eff}` };
  }
  return { valid: true, reason: scoreResult.reason };
}

// ─── Deduplicação ──────────────────────────────────────────────────────
// Remove conteúdos muito parecidos entre si (não entre o mesmo item).
// Prioridade: mensagem atual > histórico > memória > conversa > resumo.
export function deduplicateContext(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = normalize(item.preview || item.content || '').slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

// ─── Recorte de trechos relevantes ─────────────────────────────────────
// Se uma conversa contém vários assuntos, extrai só o trecho relevante.
export function extractRelevantSnippet(content, promptAnalysis, maxChars = 800) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;

  const analysis = promptAnalysis;
  const contentDomain = detectContentDomain(text);

  // Se o conteúdo inteiro é do mesmo domínio, retorna o início (mais relevante)
  if (contentDomain.domain === analysis.domain || analysis.domain === 'general') {
    return text.slice(0, maxChars);
  }

  // Se tem domínios mistos, procura a seção mais relevante
  const lines = text.split('\n');
  const scored = lines.map((line, i) => {
    const lineDomain = detectContentDomain(line);
    let score = lineDomain.domain === analysis.domain ? 1 : 0;
    // Boost para linhas com entidades do prompt
    const lineNorm = normalize(line);
    for (const ent of analysis.entities.slice(0, 5)) {
      if (ent.length > 3 && lineNorm.includes(ent)) score += 0.5;
    }
    return { line, i, score };
  });

  // Encontra a janela de linhas com maior score
  let bestStart = 0, bestScore = 0;
  const windowSize = Math.min(15, lines.length);
  for (let i = 0; i <= scored.length - windowSize; i++) {
    let windowScore = 0;
    for (let j = i; j < i + windowSize; j++) windowScore += scored[j].score;
    if (windowScore > bestScore) { bestScore = windowScore; bestStart = i; }
  }

  const snippet = lines.slice(bestStart, bestStart + windowSize).join('\n');
  return snippet.length > maxChars ? snippet.slice(0, maxChars) : snippet;
}

// ─── Log de diagnóstico ────────────────────────────────────────────────
export function buildDiagnosticLog(promptAnalysis, memoryResults, conversationResults, finalContext) {
  return {
    timestamp: new Date().toISOString(),
    prompt: {
      raw: promptAnalysis.raw.slice(0, 200),
      intent: promptAnalysis.intent,
      domain: promptAnalysis.domain,
      project: promptAnalysis.project,
      entities: promptAnalysis.entities.slice(0, 10),
    },
    memoryCandidates: memoryResults.map(r => ({
      id: r.id,
      type: r.type,
      score: Number(r.scoreResult?.score?.toFixed(3) || 0),
      semanticSim: Number(r.scoreResult?.semanticSim?.toFixed(3) || 0),
      domain: r.scoreResult?.domain,
      included: r.scoreResult?.shouldInclude,
      reason: r.scoreResult?.reason,
      preview: String(r.content || '').slice(0, 80),
    })),
    conversationCandidates: conversationResults.map(r => ({
      id: r.id,
      title: r.source_title,
      score: Number(r.scoreResult?.score?.toFixed(3) || 0),
      semanticSim: Number(r.scoreResult?.semanticSim?.toFixed(3) || 0),
      domain: r.scoreResult?.domain,
      included: r.scoreResult?.shouldInclude,
      reason: r.scoreResult?.reason,
      preview: String(r.content || '').slice(0, 80),
    })),
    finalContext: {
      memoriesUsed: finalContext.memories?.length || 0,
      conversationsUsed: finalContext.conversations?.length || 0,
      tokensUsed: finalContext.tokensUsed || 0,
      duplicatesRemoved: finalContext.duplicatesRemoved || 0,
    },
  };
}
