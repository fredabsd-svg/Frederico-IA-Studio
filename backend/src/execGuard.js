// Guarda de execução — validação central do que a IA pode rodar no sandbox.
//
// Por que existe: a fronteira REAL de segurança é o container (CapDrop ALL,
// no-new-privileges, uid 1000, rootfs próprio). Mas as **Pastas do PC**
// (/mnt/pc/<pasta>) são arquivos REAIS e insubstituíveis do usuário, montados
// de fora — ali o container não protege nada. Este módulo é a camada que
// impede que código gerado por um modelo apague ou sobrescreva esses arquivos
// sem o usuário ter pedido.
//
// Antes desta camada, `guardCommand` só era aplicada ao `bash`. O `run_python`
// — a ferramenta que os modelos mais usam — passava direto, então um
// `shutil.rmtree('/mnt/pc/Clientes')` era executado sem qualquer validação.
//
// Três regras, nesta ordem:
//   1. Caminho de SISTEMA + operação destrutiva  -> bloqueado sempre.
//   2. Caminho de PASTA DO PC + operação que altera -> exige autorização
//      explícita do pedido atual (mesmo idioma de `explicitlyAuthorizesSandboxNetwork`).
//   3. Fuga para o shell dentro do Python (os.system/subprocess com literal)
//      -> o literal passa pela MESMA guarda do bash.
//
// Limite honesto: a análise é textual (não é um interpretador). Código que monta
// o caminho em partes ou o recebe por variável de outra linha escapa da regra 2.
// Por isso ela NÃO é a única defesa: o mount só é montado como leitura+escrita
// quando o turno autoriza (sandbox.js), e isso é garantido pelo Docker.

// ---- Comandos de shell -------------------------------------------------------

// Padrões destrutivos/escalada. `extra` restringe o casamento a alvos de sistema
// para não bloquear um `rm -rf build/` legítimo dentro do workspace.
const GUARD_PATTERNS = [
  // `extra` define o ALVO que torna o rm -rf perigoso. Além da raiz ("/", "~"),
  // cobre os diretórios de sistema por nome: antes `rm -rf /home` passava, porque
  // o padrão exigia que depois da barra viesse espaço/barra/asterisco/fim.
  // `/mnt/pc/...` fica FORA daqui de propósito — cai na regra de autorização das
  // Pastas do PC logo abaixo, que o usuário pode liberar; só `/mnt` inteiro é
  // bloqueado de vez (apagaria todas as pastas montadas de uma só vez).
  {
    re: /\brm\b[^|;&]*-[a-z]*r[a-z]*f|\brm\b[^|;&]*-[a-z]*f[a-z]*r/,
    extra: /(\s|^)(\/|~|\/\*|\$home)(\s|\/|\*|$)|(\s|^)\/(home|etc|usr|var|root|opt|srv|bin|sbin|lib|lib64|boot|proc|sys)(\/|\s|\*|$)|(\s|^)\/mnt(\s|\*|$)/,
    msg: 'rm -rf em caminho de sistema'
  },
  { re: /--no-preserve-root/, msg: 'rm --no-preserve-root' },
  { re: /\bmkfs\b|\bmke2fs\b/, msg: 'formatar sistema de arquivos' },
  { re: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}|:\(\)\{.*:\|:/, msg: 'fork bomb' },
  { re: /(^|[\s;&|])(shutdown|reboot|halt|poweroff)\b|\binit\s+0\b/, msg: 'desligar/reiniciar o host' },
  { re: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|vd|mmc)/, msg: 'dd sobre dispositivo de bloco' },
  { re: />\s*\/dev\/(sd|nvme|hd|vd|mmc)/, msg: 'escrita direta em disco' },
  { re: /\bfind\b\s+(\/|~|\/mnt|\/home|\/etc|\/usr|\/var)[^|;&]*\s-delete\b/, msg: 'find -delete em caminho de sistema' },
  { re: /(^|[\s;&|])(sudo|doas)\s|(^|[\s;&|])su\s+-/, msg: 'escalonamento de privilégio' },
  { re: /(^|[\s;&|])docker(\s|$)|docker-compose/, msg: 'docker' },
  { re: /\bchmod\s+-r[^|;&]*\s\/(\s|$)|\bchown\s+-r[^|;&]*\s\/(\s|$)/, msg: 'chmod/chown recursivo na raiz' }
];

// Raiz dos mounts das Pastas do PC dentro do sandbox (ver sandbox.js).
export const PC_MOUNT_ROOT = '/mnt/pc';

// Comandos de shell que APAGAM ou SOBRESCREVEM. Só disparam quando o alvo é uma
// pasta do PC (checado à parte) — dentro do /workspace são operações normais.
const SHELL_MUTATING = /\b(rm|rmdir|shred|truncate|mv|dd)\b|\b(cp|rsync|tee|install)\b|>{1,2}\s*['"]?\/mnt\/pc/;

function normalizeCommand(command) {
  return String(command || '').toLowerCase().replace(/[ \t]+/g, ' ').trim();
}

export class BlockedExecutionError extends Error {
  constructor(reason, { needsAuthorization = false } = {}) {
    super(needsAuthorization
      ? `Ação bloqueada (${reason}). Estes são arquivos REAIS do computador do usuário: peça a ele, em uma frase, para confirmar explicitamente que quer alterar/apagar esses arquivos, e só então repita a operação.`
      : `Comando bloqueado (${reason}). O sandbox é isolado e sem privilégios; esta operação é considerada perigosa e não será executada.`);
    this.reason = reason;
    this.needsAuthorization = needsAuthorization;
    this.blocked = true;
  }
}

// Valida um comando de shell. `pcWriteAuthorized` vem do turno atual.
export function guardCommand(command, { pcWriteAuthorized = false } = {}) {
  const norm = normalizeCommand(command);
  for (const p of GUARD_PATTERNS) {
    if (!p.re.test(norm)) continue;
    if (p.extra && !p.extra.test(norm)) continue;
    throw new BlockedExecutionError(p.msg);
  }
  // Alteração de arquivos REAIS do usuário exige autorização deste turno.
  if (!pcWriteAuthorized && norm.includes(PC_MOUNT_ROOT) && SHELL_MUTATING.test(norm)) {
    throw new BlockedExecutionError('alteração de arquivos das Pastas do PC sem autorização do usuário', { needsAuthorization: true });
  }
  return true;
}

// ---- Código Python -----------------------------------------------------------

// Chamadas que apagam, sobrescrevem ou movem arquivos.
const PY_DESTRUCTIVE = /\b(?:shutil\s*\.\s*(?:rmtree|move|copy|copy2|copyfile|copytree)|os\s*\.\s*(?:remove|unlink|rmdir|removedirs|rename|renames|replace|truncate|chmod|chown)|(?:pathlib\s*\.\s*)?Path\s*\([^)]*\)\s*\.\s*(?:unlink|rmdir|write_text|write_bytes|rename|replace|touch))\s*\(|\.\s*(?:unlink|rmdir|write_text|write_bytes)\s*\(/;

// open(..., 'w'|'a'|'x'|'+') — escrita. O modo pode vir posicional ou nomeado.
const PY_OPEN_WRITE = /\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][rwax+bt]*[wax+][rwax+bt]*['"]/;

// Fuga para o shell com um literal de comando.
const PY_SHELL = /\b(?:os\s*\.\s*(?:system|popen)|subprocess\s*\.\s*(?:run|call|check_call|check_output|Popen))\s*\(/;

// Caminhos de sistema que nunca devem ser alvo de escrita/remoção, mesmo dentro
// do container (evita que um erro do modelo quebre o próprio sandbox).
const PY_SYSTEM_PATH = /['"]\/(?:etc|proc|sys|dev|boot|bin|sbin|lib|lib64|usr|var|root)(?:\/|['"])/;

// Extrai os literais de string de uma linha (para inspecionar o comando embutido).
function stringLiterals(line) {
  const out = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? '');
  return out;
}

// Valida um trecho de código Python antes de executá-lo no sandbox.
// Analisa LINHA A LINHA: uma linha só é bloqueada quando o alvo perigoso e a
// operação perigosa aparecem juntos — assim `shutil.rmtree('build')` dentro do
// workspace continua funcionando normalmente.
export function guardPythonCode(code, { pcWriteAuthorized = false } = {}) {
  const src = String(code || '');
  if (!src.trim()) return true;

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const mutates = PY_DESTRUCTIVE.test(line) || PY_OPEN_WRITE.test(line);

    // 1) Caminho de sistema + operação destrutiva: bloqueado sempre.
    if (mutates && PY_SYSTEM_PATH.test(line)) {
      throw new BlockedExecutionError('escrita ou remoção em caminho de sistema');
    }

    // 2) Pasta do PC (arquivos reais) + operação que altera: exige autorização.
    if (!pcWriteAuthorized && mutates && line.includes(PC_MOUNT_ROOT)) {
      throw new BlockedExecutionError('alteração de arquivos das Pastas do PC sem autorização do usuário', { needsAuthorization: true });
    }

    // 3) Fuga para o shell: o comando embutido passa pela guarda do bash.
    if (PY_SHELL.test(line)) {
      for (const literal of stringLiterals(line)) {
        if (literal.trim()) guardCommand(literal, { pcWriteAuthorized });
      }
    }
  }
  return true;
}

// ---- Autorização explícita do usuário ---------------------------------------

// Espelha `explicitlyAuthorizesSandboxNetwork`: a decisão é do BACKEND, sobre o
// texto do pedido do usuário. O prompt de um assistente nunca amplia acesso.
// Reconhece um pedido claro de ALTERAR/APAGAR/ORGANIZAR arquivos do computador.
export function explicitlyAuthorizesPcWrite(text) {
  const value = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (!value.trim()) return false;

  // Frase negativa mantém a proteção ("não apague nada", "sem alterar os arquivos").
  if (/\b(?:nao|nunca|sem)\b[^\n.]{0,120}\b(?:apagar|apague|excluir|exclua|deletar|delete|alterar|altere|mover|mova|renomear|renomeie|sobrescrever|modificar)\b/.test(value)) return false;

  const verb = /\b(?:apague|apagar|exclua|excluir|delete|deletar|remova|remover|mova|mover|renomeie|renomear|organize|organizar|arrume|arrumar|reorganize|reorganizar|salve|salvar|grave|gravar|escreva|escrever|sobrescreva|sobrescrever|crie|criar|copie|copiar)\b/;
  const target = /\b(?:pasta|pastas|diretorio|diretorios|arquivo|arquivos|documento|documentos|computador|pc|maquina)\b|\/mnt\/pc/;

  // Verbo e alvo na MESMA frase (evita casar "crie uma planilha" + "pasta" solto
  // num outro parágrafo do pedido).
  return value.split(/[.;\n!?]/).some(sentence => verb.test(sentence) && target.test(sentence));
}

// Exportado só para os testes cobrirem a tabela de padrões.
export const __GUARD_PATTERNS = GUARD_PATTERNS;
