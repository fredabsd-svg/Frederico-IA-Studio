// Configuração e dados estáticos da interface

export const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Lista de reserva, usada só se a busca do catálogo do provedor falhar.
export const FALLBACK_MODELS = [
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', tools: true },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', tools: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o', tools: true },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', tools: true },
  { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash', tools: true }
];

// Ferramentas que um assistente pode ter acesso
export const TOOL_INFO = [
  { name: 'run_python', label: 'Executar Python' },
  { name: 'bash', label: 'Comandos bash' },
  { name: 'write_file', label: 'Escrever arquivos' },
  { name: 'read_file', label: 'Ler arquivos' },
  { name: 'list_files', label: 'Listar arquivos' },
  { name: 'zip_outputs', label: 'Compactar (.zip)' }
];

// Templates prontos de system prompt
export const TEMPLATES = [
  { key: 'contabil', label: 'Contábil / Fiscal', emoji: '📊', prompt: 'Você é um assistente contábil e fiscal brasileiro. Domine regimes tributários (Simples, Lucro Presumido e Real), obrigações acessórias, SPED, escrituração e conciliações. Responda em português do Brasil, cite a base legal quando relevante e gere planilhas/relatórios reais quando pedido.' },
  { key: 'juridico', label: 'Jurídico', emoji: '⚖️', prompt: 'Você é um assistente jurídico brasileiro. Ajude com análise de contratos, petições, pareceres e pesquisa de legislação. Responda em português do Brasil, seja preciso, cite artigos e leis, e sempre recomende a revisão por um advogado responsável.' },
  { key: 'rh', label: 'Recursos Humanos', emoji: '👥', prompt: 'Você é um assistente de RH e Departamento Pessoal no Brasil. Ajude com folha de pagamento, admissões/demissões, eSocial, férias, benefícios e legislação trabalhista (CLT). Responda em português do Brasil, de forma clara e prática.' },
  { key: 'marketing', label: 'Marketing', emoji: '📣', prompt: 'Você é um assistente de marketing e conteúdo. Ajude a criar textos, campanhas, posts, e-mails e estratégias. Responda em português do Brasil, com tom persuasivo e criativo, adaptando a linguagem ao público-alvo.' },
  { key: 'dev', label: 'Programação', emoji: '💻', prompt: 'Você é um engenheiro de software sênior com um sandbox Linux real. Escreva, execute e teste código (Python/shell) usando as ferramentas, verifique o resultado e corrija erros antes de responder. A sandbox NÃO tem internet: use a biblioteca padrão e os pacotes já instalados. Responda em português do Brasil, objetivo e técnico.' },
  { key: 'geral', label: 'Uso geral', emoji: '🤖', prompt: 'Você é um assistente pessoal versátil e prestativo. Responda em português do Brasil, de forma clara e útil. Quando o usuário pedir arquivos (Excel, Word, PDF), gere-os de verdade usando as ferramentas disponíveis.' }
];

// Sugestões mostradas quando a conversa está vazia
export const SUGGESTIONS = [
  'Gere uma planilha xlsx com um fluxo de caixa de 12 meses, com totais e formatação profissional.',
  'Crie um documento Word com uma proposta de serviços contábeis.',
  'Analise o arquivo que enviei e faça um resumo com os principais números.'
];

export const emptyForm = () => ({ id: null, name: '', emoji: '🤖', model: '', system_prompt: '', template: '', tools: TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20 } });
