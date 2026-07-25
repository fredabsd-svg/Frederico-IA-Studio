#!/usr/bin/env node
// Conta os testes do projeto EXECUTANDO-OS, e imprime o resumo em Markdown.
//
// Motivo: a documentação trazia números de testes escritos à mão, que envelhecem
// em silêncio ("452 testes" continua no README muito depois de o número mudar).
// O CI chama este script e publica o resultado no resumo da execução — a fonte
// do número passa a ser a execução real, não a memória de quem escreveu o texto.
//
// Uso: node scripts/count-tests.mjs [--markdown]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SUITES = [
  { nome: 'Backend (Node)', cwd: path.join(repoRoot, 'backend'), cmd: process.execPath, args: ['--test', 'src/**/*.test.js'] },
  { nome: 'Frontend (Node)', cwd: path.join(repoRoot, 'frontend'), cmd: process.execPath, args: ['--test', 'src/**/*.test.js'] },
  { nome: 'Sandbox (Python)', cwd: repoRoot, cmd: 'python3', args: ['-m', 'unittest', 'discover', '-s', 'sandbox', '-p', '*_test.py', '-v'] }
];

function parseNode(output) {
  const pick = (label) => Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(output)?.[1] ?? 0);
  return { total: pick('tests'), pass: pick('pass'), fail: pick('fail'), skip: pick('skipped') };
}

function parsePython(output) {
  const total = Number(/^Ran (\d+) tests?/m.exec(output)?.[1] ?? 0);
  const failed = Number(/failures=(\d+)/.exec(output)?.[1] ?? 0) + Number(/errors=(\d+)/.exec(output)?.[1] ?? 0);
  const skip = Number(/skipped=(\d+)/.exec(output)?.[1] ?? 0);
  return { total, pass: total - failed - skip, fail: failed, skip };
}

const linhas = [];
let algumaFalha = false;
let somaTotal = 0;

for (const suite of SUITES) {
  const run = spawnSync(suite.cmd, suite.args, { cwd: suite.cwd, encoding: 'utf8', shell: false });
  const saida = `${run.stdout || ''}\n${run.stderr || ''}`;
  if (run.error) {
    linhas.push(`| ${suite.nome} | — | — | — | indisponível (${run.error.code}) |`);
    continue;
  }
  const r = suite.nome.includes('Python') ? parsePython(saida) : parseNode(saida);
  somaTotal += r.total;
  if (r.fail > 0) algumaFalha = true;
  linhas.push(`| ${suite.nome} | ${r.total} | ${r.pass} | ${r.fail} | ${r.skip} |`);
}

const tabela = [
  '| Suíte | Testes | Passaram | Falharam | Pulados |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...linhas,
  `| **Total** | **${somaTotal}** | | | |`
].join('\n');

console.log(tabela);
process.exit(algumaFalha ? 1 : 0);
