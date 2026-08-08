// REVIEW GATE (Fase 28) e painel de confiança (Fase 44) do Developer
// Workspace 3.0.
//
// Antes de a tarefa se declarar entregue, o backend passa um pente FINO e
// AUTOMÁTICO no que foi realmente alterado — o ChangeSet real do git (Frente
// 18) e o diff das linhas adicionadas —, procurando o que uma revisão humana
// procuraria primeiro: segredo commitado, código de depuração esquecido, TODO
// temporário, mudança destrutiva e alteração fora do escopo do plano.
//
// Princípios (os mesmos do resto do app):
//  - NADA aqui é opinião do modelo: são sinais medidos no diff. O modelo não
//    "se autoavalia" — ele recebe os achados como fato e precisa tratá-los;
//  - achado não é veredito de qualidade: é evidência para o usuário decidir.
//    Um `blocker` NÃO impede a publicação por conta própria — ele aparece no
//    painel e no prompt, e a autorização continua sendo do usuário;
//  - falso positivo é esperado e barato (o achado cita arquivo e linha);
//    falso NEGATIVO é o que custa caro, então na dúvida o sinal aparece.

export const REVIEW_SEVERITIES = Object.freeze(['blocker', 'high', 'medium', 'low']);

const SEVERITY_RANK = { blocker: 0, high: 1, medium: 2, low: 3 };

// Padrões de SEGREDO em linha adicionada. Conservadores de propósito: exigem
// atribuição a um valor com cara de credencial, não a mera palavra "token".
const SECRET_PATTERNS = [
  { re: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/, label: 'chave de API no formato sk-/rk-' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, label: 'token do GitHub' },
  { re: /\bAKIA[0-9A-Z]{12,}/, label: 'chave de acesso AWS' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, label: 'chave privada' },
  { re: /\b(?:api[_-]?key|secret|senha|password|passwd|token|authorization)\s*[:=]\s*["'][^"'\s]{12,}["']/i, label: 'credencial atribuída em texto' },
  { re: /postgres(?:ql)?:\/\/[^\s:@"']+:[^\s@"']+@/i, label: 'string de conexão com senha' }
];

// Código de depuração esquecido, por linguagem provável do arquivo.
const DEBUG_PATTERNS = [
  { re: /\bconsole\.(?:log|debug|dir)\s*\(/, label: 'console.log', exts: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'] },
  { re: /\bdebugger\s*;?/, label: 'debugger', exts: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'] },
  { re: /\bbreakpoint\(\)|\bpdb\.set_trace\s*\(/, label: 'breakpoint do Python', exts: ['.py'] },
  { re: /^\s*print\s*\(/, label: 'print de depuração', exts: ['.py'] },
  { re: /\bdd\s*\(|\bvar_dump\s*\(/, label: 'dump de depuração', exts: ['.php'] }
];

const TODO_RE = /\b(?:TODO|FIXME|XXX|HACK|GAMBIARRA)\b/;
// Testes desligados (o oposto de "teste faltando": o teste existe e foi calado).
const SKIPPED_TEST_RE = /\b(?:it|test|describe)\.(?:skip|only)\b|@unittest\.skip|\bxit\s*\(|\bxdescribe\s*\(/;

const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\//i;
const TEST_NAME_RE = /\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$|^test_/i;
// Arquivos cuja REMOÇÃO ou alteração merece um olhar humano.
const SENSITIVE_PATH_RE = /(?:^|\/)(?:\.env|\.env\..+|docker-compose\.ya?ml|Dockerfile|\.github\/workflows\/|migrations?\/|package-lock\.json|yarn\.lock)/i;

// Páginas que a validação por navegador (Fase 38) sabe abrir.
const PAGE_FILE_RE = /\.x?html?$/i;

const extOf = (filePath) => {
  const name = String(filePath || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

export function isTestFile(filePath) {
  const name = String(filePath || '');
  return TEST_FILE_RE.test(name) || TEST_NAME_RE.test(name.split('/').pop() || '');
}

// Linhas ADICIONADAS de um `git diff` unificado, por arquivo. Só o que entrou
// interessa: apontar um console.log que já existia no repositório seria ruído.
export function addedLinesByFile(diffText) {
  const byFile = new Map();
  let current = null;
  let lineNumber = 0;
  for (const raw of String(diffText || '').split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (raw.startsWith('@@')) {
      // @@ -a,b +c,d @@ → a próxima linha adicionada é a `c`.
      const match = /\+(\d+)/.exec(raw);
      lineNumber = match ? Number(match[1]) : 0;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      byFile.get(current).push({ line: lineNumber, text: raw.slice(1) });
      lineNumber += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      lineNumber += 1;
    }
  }
  return byFile;
}

function finding(severity, kind, message, { file = null, line = null } = {}) {
  return { severity, kind, message, ...(file ? { file } : {}), ...(line ? { line } : {}) };
}

// VALIDAÇÃO POR NAVEGADOR → REVIEW GATE (Fase 38 alimentando a Fase 28).
//
// O gate mede o diff; a `validar_pagina` mede a página renderizada. Eram duas
// evidências que não se falavam: uma página podia reprovar no navegador — tela
// em branco, erro de console — e a entrega se apresentar limpa, porque o diff
// não tem como saber disso.
//
// Três sinais, e a diferença de peso entre eles é a decisão deste bloco:
//
//   * página REPROVADA no navegador é `high`: é defeito MEDIDO, no mesmo nível
//     de "código alterado sem teste";
//   * página HTML alterada e NUNCA validada é `medium`: é ausência de
//     evidência, não evidência de defeito — o irmão do `missing_test`;
//   * validação que não pôde rodar (sem Chromium no ambiente) é `low`, e
//     existe para uma coisa só: impedir que a entrega diga "validado" quando
//     nada foi validado.
export function pageCheckFindings(pageChecks = [], files = []) {
  const findings = [];
  const checks = Array.isArray(pageChecks) ? pageChecks.filter(Boolean) : [];
  // Só a checagem com veredito conta como validação: um erro de caminho ou
  // uma página inexistente é tentativa, não prova.
  const conclusivos = checks.filter(check => typeof check.ok === 'boolean');

  for (const check of conclusivos) {
    if (check.ok) continue;
    const alvo = check.pagina || check.url || 'a página';
    const problemas = Array.isArray(check.problemas) ? check.problemas : [];
    const detalhe = problemas.slice(0, 3).join(' | ');
    findings.push(finding(
      'high',
      'page_check',
      `A página reprovou na validação por navegador (${problemas.length} problema${problemas.length === 1 ? '' : 's'} medido${problemas.length === 1 ? '' : 's'})${detalhe ? `: ${detalhe}` : '.'}`,
      { file: typeof alvo === 'string' ? alvo : null }
    ));
  }

  for (const check of checks) {
    if (check.disponivel === false) {
      findings.push(finding('low', 'page_check_unavailable',
        `A validação por navegador NÃO rodou neste ambiente${check.observacao ? ` (${String(check.observacao).slice(0, 160)})` : ''}. Não apresente a página como validada.`));
    }
  }

  // Página alterada sem nenhuma validação conclusiva. Arquivo apagado não
  // conta (não há o que abrir) e arquivo de teste também não.
  const paginasAlteradas = (files || [])
    .filter(file => file.status !== 'D' && PAGE_FILE_RE.test(file.path || '') && !isTestFile(file.path));
  if (paginasAlteradas.length && !conclusivos.length) {
    findings.push(finding('medium', 'missing_page_check',
      `${paginasAlteradas.length} página HTML alterada sem validação no navegador (ex.: ${paginasAlteradas.slice(0, 3).map(f => f.path).join(', ')}). Rode validar_pagina: import quebrado e tela em branco não aparecem no diff.`));
  }

  return findings;
}

// O pente fino. `changes` é o ChangeSet real (agent/changeSet.js), `diffText` o
// `git diff HEAD` correspondente, `plan` o plano estruturado (update_plan) e
// `pageChecks` os vereditos da `validar_pagina` desta execução (Fase 38).
export function reviewFindings({ changes = null, diffText = '', plan = null, pageChecks = [] } = {}) {
  const findings = [];
  const files = (changes?.repos || []).flatMap(repo => repo.files || []);
  if (!files.length) return findings;

  const added = addedLinesByFile(diffText);
  for (const [filePath, lines] of added) {
    const ext = extOf(filePath);
    for (const { line, text } of lines) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(text)) {
          findings.push(finding('blocker', 'secret', `Possível ${pattern.label} em linha adicionada. Confirme que não é credencial real antes de publicar.`, { file: filePath, line }));
          break;
        }
      }
      for (const pattern of DEBUG_PATTERNS) {
        if (pattern.exts.includes(ext) && pattern.re.test(text)) {
          findings.push(finding('medium', 'debug', `Código de depuração adicionado (${pattern.label}).`, { file: filePath, line }));
          break;
        }
      }
      if (TODO_RE.test(text)) {
        findings.push(finding('low', 'todo', 'TODO/FIXME adicionado — confirme se é intencional ou pendência esquecida.', { file: filePath, line }));
      }
      if (SKIPPED_TEST_RE.test(text)) {
        findings.push(finding('high', 'skipped_test', 'Teste marcado como skip/only em linha adicionada — a suíte pode passar sem exercitar o caso.', { file: filePath, line }));
      }
    }
  }

  // Sinais no NÍVEL DO ARQUIVO (não dependem do diff textual).
  const touchedTests = files.some(file => isTestFile(file.path));
  const touchedCode = files.some(file => !isTestFile(file.path) && /\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|rb|php)$/i.test(file.path));
  for (const file of files) {
    if (file.status === 'D') {
      findings.push(finding(SENSITIVE_PATH_RE.test(file.path) ? 'high' : 'medium', 'deletion', `Arquivo removido${SENSITIVE_PATH_RE.test(file.path) ? ' (caminho sensível)' : ''} — confirme que a remoção é intencional.`, { file: file.path }));
    } else if (SENSITIVE_PATH_RE.test(file.path)) {
      findings.push(finding('medium', 'sensitive_path', 'Alteração em arquivo de infraestrutura/configuração — revise o impacto em ambientes.', { file: file.path }));
    }
  }
  if (touchedCode && !touchedTests) {
    findings.push(finding('high', 'missing_test', 'Código alterado sem nenhum arquivo de teste tocado. Se a mudança tem comportamento observável, ela deveria vir com teste.'));
  }

  // ESCOPO: passos do plano marcados como concluídos citam arquivos que não
  // aparecem no ChangeSet, ou o inverso — arquivos alterados que nenhum passo
  // menciona. Só roda quando há plano com evidência (senão viraria ruído).
  const planText = (plan?.steps || []).map(step => `${step.title} ${step.evidence || ''}`).join(' ');
  if (planText.trim()) {
    const foraDoPlano = files
      .filter(file => !isTestFile(file.path))
      .filter(file => {
        const base = file.path.split('/').pop();
        return base && !planText.includes(base) && !planText.includes(file.path);
      });
    // Um ou dois arquivos não citados é normal; muitos indicam trabalho fora do
    // que foi planejado — que é exatamente a pergunta 2 da Fase 28.
    if (foraDoPlano.length >= 3) {
      findings.push(finding('medium', 'scope', `${foraDoPlano.length} arquivos alterados não são mencionados por nenhum passo do plano (ex.: ${foraDoPlano.slice(0, 3).map(f => f.path).join(', ')}). Confirme se estão no escopo da missão.`));
    }
  }

  // Evidência do NAVEGADOR (Fase 38), ao lado da evidência do diff.
  findings.push(...pageCheckFindings(pageChecks, files));

  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// Resumo para o painel de confiança (Fase 44) e para o `execution_meta`.
export function summarizeReview(findings = []) {
  const counts = { blocker: 0, high: 0, medium: 0, low: 0 };
  for (const item of findings) if (counts[item.severity] != null) counts[item.severity] += 1;
  return {
    total: findings.length,
    counts,
    // "Limpo" é a ausência de achado alto/bloqueante — não a ausência de
    // qualquer sinal (um TODO não desqualifica a entrega).
    clean: counts.blocker === 0 && counts.high === 0,
    findings: findings.slice(0, 40)
  };
}

// Nota entregue ao MODELO quando há achados: ele precisa tratá-los (corrigir ou
// justificar) ANTES de pedir a publicação — e nunca escondê-los do usuário.
export function reviewNote(summary) {
  if (!summary?.total) return '';
  const partes = REVIEW_SEVERITIES
    .filter(sev => summary.counts[sev])
    .map(sev => `${summary.counts[sev]} ${sev}`)
    .join(', ');
  const lista = summary.findings.slice(0, 10)
    .map(f => `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : ''}${f.message}`)
    .join('\n');
  return `REVISÃO AUTOMÁTICA DAS SUAS ALTERAÇÕES (${partes}). Estes achados vêm do diff REAL, não de opinião:\n${lista}\n\nAntes de concluir: corrija o que for defeito e, para o que for intencional, diga ao usuário em UMA linha por item por que está correto. NÃO peça autorização de publicação sem tratar os achados "blocker" e "high". Não esconda nenhum deles.`;
}
