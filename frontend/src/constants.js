// Configuração e dados estáticos da interface

// Endereço da API — sempre a MESMA origem da página (base vazia => chamadas
// relativas "/api/..."). Em produção, o proxy (Caddy) repassa /api ao backend;
// em desenvolvimento, o Vite faz esse repasse (server.proxy no vite.config).
// Isso faz o app funcionar igual no PC, na rede local e via Tailscale/HTTPS,
// sem depender de "localhost" nem de porta separada.
export const API = import.meta.env.VITE_API_URL || '';

// Lista de reserva, usada só se a busca do catálogo do provedor falhar.
// Lista de RESERVA: usada só enquanto a lista real do provedor (OpenRouter) não
// carrega. A lista real, com as capacidades de cada modelo, chega por /api/models.
export const FALLBACK_MODELS = [
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', tools: true, vision: false, image: false, video: false, reasoning: false, capabilities: { text: true, tools: true, vision: false, image: false, video: false, reasoning: false } },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (raciocínio)', tools: false, vision: false, image: false, video: false, reasoning: true, capabilities: { text: true, tools: false, vision: false, image: false, video: false, reasoning: true } },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', tools: true, vision: true, image: false, video: false, reasoning: false, capabilities: { text: true, tools: true, vision: true, image: false, video: false, reasoning: false } },
  { id: 'openai/gpt-4o', name: 'GPT-4o', tools: true, vision: true, image: false, video: false, reasoning: false, capabilities: { text: true, tools: true, vision: true, image: false, video: false, reasoning: false } },
  { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', tools: true, vision: true, image: false, video: false, reasoning: false, capabilities: { text: true, tools: true, vision: true, image: false, video: false, reasoning: false } },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', tools: true, vision: true, image: false, video: false, reasoning: false, capabilities: { text: true, tools: true, vision: true, image: false, video: false, reasoning: false } }
];

// Ferramentas que um assistente pode ter acesso
export const TOOL_INFO = [
  { name: 'run_python', label: 'Executar Python' },
  { name: 'bash', label: 'Comandos bash' },
  { name: 'write_file', label: 'Escrever arquivos' },
  { name: 'read_file', label: 'Ler arquivos' },
  { name: 'list_files', label: 'Listar arquivos' },
  { name: 'zip_outputs', label: 'Compactar (.zip)' },
  { name: 'generate_image', label: 'Gerar/editar imagens (IA)' }
];

// Ícones dos assistentes. O campo continua se chamando `emoji` no banco e na
// API (ver backend/src/db.js) — o que mudou foi o CONTEÚDO: agora guarda o
// nome de um ícone Lucide. Assistentes gravados antes disso ainda têm um
// emoji de verdade ali, e continuam funcionando: quem renderiza decide pelo
// isAssistantIcon() se desenha o ícone ou imprime o texto como está.
// 'bot' é o primeiro porque é o padrão e precisa ser escolhível.
export const ASSISTANT_ICONS = [
  'bot', 'calculator', 'file-pen-line', 'code-2', 'telescope', 'scale',
  'briefcase', 'bar-chart-3', 'receipt', 'landmark', 'megaphone', 'lightbulb',
  'shield-check', 'graduation-cap', 'stethoscope', 'hammer', 'leaf'
];

export const ASSISTANT_COLORS = ['#4f8cff', '#8b7cff', '#22c55e', '#f0a340', '#38bdf8'];

export const isAssistantIcon = (v) => ASSISTANT_ICONS.includes(v);

// <option> de <select> nativo não renderiza SVG. Nesses lugares mostramos o
// emoji antigo como texto e, quando já for um nome de ícone, nada — o nome do
// assistente basta.
export const assistantOptionPrefix = (v) => (v && !isAssistantIcon(v)) ? `${v} ` : '';

// Templates prontos de system prompt (assistentes de uso geral)
export const TEMPLATES = [
  { key: 'geral', label: 'Uso geral', emoji: 'bot', prompt: 'Você é um assistente pessoal versátil e prestativo. Responda em português do Brasil, de forma clara e útil. Quando o usuário pedir arquivos (Excel, Word, PDF, imagens), gere-os de verdade usando as ferramentas disponíveis.' },
  { key: 'escrita', label: 'Escrita e conteúdo', emoji: 'file-pen-line', prompt: 'Você é um assistente de escrita e redação. Ajude a criar, revisar e melhorar textos: e-mails, artigos, resumos, roteiros e documentos. Responda em português do Brasil, com clareza e bom estilo, adaptando o tom ao objetivo do usuário.' },
  { key: 'dados', label: 'Análise de dados', emoji: 'bar-chart-3', prompt: 'Você é um assistente de análise de dados. Leia planilhas e arquivos, faça cálculos e resumos, gere tabelas e gráficos e produza planilhas Excel reais quando pedido. Responda em português do Brasil e explique os resultados de forma simples.' },
  { key: 'pesquisa', label: 'Pesquisa e resumo', emoji: 'telescope', prompt: 'Você é um assistente de pesquisa. Busque informações (na internet quando disponível), compare fontes, resuma e organize o conteúdo de forma objetiva. Responda em português do Brasil e cite as fontes usadas.' },
  { key: 'marketing', label: 'Marketing', emoji: 'megaphone', prompt: 'Você é um assistente de marketing e conteúdo. Ajude a criar textos, campanhas, posts, e-mails e estratégias. Responda em português do Brasil, com tom persuasivo e criativo, adaptando a linguagem ao público-alvo.' },
  { key: 'dev', label: 'Programação', emoji: 'code-2', prompt: 'Você é um engenheiro de software sênior com um sandbox Linux real. Escreva, execute e teste código (Python/shell) usando as ferramentas, verifique o resultado e corrija erros antes de responder. A sandbox NÃO tem internet: use a biblioteca padrão e os pacotes já instalados. Responda em português do Brasil, objetivo e técnico.' }
];

// Cards de ação rápida da tela de boas-vindas (estilo ChatGPT/Claude/Jan.ai)
export const QUICK_ACTIONS = [
  { icon: 'document', label: 'Resumir um documento', desc: 'Envie um PDF ou Word e receba um resumo', prompt: 'Analise o arquivo que enviei e faça um resumo com os pontos principais e as informações mais importantes.' },
  { icon: 'spreadsheet', label: 'Gerar uma planilha', desc: 'Excel pronto com fórmulas e totais', prompt: 'Gere uma planilha xlsx de exemplo com dados organizados, fórmulas, totais e formatação profissional.' },
  { icon: 'writing', label: 'Criar um documento', desc: 'Word: carta, relatório, proposta...', prompt: 'Crie um documento Word bem formatado. Me pergunte o tipo e os dados necessários antes de gerar.' },
  { icon: 'search', label: 'Pesquisar um assunto', desc: 'Busca atualizada na internet', prompt: 'Pesquise na internet sobre um assunto que vou indicar e me faça um resumo com as fontes.' }
];

// Regras de diagramação de Word, resumidas — carregadas no pedido para que
// qualquer assistente produza um documento profissional.
const DOC_RULES = 'Siga um padrão profissional de diagramação: fonte única (Arial/Calibri); corpo 11pt em cinza-escuro (não preto puro), justificado; margens 2 cm; uma cor principal (azul-marinho ou a marca do cliente) + neutros; capa com tipo do documento, título e dados do cliente; títulos de seção com destaque visual consistente (barra ou linha na cor principal) e maiores que o corpo; tabelas SEM bordas verticais, com cabeçalho colorido, números à direita e linha de total destacada; caixas de destaque para resumos; cabeçalho e rodapé com "Página X de Y". Gere o .docx com python-docx e, ao final, converta para PDF com soffice para conferir a diagramação. Salve em outputs/.';

// "Apps embutidos": fluxos guiados que preparam um pedido forte para a IA
// executar no sandbox (ler arquivos, calcular e gerar Excel/Word/PDF reais).
export const EMBEDDED_APPS = [
  { icon: '📄', title: 'Documento profissional', desc: 'Word bem diagramado (capa, tabelas, cores)', needsFile: false,
    prompt: 'Quero criar um documento Word com diagramação profissional. Me pergunte o tipo (relatório, proposta, carta, manual, apresentação...) e os dados necessários; depois gere o documento pronto. ' + DOC_RULES },
  { icon: '📊', title: 'Planilha a partir de dados', desc: 'Seus dados viram uma planilha organizada', needsFile: true,
    prompt: 'Vou anexar um arquivo com dados (CSV, Excel, texto ou PDF). Leia o conteúdo, organize numa planilha .xlsx bem formatada com cabeçalhos, totais e, quando fizer sentido, uma aba de resumo com gráficos. Explique o que fez.' },
  { icon: '📸', title: 'OCR de imagens/PDF', desc: 'Fotos ou PDFs viram texto/planilha', needsFile: true,
    prompt: 'Vou anexar fotos ou PDFs. Use OCR para ler o conteúdo e organize as informações extraídas em texto ou numa planilha .xlsx, conforme fizer mais sentido. Liste separadamente os trechos em que a leitura ficou incerta, para eu conferir.' },
  { icon: '📈', title: 'Dashboard de dados', desc: 'Planilha vira relatório com gráficos', needsFile: true,
    prompt: 'Vou anexar uma planilha com dados. Analise e gere um relatório em PDF com os principais indicadores, a evolução ao longo do tempo e gráficos (barras e pizza por categoria). Use uma apresentação limpa e profissional.' },
  { icon: '📝', title: 'Proposta ou contrato', desc: 'Gera o documento em Word', needsFile: false,
    prompt: 'Quero gerar uma proposta comercial ou um contrato de prestação de serviços em Word (.docx). Me pergunte os dados necessários (partes envolvidas, serviços incluídos, valores, forma de pagamento, prazo e condições) e gere o documento bem formatado, pronto para revisar e assinar.' }
];

// Temas do aplicativo. `mode` (dark/light) mantém as regras base; a classe
// t-<id> sobrescreve as cores. swatch = [fundo, destaque, painel] para a prévia.
export const THEMES = [
  { id: 'dark', label: 'Escuro (padrão)', mode: 'dark', swatch: ['#0b1020', '#4f8cff', '#111827'] },
  { id: 'light', label: 'Claro', mode: 'light', swatch: ['#f3f6fb', '#1d4ed8', '#ffffff'] },
  { id: 'slate', label: 'Ardósia', mode: 'dark', swatch: ['#0d1117', '#38bdf8', '#161b22'] },
  { id: 'indigo', label: 'Índigo', mode: 'dark', swatch: ['#0e0b1e', '#8b7cff', '#171233'] },
  { id: 'emerald', label: 'Esmeralda', mode: 'dark', swatch: ['#07120e', '#25c07d', '#0f1f18'] },
  { id: 'amber', label: 'Âmbar', mode: 'dark', swatch: ['#14100a', '#f0a340', '#1f1710'] },
  { id: 'sepia', label: 'Sépia (papel)', mode: 'light', swatch: ['#f3ecdf', '#8a5d28', '#fbf6ec'] }
];

// Espaços de trabalho mudam a hierarquia e o arranjo da interface. Eles são
// independentes da paleta, para a pessoa combinar o layout que prefere com a
// cor que deixa a leitura mais confortável.
export const WORKSPACES = [
  { id: 'studio', label: 'Estúdio', description: 'Visão completa para usar todas as ferramentas.', hint: 'Completo' },
  { id: 'essential', label: 'Essencial', description: 'Conversas e atalhos em uma interface mais compacta.', hint: 'Compacto' },
  { id: 'focus', label: 'Foco', description: 'O chat ganha espaço; a navegação aparece quando você pedir.', hint: 'Sem distrações' },
  { id: 'developer', label: 'Desenvolvedor', description: 'Projetos, arquivos e revisão ficam na frente.', hint: 'Técnico' }
];

// Esforço da IA (raciocínio + nº de etapas). Escolhido no chat.
export const EFFORT_DESC = 'Mais esforço = respostas mais completas, porém mais lentas e com maior consumo de tokens.';
export const EFFORTS = [
  { id: 'baixo', label: 'Baixo' },
  { id: 'medio', label: 'Médio', badge: 'Padrão' },
  { id: 'alto', label: 'Alto' },
  { id: 'extra', label: 'Extra' },
  { id: 'max', label: 'Máx' }
];

export const emptyForm = () => ({ id: null, name: '', emoji: 'bot', color: '', model: '', system_prompt: '', template: '', tools: TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20 } });
