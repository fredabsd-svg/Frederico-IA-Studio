// Política pequena e testável para perfis, ferramentas e rede do sandbox.
// Autorizações são decididas pelo backend; texto de prompt nunca amplia acesso.

export const MAX_ASSISTANT_PROFILE_CHARS = 12_000;

export const ASSISTANT_TOOL_NAMES = Object.freeze([
  'run_python',
  'bash',
  'write_file',
  'read_file',
  'list_files',
  'zip_outputs',
  'consultar_cnpj',
  'generate_image'
]);

export function allowedAssistantToolNames(value) {
  // Ausência do campo mantém compatibilidade com assistentes antigos. Uma lista
  // vazia, porém, significa deliberadamente "sem ferramentas".
  if (value == null) return [...ASSISTANT_TOOL_NAMES];
  if (!Array.isArray(value)) return [];
  const known = new Set(ASSISTANT_TOOL_NAMES);
  return [...new Set(value.filter(name => known.has(name)))];
}

export function isToolCallAllowed(name, tools = []) {
  return tools.some(tool => tool?.function?.name === name);
}

export function explicitlyAuthorizesSandboxNetwork(text) {
  const value = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (!value.trim()) return false;

  // Em caso de frase negativa/ambígua, permanece desligada. A pesquisa do globo
  // usa ferramentas do backend e não precisa abrir a rede do container.
  if (/\b(?:nao|sem)\b[^\n.]{0,120}\b(?:internet|rede|api|endpoint|url|site|pacote|dependencia|pip|npm|pnpm|yarn|curl|wget)\b/.test(value)) return false;

  return /\b(?:pip|npm|pnpm|yarn)\s+install\b/.test(value)
    || /\b(?:cargo\s+install|go\s+get|git\s+(?:clone|fetch|pull))\b/.test(value)
    || /\b(?:curl|wget)\b\s+(?:https?:\/\/|-[a-z]*\s+https?:\/\/)/.test(value)
    || /\b(?:baixe|baixar|download|instale|instalar|consuma|consumir|acesse|acessar|conecte|conectar|chame|chamar)\b[^\n.]{0,100}(?:\b(?:internet|rede|api|endpoint|url|site|pacote|dependencia)\b|https?:\/\/)/.test(value)
    || /\b(?:use|usar)\b[^\n.]{0,100}(?:\b(?:internet|rede|api|endpoint|url|site)\b|https?:\/\/)/.test(value);
}
