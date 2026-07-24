// Núcleo PURO do copiloto (sem banco, sem rede) — fácil de testar isoladamente.
// Concentra os prompts de sistema, a montagem das mensagens enviadas ao modelo e
// a sanitização de entradas. A regra de ISOLAMENTO vive aqui: as mensagens do
// chat do copiloto nunca incluem nada da conversa principal — só o histórico do
// próprio copiloto.

export const MAX_HISTORY = 20;          // últimas trocas consideradas no contexto
export const MAX_MESSAGE_CHARS = 8000;  // teto por mensagem enviada ao modelo
export const MAX_REVISE_CHARS = 6000;   // teto do texto a revisar

// Persona do copiloto no CHAT próprio. É explicitamente um espaço separado do
// chat principal do Studio — um "colega de trabalho" que ajuda a pensar, revisar
// escrita, lapidar prompts e tirar dúvidas de uso, sem se misturar com a
// conversa principal nem com a memória dela.
export const CHAT_SYSTEM_PROMPT = [
  'Você é o Copiloto do Frederico IA Studio — um colega de trabalho digital que conversa num painel PRÓPRIO, separado do chat principal.',
  'Seu papel: ajudar a pensar, organizar ideias, revisar escrita (ortografia, gramática, clareza), melhorar prompts e tirar dúvidas sobre o uso do Studio.',
  'Este chat é ISOLADO: você NÃO tem acesso ao conteúdo da conversa principal do usuário nem à memória dela. Não invente esse contexto; se precisar de algo que estaria lá, peça ao usuário para colar aqui.',
  'Responda em português do Brasil, de forma direta, cordial e prática. Seja conciso por padrão e aprofunde quando o usuário pedir.',
].join('\n');

// Persona da REVISÃO de escrita (balão proativo). Devolve SOMENTE o texto
// revisado, sem comentários — o resultado substitui o rascunho do usuário.
export const REVISE_SYSTEM_PROMPT = [
  'Você é um revisor de escrita em português do Brasil.',
  'Revise o texto do usuário corrigindo ortografia, gramática, pontuação e acentuação, e melhorando a clareza e a fluência.',
  'PRESERVE o sentido, a intenção, o tom e o idioma originais. Não adicione informação nova, não responda ao conteúdo, não comente.',
  'Devolva APENAS o texto revisado, sem aspas, sem rótulos e sem explicações.',
].join('\n');

const clampStr = (v, max) => (v == null ? '' : String(v).slice(0, max));

// Estimativa de tokens (~4 chars/token) — mesma heurística do resto do app.
export function estimateTokens(text) {
  const s = String(text || '');
  return s ? Math.ceil(s.length / 4) : 0;
}

// Monta as mensagens do CHAT do copiloto: system dedicado + histórico próprio
// (limitado) + a nova fala do usuário. `history` são linhas {role, content} já
// do copiloto — jamais da conversa principal.
export function buildChatMessages(history = [], userText = '', { system = CHAT_SYSTEM_PROMPT, maxHistory = MAX_HISTORY } = {}) {
  const recent = Array.isArray(history) ? history.slice(-maxHistory) : [];
  const past = recent
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => ({ role: m.role, content: clampStr(m.content, MAX_MESSAGE_CHARS) }));
  return [
    { role: 'system', content: system },
    ...past,
    { role: 'user', content: clampStr(userText, MAX_MESSAGE_CHARS) },
  ];
}

// Monta as mensagens da REVISÃO de escrita (uma passada, sem histórico).
export function buildReviseMessages(text, { system = REVISE_SYSTEM_PROMPT } = {}) {
  return [
    { role: 'system', content: system },
    { role: 'user', content: clampStr(text, MAX_REVISE_CHARS) },
  ];
}

const DOC_KINDS = ['texto', 'texto_revisado', 'log', 'print', 'relatorio'];

// Normaliza a entrada de um documento do copiloto para uma forma segura.
export function sanitizeDocInput(input = {}) {
  const kind = DOC_KINDS.includes(input.kind) ? input.kind : 'texto';
  const content = clampStr(input.content, 200_000);
  const name = clampStr(input.name, 200).trim() || defaultDocName(kind);
  const mime = clampStr(input.mime, 100) || 'text/plain';
  let meta = null;
  if (input.meta && typeof input.meta === 'object') {
    try { meta = JSON.stringify(input.meta).slice(0, 4000); } catch { meta = null; }
  }
  return { kind, name, mime, content, meta, size: Buffer.byteLength(content, 'utf8') };
}

export function defaultDocName(kind) {
  const map = {
    texto_revisado: 'Texto revisado',
    log: 'Registro de ação',
    print: 'Captura de tela',
    relatorio: 'Relatório',
    texto: 'Nota',
  };
  return map[kind] || 'Documento';
}

export { DOC_KINDS };
