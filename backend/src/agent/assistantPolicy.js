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

// Política persistente da rede do sandbox, escolhida pelo usuário nas
// Configurações. IMPORTANTE: nada disto afeta os modelos de IA — as chamadas
// aos provedores saem do backend. Só governa a rede do container de execução.
export const SANDBOX_NET_AUTO = 0;  // abre quando o pedido pede claramente (padrão)
export const SANDBOX_NET_ON = 1;    // sempre ligada
export const SANDBOX_NET_OFF = 2;   // sempre desligada (ignora até pedido explícito)

// Resolve se a rede do container deve abrir neste turno, combinando a política
// persistente com o texto do pedido. Função pura e testável.
export function resolveSandboxNetwork(policy, text) {
  const p = Number(policy);
  if (p === SANDBOX_NET_ON) return true;
  if (p === SANDBOX_NET_OFF) return false;
  return explicitlyAuthorizesSandboxNetwork(text);
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
