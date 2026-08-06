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
export function guardCommand(command, { pcWriteAuthorized = false, networkAllowlist = null } = {}) {
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
  // F-05b: quando a rede está habilitada no sandbox, o allowlist decide
  // para onde o comando pode falar. Se a lista estiver vazia (default),
  // qualquer acesso à rede é bloqueado — fail-closed.
  if (networkAllowlist) guardNetworkEgress(command, { allowlist: networkAllowlist });
  return true;
}

// ---- Allowlist de EGRESS (F-05b) ---------------------------------------------
// Quando o sandbox tem a rede aberta, qualquer destino passa — incluindo
// serviços internos do host, metadados de nuvem (169.254.169.254), outros
// containers na mesma rede Docker. Esta camada fecha esse vazamento no
// nível do comando: o bash/run_python é barrado se tentar falar com um
// destino fora da allowlist configurada.
//
// Formato da allowlist (env SANDBOX_NETWORK_ALLOWLIST, vírgula separa):
//   - domínio literal: api.exemplo.com  → casa com hostname exato
//   - sufixo de domínio: .exemplo.com    → casa com QUALQUER subdomínio
//   - CIDR: 10.0.0.0/8                   → casa com IPs na faixa
//   - IP literal: 192.168.1.5            → casa com o IP exato
//   - porta opcional: api.exemplo.com:443
//
// A allowlist é PURA — não toca em DNS nem em sockets. A defesa real é o
// Docker/network, mas esta camada é o que o usuário vê: a tentativa de
// acessar um destino proibido aparece como "Comando bloqueado" no log.

// Extrai hosts (domínios ou IPs) referenciados pelo comando. Cobre:
//   - URLs em curl/wget/etc.:  https://api.exemplo.com/path
//   - argumentos soltos de curl: curl api.exemplo.com
//   - resoluções DNS explícitas: nslookup/dig/host
//   - IPs literais com porta: 1.2.3.4:8080
//   - pings: ping api.exemplo.com
//   - git: git clone/push/pull/fetch/remote (HTTPS e SSH)
// Não cobre caminhos hardcoded via variáveis, composição em múltiplos
// comandos, ou ferramentas próprias — limitações aceitas (defesa em profundidade).
const HOST_HINT_PATTERNS = [
  // Hostnames + IP opcional. Captura o domínio/IP com captura OPCIONAL
  // da porta: a parte `:NNNN` está dentro do mesmo grupo, então a regex
  // retorna o conjunto completo (host:porta) numa só captura.
  // Inclui `git` (clone/push/fetch/pull/remote/ls-remote) e `go` (go get/etc.)
  // como comandos que geram tráfego de rede arbitrário.
  /\b(?:curl|wget|http(?:ie)?|fetch|invoke-webrequest|nc|netcat|ncat|nslookup|dig|host|traceroute|mtr|nmap|telnet|ssh|scp|rsync|ping|git|go\s+(?:get|install|mod|list))\b[^|;&\n]*?(?:\b(?:--url|-u|--host)\s+|(?:["'`]))?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?)/gi,
  // IPv6 literal em colchetes: [::1], [2001:db8::1], [fe80::1%25eth0].
  // A captura inclui a porta opcional para consistência com o formato de
  // extractHostCandidates. IPv6 não é suportado na allowlist — estes hosts
   // são sempre bloqueados (fail-closed, ver guardNetworkEgress).
  /\[([0-9a-f:]+(?:%[a-z0-9]+)?)\](?::(\d{1,5}))?/gi
];

// CIDR simples: suporta IPv4. IPv6 literal é bloqueado antes de chegar
// aqui (guardNetworkEgress rejeita qualquer host IPv6 — fail-closed, ver
// extractHostCandidates e o padrão de colchetes nos HOST_HINT_PATTERNS).
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

function cidrContains(cidr, ip) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt == null || ipInt == null) return false;
  // Máscara de rede: primeiros `bits` bits em 1, resto em 0. Ex.: /8 →
  // 0xFF000000. A operação `~` em JS devolve inteiro com sinal; o `>>> 0`
  // converte para unsigned de 32 bits.
  const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
  return ((baseInt & mask) >>> 0) === ((ipInt & mask) >>> 0);
}

// Compila a allowlist (string ou array) em uma estrutura de matching.
// `rules` é uma lista de entradas; cada entrada pode ser:
//   - string: como acima (domínio/CIDR/IP) — strings com vírgula viram
//     múltiplas entradas (formato da env SANDBOX_NETWORK_ALLOWLIST)
//   - objeto: { kind: 'domain'|'suffix'|'cidr'|'ip', value, port? }
export function compileNetworkAllowlist(rules) {
  const list = [];
  if (Array.isArray(rules)) {
    for (const r of rules) {
      if (typeof r === 'string') list.push(...parseAllowlistString(r));
      else if (r && typeof r === 'object') list.push(r);
    }
  } else if (typeof rules === 'string') {
    list.push(...parseAllowlistString(rules));
  }
  return list;
}

// Uma string pode trazer várias regras separadas por vírgula. Cada
// "fatia" vira uma (ou mais) entradas estruturadas via parseAllowlistEntry.
function parseAllowlistString(s) {
  return String(s || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap(part => parseAllowlistEntry(part));
}

function parseAllowlistEntry(entry) {
  if (!entry) return [];
  const raw = String(entry).trim().toLowerCase();
  // CIDR detectado ANTES de strip de path — senão "10.0.0.0/8" virava
  // "10.0.0.0" e era classificado como IP.
  if (/^https?:\/\//.test(raw)) {
    // Strip do scheme só.
    const noScheme = raw.replace(/^https?:\/\//, '');
    return parseAllowlistEntry(noScheme);
  }
  if (/\/\d{1,2}$/.test(raw) && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(raw)) {
    return [{ kind: 'cidr', value: raw }];
  }
  const cleaned = raw.replace(/\/.*$/, '');
  if (!cleaned) return [];
  // IP literal
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(cleaned)) {
    const [ip, port] = cleaned.split(':');
    return [{ kind: 'ip', value: ip, port: port ? Number(port) : null }];
  }
  // Domínio com sufixo (.exemplo.com → "qualquer subdomínio")
  if (cleaned.startsWith('.')) return [{ kind: 'suffix', value: cleaned.slice(1) }];
  // Domínio exato (opcionalmente com porta)
  const [host, port] = cleaned.split(':');
  return [{ kind: 'domain', value: host, port: port ? Number(port) : null }];
}

export { parseAllowlistEntry };

// Verifica se um host (com porta opcional) casa com a allowlist.
//
// Regras de porta (intuitivas):
//   - regra SEM porta → casa com QUALQUER porta (e com chamada sem porta)
//   - regra COM porta X → só casa se a chamada tiver porta X
//     (chamada sem porta = "porta padrão do protocolo"; não casa)
export function hostMatchesAllowlist(host, port, compiled) {
  if (!host || !compiled || !compiled.length) return false;
  const hostname = String(host).toLowerCase().trim();
  for (const rule of compiled) {
    // A regra TEM porta: a chamada PRECISA ter a mesma porta (sem
    // fallback para "porta padrão"). É o caminho conservador — o operador
    // que quis expor 443 não aceitou 80 por tabela.
    if (rule.port != null) {
      if (port == null) continue;
      if (rule.port !== port) continue;
    }
    if (rule.kind === 'domain' && hostname === rule.value) return true;
    if (rule.kind === 'suffix' && (hostname === rule.value || hostname.endsWith('.' + rule.value))) return true;
    if (rule.kind === 'ip' && ipv4ToInt(hostname) === ipv4ToInt(rule.value)) return true;
    if (rule.kind === 'cidr' && cidrContains(rule.value, hostname)) return true;
  }
  return false;
}

// Extrai candidatos a host do comando. Útil para diagnóstico e para o
// teste de unidade. Não tenta ser exaustivo — cobre o que aparece com
// frequência real (curl/wget/ping/etc.).
//
// A porta é detectada por um padrão que casa `:NNNN` em QUALQUER posição
// (não só no fim) — o regex de captura já inclui a porta opcional, então
// aqui só separamos o que veio colado no host. Separamos só a porta
// final (última ocorrência de `:NNNN` no token) para evitar confundir
// `host:8080:9090` ou `http://host:8080/path` (que o regex já trata).
export function extractHostCandidates(command) {
  const out = new Set();
  for (const re of HOST_HINT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(command || '')) !== null) {
      // O regex de IPv6 captura o hex em m[1] e a porta em m[2] (ou undefined).
      // O regex de hostname captura host:porta opcional junto em m[1].
      // Detecta IPv6 pelo match completo (m[0]) que contém colchetes [::1].
      const isV6 = String(m[0] || '').startsWith('[');
      const raw = String(m[2] !== undefined ? `[${m[1]}]:${m[2]}` : (isV6 ? `[${m[1]}]` : (m[1] || '')));
      // `:NNNN` é a porta se vier ANTES de qualquer `/` ou `?` (separador
      // de path/query). Aceita só dígitos (1-5) para não confundir com
      // literais que porventura tenham `:` no domínio.
      const portMatch = raw.match(/:(\d{1,5})(?=[/?#]|$)/);
      const host = portMatch ? raw.slice(0, -portMatch[0].length) : raw;
      const port = portMatch ? Number(portMatch[1]) : null;
      out.add(JSON.stringify({ host, port, v6: isV6 }));
    }
  }
  return [...out].map(s => JSON.parse(s));
}

// Verifica TODOS os hosts extraídos do comando contra a allowlist. Se
// algum não casa, lança BlockedExecutionError. Com allowlist VAZIA, qualquer
// host (e portanto o comando inteiro) é barrado.
export function guardNetworkEgress(command, { allowlist } = {}) {
  const compiled = compileNetworkAllowlist(allowlist);
  const hosts = extractHostCandidates(command);
  if (!hosts.length) return true; // nada de rede detectado no comando
  for (const { host, port, v6 } of hosts) {
    // IPv6 literal NÃO é suportado na allowlist: a sintaxe é diferente
    // (notação hex com `:`) e a complexidade adicional não se justifica
    // pelo volume de uso real em sandbox. Fail-closed: bloqueia com
    // mensagem clara para o modelo/usuário ajustar o pedido.
    if (v6) {
      throw new BlockedExecutionError(`acesso à rede bloqueado: endereço IPv6 literal '${host}' não é suportado na allowlist do sandbox`);
    }
    if (!hostMatchesAllowlist(host, port, compiled)) {
      // Mensagem aponta o destino não autorizado — feedback para o modelo
      // ajustar o pedido (ou para o usuário revisar a allowlist).
      throw new BlockedExecutionError(`acesso à rede bloqueado: destino '${host}${port ? ':' + port : ''}' não está na allowlist do sandbox`);
    }
  }
  return true;
}

// Lê a allowlist da env. Lista vazia = fail-closed (qualquer acesso à
// rede é bloqueado). Para uma allowlist permissiva, defina
// SANDBOX_NETWORK_ALLOWLIST="api.openai.com,github.com,.pypi.org,8.8.8.8".
export function networkAllowlistFromEnv() {
  const raw = String(process.env.SANDBOX_NETWORK_ALLOWLIST || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
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
