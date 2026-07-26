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

// Usa o MESMO runner dos scripts `npm test` (scripts/run-tests.mjs): a expansão
// de glob do `node --test` só existe no Node 22+, e a contagem precisa bater com
// o que o CI realmente executa, em qualquer versão.
const SUITES = [
  { nome: 'Backend (Node)', cwd: path.join(repoRoot, 'backend'), cmd: process.execPath, args: ['scripts/run-tests.mjs'] },
  { nome: 'Frontend (Node)', cwd: path.join(repoRoot, 'frontend'), cmd: process.execPath, args: [path.join(repoRoot, 'frontend', 'scripts', 'run-tests.mjs')] },
  { nome: 'Guarda do Docker', cwd: path.join(repoRoot, 'docker-guard'), cmd: process.execPath, args: [path.join(repoRoot, 'docker-guard', 'scripts', 'run-tests.mjs')] },
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

// Ponta a ponta (e2e/): LISTADOS, não executados aqui. Rodá-los exigiria
// PostgreSQL, navegador e os três servidores de pé — caro demais para um script
// de contagem, e este roda na máquina de quem escreve documentação. O
// `playwright test --list` dá o número honesto sem subir nada. Quem executa de
// verdade é o job "Ponta a ponta (navegador real)" do CI.
const e2e = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=list'], {
  cwd: path.join(repoRoot, 'e2e'), encoding: 'utf8', shell: false
});
const e2eSaida = `${e2e.stdout || ''}\n${e2e.stderr || ''}`;
const e2eTotal = Number(/^Total: (\d+) tests?/m.exec(e2eSaida)?.[1] ?? 0);
const linhaE2E = e2eTotal
  ? `| Ponta a ponta (navegador) | ${e2eTotal} | — | — | — |`
  : '| Ponta a ponta (navegador) | — | — | — | indisponível (rode `cd e2e && npm install`) |';

const tabela = [
  '| Suíte | Testes | Passaram | Falharam | Pulados |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...linhas,
  linhaE2E,
  `| **Total** | **${somaTotal + e2eTotal}** | | | |`,
  '',
  '> Ponta a ponta entra na conta como **listados**: este script não os executa',
  '> (precisariam de PostgreSQL, navegador e os servidores de pé). Quem os roda',
  '> é o job "Ponta a ponta (navegador real)" do CI.'
].join('\n');

console.log(tabela);
process.exit(algumaFalha ? 1 : 0);
