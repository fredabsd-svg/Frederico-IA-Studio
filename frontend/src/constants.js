// Configuração e dados estáticos da interface

// Endereço da API — sempre a MESMA origem da página (base vazia => chamadas
// relativas "/api/..."). Em produção, o proxy (Caddy) repassa /api ao backend;
// em desenvolvimento, o Vite faz esse repasse (server.proxy no vite.config).
// Isso faz o app funcionar igual no PC, na rede local e via Tailscale/HTTPS,
// sem depender de "localhost" nem de porta separada.
export const API = import.meta.env.VITE_API_URL || '';

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
  { name: 'zip_outputs', label: 'Compactar (.zip)' },
  { name: 'generate_image', label: 'Gerar/editar imagens (IA)' }
];

// Templates prontos de system prompt
export const TEMPLATES = [
  { key: 'contabil', label: 'Contábil / Fiscal', emoji: '📊', prompt: 'Você é um assistente contábil e fiscal brasileiro. Domine regimes tributários (Simples, Lucro Presumido e Real), obrigações acessórias, SPED, escrituração e conciliações. Responda em português do Brasil, cite a base legal quando relevante e gere planilhas/relatórios reais quando pedido.' },
  { key: 'fiscal', label: 'Fiscal / Tributário', emoji: '🧾', prompt: 'Você é um especialista fiscal e tributário brasileiro. Domine apuração de ICMS, ISS, PIS/COFINS, IRPJ/CSLL nos regimes Simples Nacional, Lucro Presumido e Real; obrigações acessórias (SPED Fiscal/Contribuições, EFD, DCTF, DAS); e classificação fiscal (NCM, CFOP, CST) e substituição tributária. Ao calcular tributos, mostre a MEMÓRIA DE CÁLCULO passo a passo e gere planilhas reais. Responda em português do Brasil e cite a base legal.' },
  { key: 'folha', label: 'Folha / Dep. Pessoal', emoji: '💰', prompt: 'Você é um especialista em folha de pagamento e departamento pessoal no Brasil. Domine cálculo de salários, horas extras, DSR, adicionais, INSS, IRRF, FGTS, férias, 13º, rescisões, eSocial e legislação (CLT e convenções coletivas). Ao calcular, mostre a memória de cálculo detalhada e gere planilhas/demonstrativos reais. Responda em português do Brasil.' },
  { key: 'societario', label: 'Societário', emoji: '🏛️', prompt: 'Você é um assistente do departamento societário no Brasil. Ajude com abertura, alteração e baixa de empresas, contratos sociais, atas, quadro societário, Junta Comercial, CNPJ, enquadramentos e obrigações cadastrais. Gere minutas e documentos reais quando pedido. Responda em português do Brasil, cite as exigências legais e recomende revisão por profissional habilitado quando necessário.' },
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

// Cards de ação rápida da tela de boas-vindas (estilo ChatGPT/Claude/Jan.ai)
export const QUICK_ACTIONS = [
  { icon: '📄', label: 'Resumir um documento', desc: 'Envie um PDF ou Word e receba um resumo', prompt: 'Analise o arquivo que enviei e faça um resumo com os principais números e pontos importantes.' },
  { icon: '📊', label: 'Gerar uma planilha', desc: 'Excel pronto com fórmulas e totais', prompt: 'Gere uma planilha xlsx com um fluxo de caixa de 12 meses, com totais e formatação profissional.' },
  { icon: '✍️', label: 'Criar um documento', desc: 'Word, proposta, contrato ou carta', prompt: 'Crie um documento Word com uma proposta de serviços contábeis, bem formatado.' },
  { icon: '🔎', label: 'Pesquisar um assunto', desc: 'Busca atualizada na internet', prompt: 'Pesquise na internet as novidades fiscais e contábeis mais recentes e me faça um resumo.' }
];

// Regras de diagramação de Word, resumidas — carregadas no pedido para que
// qualquer assistente produza um documento profissional.
const DOC_RULES = 'Siga um padrão profissional de diagramação: fonte única (Arial/Calibri); corpo 11pt em cinza-escuro (não preto puro), justificado; margens 2 cm; uma cor principal (azul-marinho ou a marca do cliente) + neutros; capa com tipo do documento, título e dados do cliente; títulos de seção com destaque visual consistente (barra ou linha na cor principal) e maiores que o corpo; tabelas SEM bordas verticais, com cabeçalho colorido, números à direita e linha de total destacada; caixas de destaque para resumos; cabeçalho e rodapé com "Página X de Y". Gere o .docx com python-docx e, ao final, converta para PDF com soffice para conferir a diagramação. Salve em outputs/.';

// "Apps embutidos": fluxos guiados que preparam um pedido forte para a IA
// executar no sandbox (ler arquivos, calcular e gerar Excel/Word/PDF reais).
export const EMBEDDED_APPS = [
  { icon: '📄', title: 'Documento profissional', desc: 'Word bem diagramado (capa, tabelas, cores)', needsFile: false,
    prompt: 'Quero criar um documento Word com diagramação profissional. Me pergunte o tipo (relatório, proposta, contrato, parecer, carta, ata...) e os dados necessários; depois gere o documento pronto para enviar ao cliente. ' + DOC_RULES },
  { icon: '🧾', title: 'NF-e / XML em lote', desc: 'Vira uma planilha com todas as notas', needsFile: true,
    prompt: 'Anexei vários arquivos XML de NF-e/NFC-e nesta conversa. Leia TODOS os XMLs e extraia os campos principais (número, série, data de emissão, CNPJ e nome do emitente e do destinatário, valor total, ICMS, e os itens: descrição, NCM, CFOP, quantidade, valor unitário e total). Gere uma planilha .xlsx profissional com uma aba de "Notas" (resumo por nota), uma aba de "Itens" e uma linha de totais.' },
  { icon: '🏦', title: 'Conciliação bancária', desc: 'Casa o extrato com seus lançamentos', needsFile: true,
    prompt: 'Vou anexar um extrato bancário (OFX, CSV ou PDF) e, quando possível, a relação de lançamentos do meu sistema. Leia os dois, concilie por data e valor, e aponte: o que casou, o que ficou em aberto de cada lado e possíveis duplicidades. Gere uma planilha .xlsx com as abas "Conciliados", "Só no extrato", "Só no sistema" e um resumo com totais.' },
  { icon: '📸', title: 'OCR de recibos/notas', desc: 'Fotos/PDFs viram planilha de despesas', needsFile: true,
    prompt: 'Vou anexar fotos ou PDFs de recibos e notas. Use OCR para ler cada um, extraia data, fornecedor, descrição, uma categoria estimada e o valor, e gere uma planilha .xlsx de despesas com totais por categoria e por mês. Liste separadamente os itens em que a leitura ficou incerta, para eu conferir.' },
  { icon: '⚖️', title: 'Comparador de regimes', desc: 'Simples × Presumido × Real', needsFile: false,
    prompt: 'Quero comparar os regimes tributários (Simples Nacional, Lucro Presumido e Lucro Real) para uma empresa. Antes de calcular, me faça as perguntas necessárias (atividade/CNAE, faturamento dos últimos 12 meses, folha de pagamento, margem/lucro, despesas dedutíveis, se há substituição tributária, etc.). Depois estime a carga tributária em cada regime, mostre a memória de cálculo e gere uma planilha .xlsx comparativa com uma recomendação. Deixe claro que é uma estimativa e que a decisão final exige análise do responsável.' },
  { icon: '📊', title: 'Dashboard do cliente', desc: 'Resumo financeiro com gráficos', needsFile: true,
    prompt: 'Vou anexar uma planilha ou extrato com receitas e despesas. Analise os dados e gere um relatório financeiro em PDF com indicadores (receita, despesa, resultado e margem), a evolução mês a mês e gráficos (barras da evolução e pizza por categoria). Use uma apresentação limpa e profissional.' },
  { icon: '📝', title: 'Proposta / contrato', desc: 'Gera o documento em Word', needsFile: false,
    prompt: 'Quero gerar uma proposta comercial ou um contrato de prestação de serviços contábeis em Word (.docx). Me pergunte os dados necessários (nome e CNPJ do cliente, serviços incluídos, honorários, forma de pagamento, prazo e condições) e gere o documento bem formatado, pronto para revisar e assinar.' }
];

// Calendário fiscal — dias de REFERÊNCIA das principais obrigações mensais.
// Atenção: variam por feriado/fim de semana, por UF/município e por ano.
export const FISCAL_CALENDAR = [
  { day: 5, name: 'Salários', desc: 'Pagamento de salários (até o 5º dia útil)' },
  { day: 9, name: 'GIAM — ICMS (TO)', desc: 'Guia de Informação e Apuração Mensal do ICMS — Tocantins (entrega até o dia 9; não prorroga)' },
  { day: 9, name: 'ICMS Tocantins (apuração normal)', desc: 'Recolhimento do ICMS próprio — TO (beneficiários da Lei 1.790/2007: dia 20)' },
  { day: 15, name: 'SPED Fiscal (EFD ICMS/IPI) — TO', desc: 'Transmissão da EFD ICMS/IPI — Tocantins (Art. 384-E do RICMS/TO)' },
  { day: 15, name: 'EFD-Contribuições', desc: 'PIS/COFINS — SPED Contribuições' },
  { day: 20, name: 'DAS — Simples Nacional', desc: 'Vencimento do DAS do mês' },
  { day: 20, name: 'FGTS (FGTS Digital)', desc: 'FGTS da competência' },
  { day: 20, name: 'INSS / DCTFWeb', desc: 'Contribuições previdenciárias' },
  { day: 25, name: 'PIS/COFINS (Presumido/Real)', desc: 'DARF de PIS e COFINS' },
  { day: 25, name: 'IPI', desc: 'IPI mensal (quando aplicável)' }
];
// Obrigações anuais (informativo, sem contagem regressiva)
export const FISCAL_ANNUAL = [
  { when: 'Fevereiro', name: 'DIRF', desc: 'Declaração do Imposto de Renda Retido na Fonte' },
  { when: 'Março', name: 'DEFIS', desc: 'Declaração de Informações Socioeconômicas (Simples)' },
  { when: 'Abril/Maio', name: 'IRPF', desc: 'Declaração do Imposto de Renda da Pessoa Física' },
  { when: 'Maio', name: 'ECD', desc: 'Escrituração Contábil Digital' },
  { when: 'Julho', name: 'ECF', desc: 'Escrituração Contábil Fiscal' }
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
  { id: 'sepia', label: 'Sépia (papel)', mode: 'light', swatch: ['#f3ecdf', '#9a6a2f', '#fbf6ec'] }
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

export const emptyForm = () => ({ id: null, name: '', emoji: '🤖', model: '', system_prompt: '', template: '', tools: TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20 } });
