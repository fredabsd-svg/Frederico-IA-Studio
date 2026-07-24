// Análise de bugs (seção 7) — lógica PURA e local: a partir da mensagem de erro
// e do stack trace, deriva severidade, arquivos/linhas envolvidos e pistas de
// causa raiz. Não substitui a análise do modelo; dá o ponto de partida estruturado
// e as evidências (nada de diagnóstico sem base — seção 27).

// Pistas de causa raiz por padrão conhecido. A primeira que casar vence.
const CAUSE_HINTS = [
  { re: /econnrefused|connection refused|recusad/i, cause: 'Conexão recusada — serviço fora do ar, porta errada, credenciais ou rede do container.', kind: 'infra' },
  { re: /etimedout|timeout|timed out/i, cause: 'Tempo esgotado — latência alta, deadlock, serviço lento ou dependência travada.', kind: 'infra' },
  { re: /enotfound|getaddrinfo|dns/i, cause: 'Host não resolvido — DNS, nome do serviço ou rede do container.', kind: 'infra' },
  { re: /enoent|no such file|arquivo n[aã]o encontrad/i, cause: 'Arquivo/caminho inexistente — path errado ou artefato não gerado.', kind: 'io' },
  { re: /eacces|permission denied|permiss[aã]o negad/i, cause: 'Permissão negada — dono/modo do arquivo ou usuário do processo.', kind: 'permissao' },
  { re: /eaddrinuse|address already in use|porta.*uso/i, cause: 'Porta já em uso — outro processo/container ocupando a porta.', kind: 'infra' },
  { re: /null pointer|nullpointer|cannot read propert|of undefined|of null|undefined is not/i, cause: 'Valor nulo/indefinido não tratado antes do uso.', kind: 'codigo' },
  { re: /is not a function|not callable/i, cause: 'Chamada de algo que não é função — import errado ou API mudou.', kind: 'codigo' },
  { re: /syntaxerror|parse error|unexpected token/i, cause: 'Erro de sintaxe/parse — JSON, código ou configuração malformada.', kind: 'codigo' },
  { re: /module not found|cannot find module|importerror|modulenotfound/i, cause: 'Módulo/dependência ausente — pacote não instalado ou caminho errado.', kind: 'dependencia' },
  { re: /out of memory|oom|heap out of|memoryerror/i, cause: 'Memória esgotada — vazamento, lote grande demais ou limite baixo.', kind: 'recurso' },
  { re: /deadlock|lock wait|could not obtain lock/i, cause: 'Deadlock/contenção de lock no banco.', kind: 'banco' },
  { re: /duplicate key|unique constraint|violates.*constraint/i, cause: 'Violação de restrição no banco — chave duplicada ou integridade.', kind: 'banco' },
  { re: /401|unauthorized|invalid token|authentication failed|autentica[çc][aã]o/i, cause: 'Falha de autenticação — token/credencial inválido ou expirado.', kind: 'seguranca' },
  { re: /403|forbidden|access denied/i, cause: 'Acesso proibido — permissão/escopo insuficiente.', kind: 'seguranca' },
  { re: /429|rate limit|too many requests/i, cause: 'Limite de requisições atingido — throttling do provedor/API.', kind: 'infra' },
  { re: /5\d\d|internal server error|bad gateway|service unavailable/i, cause: 'Erro do servidor/upstream — serviço externo ou API instável.', kind: 'infra' },
];

// Severidade pela natureza do erro.
export function guessSeverity(message = '') {
  const m = String(message);
  if (/fatal|panic|segfault|out of memory|corrupt|data loss|security|sql injection|rce/i.test(m)) return 'critica';
  if (/error|exception|failed|falh|refused|denied|traceback/i.test(m)) return 'alta';
  if (/warn|alerta|deprecat/i.test(m)) return 'media';
  return 'baixa';
}

// Extrai caminhos de arquivo e linha do stack trace (Node e Python).
export function extractFiles(stack = '') {
  const s = String(stack || '');
  const files = new Map(); // path -> Set(linhas)
  // Node: "at fn (/a/b.js:12:5)" ou "/a/b.js:12"
  // Python: 'File "/a/b.py", line 12'
  const patterns = [
    /(?:at\s+[^(]*\()?([\/\w.\-]+\.\w+):(\d+)(?::\d+)?\)?/g,
    /File\s+"([^"]+\.\w+)",\s+line\s+(\d+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s)) !== null) {
      const file = m[1];
      if (/node_modules|site-packages|<anonymous>|internal\//.test(file)) continue; // ignora libs/internos
      if (!files.has(file)) files.set(file, new Set());
      files.get(file).add(Number(m[2]));
    }
  }
  return [...files.entries()].map(([file, lines]) => ({ file, lines: [...lines].sort((a, b) => a - b) })).slice(0, 20);
}

// Análise completa (pura). Retorna { severity, probableCause, causeKind, files,
// firstFrame, confidence }. `confidence` é baixa quando nada casou (transparência).
export function analyzeBug({ errorMessage = '', stack = '' } = {}) {
  const text = `${errorMessage}\n${stack}`;
  const hit = CAUSE_HINTS.find(h => h.re.test(text));
  const files = extractFiles(stack || errorMessage);
  return {
    severity: guessSeverity(errorMessage || stack),
    probableCause: hit ? hit.cause : 'Causa não identificada por padrão conhecido — precisa de investigação.',
    causeKind: hit ? hit.kind : 'desconhecido',
    files,
    firstFrame: files[0] || null,
    confidence: hit ? (files.length ? 70 : 55) : (files.length ? 40 : 20),
  };
}
