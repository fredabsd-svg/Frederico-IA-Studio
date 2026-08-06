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

// ---- Git REMOTO no sandbox ----------------------------------------------------
//
// O token do GitHub NUNCA entra no sandbox (ver connectors/github.js): clone,
// push e Pull Request rodam no backend. Então `git push` pelo bash do sandbox
// não é uma alternativa que às vezes funciona — é uma operação que SEMPRE falha,
// por falta de credencial e (por padrão) de rede. Sem este bloqueio, a falha
// chegava ao modelo como um erro de rede genérico e ele insistia: tentava outra
// vez, tentava `GIT_SSL_NO_VERIFY`, tentava abrir o github.com no navegador —
// minutos de etapas queimadas por um caminho que não existe.
//
// Aqui a recusa é explícita e aponta a ferramenta certa. Git LOCAL (status,
// diff, add, commit, log, branch, checkout, config, stash...) continua liberado:
// é assim que o agente trabalha no clone.
const REMOTE_GIT_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

export const REMOTE_GIT_MESSAGE =
  'operação Git remota no sandbox. Operações Git remotas são executadas pelo conector seguro do backend '
  + '(o sandbox não tem credencial nem rede para o GitHub). Use github_clone, github_push ou github_create_pr. '
  + 'Git local (status, diff, add, commit, log, branch) continua disponível pelo bash.';

// Devolve o subcomando remoto do git presente no comando, ou null. PURA
// (testável). Anda pelos tokens depois de `git`, pulando as opções globais
// (`-c chave=valor`, `-C dir`, `--git-dir=...`), para nunca confundir o texto
// livre de um `git commit -m "fetch dos dados"` com um subcomando.
export function remoteGitSubcommand(command) {
  const text = String(command || '');
  // Cada segmento de um comando composto é analisado por conta própria.
  for (const segment of text.split(/\n|&&|\|\||[;|&]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Prefixos de ambiente (`GIT_SSL_NO_VERIFY=1 git push`) não são o comando.
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
    // O `git` tem de estar na POSIÇÃO DE COMANDO do segmento. Procurar `git` em
    // qualquer posição pegaria `echo "git push" >> README.md` — texto, não
    // execução — e bloquearia um comando inofensivo.
    const cmd = String(tokens[i] || '').replace(/^['"]|['"]$/g, '');
    if (cmd !== 'git' && !/(^|\/)git$/.test(cmd)) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const opt = tokens[j];
      if (opt === '-c' || opt === '-C' || opt === '--exec-path' || opt === '--namespace') { j += 2; continue; }
      if (opt.startsWith('-')) { j += 1; continue; }
      break;
    }
    const sub = String(tokens[j] || '').replace(/^['"]|['"]$/g, '').toLowerCase();
    if (REMOTE_GIT_SUBCOMMANDS.has(sub)) return sub;
    // `git remote add <nome> <url>` também alcança a rede na prática (e
    // reescreveria o remoto do clone que o backend preparou).
    if (sub === 'remote') {
      const action = String(tokens[j + 1] || '').toLowerCase();
      if (action === 'add' || action === 'set-url' || action === 'update' || action === 'prune') return `remote ${action}`;
    }
  }
  return null;
}

// Valida um comando de shell. `pcWriteAuthorized` vem do turno atual.
export function guardCommand(command, { pcWriteAuthorized = false, networkAllowlist = null } = {}) {
  const norm = normalizeCommand(command);
  for (const p of GUARD_PATTERNS) {
    if (!p.re.test(norm)) continue;
    if (p.extra && !p.extra.test(norm)) continue;
    throw new BlockedExecutionError(p.msg);
  }
  const remoteGit = remoteGitSubcommand(command);
  if (remoteGit) throw new BlockedExecutionError(`git ${remoteGit} — ${REMOTE_GIT_MESSAGE}`);
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
  //
  // `git` NÃO entra nesta lista de propósito — ver o padrão dedicado abaixo.
  // O IPv6 vem PRIMEIRO de propósito: `extractHostCandidates` apaga os
  // trechos que ele casa antes de rodar os demais, senão o padrão de
  // hostname colhe lixo de dentro dos colchetes (`2001:db8:` em
  // `https://[2001:db8::1]/f`) e reporta um destino que não existe.
  // IPv6 literal em colchetes: [::1], [2001:db8::1], [fe80::1%25eth0].
  //
  // DUAS âncoras, porque `[0-9a-f:]` sozinho é um filtro fraco demais:
  // `lista[0:5]` (fatiamento de Python — uso diário do run_python) casava e
  // virava "endereço IPv6 bloqueado".
  //   1. contexto de rede: logo após `://` (forma de URL) ou após um comando
  //      que recebe host direto (`ping [::1]`);
  //   2. forma de IPv6 de verdade: precisa conter `::` ou ao menos dois `:`.
  //      Um `[0:5]` tem um só.
  // A porta opcional vem em captura separada (m[2]).
  { v6: true, re: /(?:\/\/|\b(?:ping|ssh|scp|rsync|nc|netcat|ncat|telnet|traceroute|mtr|nmap|dig|host|nslookup)\s+)\[((?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}(?:%[a-z0-9]+)?)\](?::(\d{1,5}))?/gi },

  { v6: false, re: /\b(?:curl|wget|http(?:ie)?|fetch|invoke-webrequest|nc|netcat|ncat|nslookup|dig|host|traceroute|mtr|nmap|telnet|ssh|scp|rsync|ping|go\s+(?:get|install|mod|list))\b[^|;&\n]*?(?:\b(?:--url|-u|--host)\s+|(?:["'`]))?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?)/gi },

  // `git` precisa de padrão PRÓPRIO, ancorado em URL. O padrão genérico acima
  // varre tudo que parece domínio depois do comando — o que serve para o
  // `curl` (que só recebe URL) e é desastroso para o `git`, que recebe texto
  // livre: `git commit -m "corrige o site.com"` e `git config user.email
  // joao@exemplo.com` viravam "acesso à rede bloqueado". Isso derrubaria o
  // conector GitHub, que faz exatamente essas chamadas.
  // Aqui só conta o que tem FORMA de endereço remoto: `https://host/...`,
  // `ssh://host/...` ou `git@host:caminho`.
  // O `user@host` do remoto SSH exige `:caminho` logo depois (o lookahead) —
  // sem isso, `git config user.email joao@exemplo.com` casaria, porque e-mail
  // e remoto SSH têm a mesma forma até o host.
  { v6: false, re: /\bgit\b[^|;&\n]*?(?:(?:https?|ssh|git):\/\/(?:[^@\s/]+@)?|[a-z0-9._-]+@(?=[a-z0-9.-]+:))((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::\d{1,5})?)/gi }
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
  // O IPv6 é varrido PRIMEIRO e some do texto antes do padrão genérico rodar:
  // `https://[2001:db8::1]/f` faria o padrão de hostname colher `2001:db8:` de
  // dentro dos colchetes e reportar um destino que não existe.
  let restante = String(command || '');
  for (const { v6, re } of HOST_HINT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    const trechosV6 = [];
    while ((m = re.exec(restante)) !== null) {
      // No padrão de IPv6 o hex vem em m[1] e a porta em m[2]; nos demais, o
      // par host:porta vem junto em m[1].
      const raw = v6
        ? (m[2] !== undefined ? `[${m[1]}]:${m[2]}` : `[${m[1]}]`)
        : String(m[1] || '');
      if (v6) trechosV6.push([m.index, m.index + m[0].length]);
      // `:NNNN` é a porta se vier ANTES de qualquer `/` ou `?` (separador
      // de path/query). Aceita só dígitos (1-5) para não confundir com
      // literais que porventura tenham `:` no domínio.
      const portMatch = raw.match(/:(\d{1,5})(?=[/?#]|$)/);
      const host = portMatch ? raw.slice(0, -portMatch[0].length) : raw;
      const port = portMatch ? Number(portMatch[1]) : null;
      out.add(JSON.stringify({ host, port, v6 }));
    }
    if (v6 && trechosV6.length) {
      // Substitui por espaços (preserva índices) para o próximo padrão não ver.
      const chars = [...restante];
      for (const [ini, fim] of trechosV6) for (let i = ini; i < fim; i++) chars[i] = ' ';
      restante = chars.join('');
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
