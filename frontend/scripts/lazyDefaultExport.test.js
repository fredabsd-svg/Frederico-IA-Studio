import test from 'node:test';
import assert from 'node:assert/strict';
import { findLazyDefaultBugs } from './lazyDefaultExport.mjs';

// Falso sistema de arquivos: o guarda precisa LER o módulo apontado para saber
// se ele tem `export default`, e um teste que dependesse dos arquivos reais
// passaria a falhar toda vez que alguém renomeasse um componente.
const fake = (arquivos) => ({
  exists: f => Object.keys(arquivos).some(nome => f.endsWith(nome)),
  readFile: f => arquivos[Object.keys(arquivos).find(nome => f.endsWith(nome))]
});

// Regressão do bug real: os oito `lazy()` do code splitting entraram apontando
// para módulos de export NOMEADO. O build passou, os testes de módulo passaram,
// e o app caiu no error boundary assim que a primeira resposta chegou.
test('acusa lazy() apontado para módulo sem export default', () => {
  const bugs = findLazyDefaultBugs(
    "const LazyPainel = lazy(() => import('./components/Painel.jsx'));",
    '/app/src/App.jsx',
    fake({ 'Painel.jsx': 'export function Painel() { return null; }' })
  );
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].spec, './components/Painel.jsx');
  assert.equal(bugs[0].line, 1);
});

test('aceita o remapeamento .then(m => ({ default: ... }))', () => {
  const bugs = findLazyDefaultBugs(
    "const L = lazy(() => import('./Painel.jsx').then(m => ({ default: m.Painel })));",
    '/app/src/App.jsx',
    fake({ 'Painel.jsx': 'export function Painel() { return null; }' })
  );
  assert.deepEqual(bugs, []);
});

test('aceita módulo que realmente tem export default', () => {
  const bugs = findLazyDefaultBugs(
    "const L = lazy(() => import('./Painel.jsx'));",
    '/app/src/App.jsx',
    fake({ 'Painel.jsx': 'export default function Painel() { return null; }' })
  );
  assert.deepEqual(bugs, []);
});

test('ignora import de pacote — o default de terceiros não é problema nosso', () => {
  const bugs = findLazyDefaultBugs(
    "const L = lazy(() => import('alguma-lib/Painel'));",
    '/app/src/App.jsx',
    fake({})
  );
  assert.deepEqual(bugs, []);
});

test('um lazy quebrado não esconde o seguinte', () => {
  const bugs = findLazyDefaultBugs(
    [
      "const A = lazy(() => import('./A.jsx'));",
      "const B = lazy(() => import('./B.jsx').then(m => ({ default: m.B })));",
      "const C = lazy(() => import('./C.jsx'));"
    ].join('\n'),
    '/app/src/App.jsx',
    fake({
      'A.jsx': 'export function A() {}',
      'B.jsx': 'export function B() {}',
      'C.jsx': 'export function C() {}'
    })
  );
  assert.deepEqual(bugs.map(b => b.spec), ['./A.jsx', './C.jsx']);
  assert.deepEqual(bugs.map(b => b.line), [1, 3]);
});

test('um lazy citado só em comentário não conta', () => {
  const bugs = findLazyDefaultBugs(
    "// exemplo: lazy(() => import('./Painel.jsx'))\nconst x = 1;",
    '/app/src/App.jsx',
    fake({ 'Painel.jsx': 'export function Painel() {}' })
  );
  assert.deepEqual(bugs, []);
});
