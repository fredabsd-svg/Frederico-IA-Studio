import assert from 'node:assert/strict';
import test from 'node:test';
import { addedLinesByFile, isTestFile, pageCheckFindings, reviewFindings, reviewNote, summarizeReview } from './reviewGate.js';

const changesWith = (...paths) => ({
  repos: [{ name: 'repo', branch: 'x', files: paths.map(p => (typeof p === 'string' ? { path: p, status: 'M' } : p)), totals: {} }]
});

test('addedLinesByFile lê só as linhas ADICIONADAS, com número de linha real', () => {
  const diff = [
    'diff --git a/src/app.js b/src/app.js',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -10,3 +10,4 @@',
    ' contexto',
    '+const novo = 1;',
    '-removida',
    '+outra nova',
    ''
  ].join('\n');
  const byFile = addedLinesByFile(diff);
  const linhas = byFile.get('src/app.js');
  assert.deepEqual(linhas.map(l => l.text), ['const novo = 1;', 'outra nova']);
  assert.equal(linhas[0].line, 11, 'a linha adicionada vem depois da linha de contexto');
});

test('segredo em linha adicionada é blocker; o mesmo texto pré-existente não vira achado', () => {
  const diff = ['+++ b/config.js', '@@ -1 +1,2 @@', '+const key = "sk-abcdefghijklmnopqrstuv";'].join('\n');
  const achados = reviewFindings({ changes: changesWith('config.js'), diffText: diff });
  const segredo = achados.find(a => a.kind === 'secret');
  assert.ok(segredo, 'deveria acusar segredo');
  assert.equal(segredo.severity, 'blocker');
  assert.equal(segredo.file, 'config.js');

  // Linha de CONTEXTO (não adicionada) com o mesmo conteúdo: nada.
  const semAdicao = ['+++ b/config.js', '@@ -1 +1 @@', ' const key = "sk-abcdefghijklmnopqrstuv";'].join('\n');
  assert.equal(reviewFindings({ changes: changesWith('config.js'), diffText: semAdicao }).some(a => a.kind === 'secret'), false);
});

test('reconhece token do GitHub, chave AWS, chave privada e string de conexão', () => {
  const casos = [
    '+const t = "ghp_abcdefghijklmnopqrstuvwx";',
    '+AWS_KEY = "AKIAIOSFODNN7EXAMPLE"',
    '+-----BEGIN RSA PRIVATE KEY-----',
    '+DB = "postgres://user:senhaforte@host/db"'
  ];
  for (const linha of casos) {
    const diff = ['+++ b/a.js', '@@ -1 +1,2 @@', linha].join('\n');
    const achados = reviewFindings({ changes: changesWith('a.js'), diffText: diff });
    assert.equal(achados.some(a => a.kind === 'secret'), true, linha);
  }
});

test('código de depuração é medium e respeita a linguagem do arquivo', () => {
  const js = ['+++ b/src/a.js', '@@ -1 +1,2 @@', '+  console.log("x");'].join('\n');
  assert.equal(reviewFindings({ changes: changesWith('src/a.js'), diffText: js }).some(a => a.kind === 'debug'), true);
  // `print(` só conta em Python — num .js é chamada legítima.
  const jsPrint = ['+++ b/src/a.js', '@@ -1 +1,2 @@', '+print("relatorio")'].join('\n');
  assert.equal(reviewFindings({ changes: changesWith('src/a.js'), diffText: jsPrint }).some(a => a.kind === 'debug'), false);
  const py = ['+++ b/src/a.py', '@@ -1 +1,2 @@', '+print("debug")'].join('\n');
  assert.equal(reviewFindings({ changes: changesWith('src/a.py'), diffText: py }).some(a => a.kind === 'debug'), true);
});

test('teste desligado (skip/only) é high — a suíte passaria sem exercitar o caso', () => {
  const diff = ['+++ b/src/a.test.js', '@@ -1 +1,2 @@', '+test.only("caso", () => {});'].join('\n');
  const achados = reviewFindings({ changes: changesWith('src/a.test.js'), diffText: diff });
  const skip = achados.find(a => a.kind === 'skipped_test');
  assert.equal(skip.severity, 'high');
});

test('código alterado sem teste tocado vira achado; com teste, não', () => {
  const semTeste = reviewFindings({ changes: changesWith('src/app.js'), diffText: '' });
  assert.equal(semTeste.some(a => a.kind === 'missing_test'), true);
  const comTeste = reviewFindings({ changes: changesWith('src/app.js', 'src/app.test.js'), diffText: '' });
  assert.equal(comTeste.some(a => a.kind === 'missing_test'), false);
  // Só documentação alterada não exige teste.
  const soDoc = reviewFindings({ changes: changesWith('README.md'), diffText: '' });
  assert.equal(soDoc.some(a => a.kind === 'missing_test'), false);
});

test('remoção e caminho sensível pedem olhar humano, com severidade coerente', () => {
  const achados = reviewFindings({
    changes: changesWith({ path: '.github/workflows/ci.yml', status: 'D' }, { path: 'docker-compose.yml', status: 'M' }),
    diffText: ''
  });
  const remocao = achados.find(a => a.kind === 'deletion');
  assert.equal(remocao.severity, 'high', 'remover workflow de CI é sensível');
  assert.equal(achados.some(a => a.kind === 'sensitive_path'), true);
});

test('escopo: muitos arquivos fora do plano viram achado; poucos, não', () => {
  const plan = { steps: [{ id: '1', title: 'Ajustar app.js', status: 'completed', evidence: 'editei src/app.js' }] };
  const dentro = reviewFindings({ changes: changesWith('src/app.js'), diffText: '', plan });
  assert.equal(dentro.some(a => a.kind === 'scope'), false);
  const fora = reviewFindings({
    changes: changesWith('src/app.js', 'src/a.js', 'src/b.js', 'src/c.js'),
    diffText: '', plan
  });
  const escopo = fora.find(a => a.kind === 'scope');
  assert.ok(escopo);
  assert.match(escopo.message, /não são mencionados/);
  // Sem plano, nenhum achado de escopo (não há contra o que comparar).
  assert.equal(reviewFindings({ changes: changesWith('a.js', 'b.js', 'c.js', 'd.js'), diffText: '' }).some(a => a.kind === 'scope'), false);
});

test('isTestFile reconhece as convenções usadas no repositório', () => {
  for (const p of ['src/a.test.js', 'backend/src/x_test.py', 'tests/unit/y.js', '__tests__/z.jsx', 'e2e/tests/w.spec.js']) {
    assert.equal(isTestFile(p), true, p);
  }
  assert.equal(isTestFile('src/latest.js'), false);
});

test('summarizeReview: "limpo" ignora achados baixos, mas não high/blocker', () => {
  const limpo = summarizeReview([{ severity: 'low', kind: 'todo', message: 'x' }, { severity: 'medium', kind: 'debug', message: 'y' }]);
  assert.equal(limpo.clean, true);
  assert.equal(limpo.total, 2);
  const sujo = summarizeReview([{ severity: 'high', kind: 'missing_test', message: 'z' }]);
  assert.equal(sujo.clean, false);
  assert.equal(summarizeReview([]).clean, true);
});

test('a nota ao modelo lista os achados e proíbe pedir publicação sem tratá-los', () => {
  const nota = reviewNote(summarizeReview([
    { severity: 'blocker', kind: 'secret', message: 'chave', file: 'a.js', line: 3 },
    { severity: 'low', kind: 'todo', message: 'todo', file: 'b.js', line: 9 }
  ]));
  assert.match(nota, /REVISÃO AUTOMÁTICA/);
  assert.match(nota, /a\.js:3/);
  assert.match(nota, /NÃO peça autorização de publicação/);
  assert.match(nota, /diff REAL/);
  assert.equal(reviewNote(summarizeReview([])), '', 'sem achados, sem nota');
});

test('sem alterações não há revisão a fazer', () => {
  assert.deepEqual(reviewFindings({ changes: { repos: [] }, diffText: 'ruído' }), []);
  assert.deepEqual(reviewFindings({}), []);
});

// ── validação por navegador alimentando o gate (Fase 38 → Fase 28) ──────────

const aprovada = { disponivel: true, pagina: 'dist/index.html', ok: true, problemas: [], avisos: [] };
const reprovada = {
  disponivel: true,
  pagina: 'dist/index.html',
  ok: false,
  problemas: ['A página abriu EM BRANCO: nenhum texto visível e nenhum elemento visual.', 'Erro no console: Failed to resolve module'],
  avisos: []
};

test('página reprovada no navegador vira achado HIGH, com os problemas medidos', () => {
  const achados = pageCheckFindings([reprovada], [{ path: 'dist/index.html', status: 'M' }]);
  const alvo = achados.find(a => a.kind === 'page_check');
  assert.ok(alvo);
  assert.equal(alvo.severity, 'high');
  assert.equal(alvo.file, 'dist/index.html');
  assert.match(alvo.message, /2 problemas medidos/);
  assert.match(alvo.message, /EM BRANCO/);
});

test('página aprovada não gera achado nenhum — nem o de "faltou validar"', () => {
  assert.deepEqual(pageCheckFindings([aprovada], [{ path: 'dist/index.html', status: 'M' }]), []);
});

// O irmão do missing_test: ausência de evidência, não evidência de defeito.
test('HTML alterado sem nenhuma validação vira achado MEDIUM', () => {
  const achados = pageCheckFindings([], [{ path: 'site/index.html', status: 'M' }, { path: 'src/app.js', status: 'M' }]);
  const alvo = achados.find(a => a.kind === 'missing_page_check');
  assert.ok(alvo);
  assert.equal(alvo.severity, 'medium');
  assert.match(alvo.message, /site\/index\.html/);
});

test('só JS alterado não cobra validação de página', () => {
  assert.deepEqual(pageCheckFindings([], [{ path: 'src/app.js', status: 'M' }]), []);
});

test('HTML APAGADO ou de teste não cobra validação — não há o que abrir', () => {
  assert.deepEqual(pageCheckFindings([], [{ path: 'site/velha.html', status: 'D' }]), []);
  assert.deepEqual(pageCheckFindings([], [{ path: 'tests/fixture.html', status: 'M' }]), []);
});

// Tentativa não é prova: um caminho errado deixa o "faltou validar" de pé.
test('checagem que só deu erro não conta como validação', () => {
  const achados = pageCheckFindings(
    [{ disponivel: true, erro: 'A página não existe no workspace: dist/index.html' }],
    [{ path: 'dist/index.html', status: 'M' }]
  );
  assert.ok(achados.some(a => a.kind === 'missing_page_check'));
});

test('validação indisponível vira achado LOW que proíbe dizer "validado"', () => {
  const achados = pageCheckFindings(
    [{ disponivel: false, observacao: 'Chromium ausente neste ambiente.' }],
    [{ path: 'dist/index.html', status: 'M' }]
  );
  const alvo = achados.find(a => a.kind === 'page_check_unavailable');
  assert.equal(alvo.severity, 'low');
  assert.match(alvo.message, /Não apresente a página como validada/);
  // E, como nada foi validado, o "faltou validar" também continua de pé.
  assert.ok(achados.some(a => a.kind === 'missing_page_check'));
});

test('o gate junta as duas evidências e ordena pela gravidade', () => {
  const achados = reviewFindings({
    changes: changesWith('dist/index.html', 'src/app.js', 'src/app.test.js'),
    diffText: '',
    pageChecks: [reprovada]
  });
  assert.equal(achados[0].severity, 'high', 'o mais grave vem primeiro');
  assert.ok(achados.some(a => a.kind === 'page_check'));
  const resumo = summarizeReview(achados);
  assert.equal(resumo.clean, false, 'página reprovada não sai como entrega limpa');
  // A nota ao modelo precisa carregar o achado do navegador, senão ele não o trata.
  assert.match(reviewNote(resumo), /validação por navegador/);
});
