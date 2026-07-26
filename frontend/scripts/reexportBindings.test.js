import test from 'node:test';
import assert from 'node:assert/strict';
import { findReexportBindingBugs, stripCommentsAndLiterals } from './reexportBindings.mjs';

// Regressão do bug real: `ExecutionSession.jsx` reexportava SUBAGENT_TOOL e o
// usava como se fosse variável local. Resultado: ReferenceError na primeira
// renderização de qualquer conversa com ferramenta e o app inteiro caindo na
// tela do ErrorBoundary.
test('acusa nome reexportado que é usado no próprio arquivo', () => {
  const bugs = findReexportBindingBugs(`
    import { outra } from '../m.js';
    export { SUBAGENT_TOOL } from '../m.js';
    function resumo(passos) {
      return passos.filter(p => p.name === SUBAGENT_TOOL).length;
    }
  `);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].name, 'SUBAGENT_TOOL');
  assert.equal(bugs[0].line, 3);
});

test('não acusa re-export que o arquivo não usa (é só repasse, e isso é válido)', () => {
  const bugs = findReexportBindingBugs(`
    export { SUBAGENT_TOOL } from '../m.js';
    export const OUTRO = 1;
  `);
  assert.deepEqual(bugs, []);
});

test('não acusa quando o nome também é importado — aí existe binding local', () => {
  const bugs = findReexportBindingBugs(`
    import { SUBAGENT_TOOL } from '../m.js';
    export { SUBAGENT_TOOL };
    const x = SUBAGENT_TOOL;
  `);
  assert.deepEqual(bugs, []);
});

test('é a forma corrigida de ExecutionSession.jsx que passa', () => {
  const bugs = findReexportBindingBugs(`
    import { groupExecutionSteps, delegationSummary, SUBAGENT_TOOL } from '../executionSteps.js';
    export { SUBAGENT_TOOL };
    const n = steps.filter(s => s.name === SUBAGENT_TOOL).length;
  `);
  assert.deepEqual(bugs, []);
});

test('pega o apelido: export { A as B } from ... não cria nem A nem B', () => {
  const bugs = findReexportBindingBugs(`
    export { interno as PUBLICO } from '../m.js';
    const usa = PUBLICO;
  `);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].name, 'PUBLICO');
});

test('pega o namespace: export * as ns from ...', () => {
  const bugs = findReexportBindingBugs(`
    export * as helpers from '../m.js';
    const usa = helpers.algo();
  `);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].name, 'helpers');
});

test('menção em comentário ou string não conta como uso', () => {
  const bugs = findReexportBindingBugs(`
    export { NOME } from '../m.js';
    // NOME é reexportado para o painel de atividade.
    const texto = 'NOME';
    const outro = \`usa NOME aqui\`;
  `);
  assert.deepEqual(bugs, []);
});

test('uso dentro de \${} de template literal conta — é código de verdade', () => {
  const bugs = findReexportBindingBugs(`
    export { NOME } from '../m.js';
    const texto = \`valor: \${NOME}\`;
  `);
  assert.equal(bugs.length, 1);
});

test('JSX é coberto: o uso aparece dentro do corpo do componente', () => {
  const bugs = findReexportBindingBugs(`
    export { ICONE } from '../m.js';
    export function Card({ step }) {
      return <div className="c">{step.name === ICONE ? 'sim' : 'não'}</div>;
    }
  `);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].name, 'ICONE');
});

test('literal de regex com aspas não desalinha o varredor', () => {
  const code = `
    export { NOME } from '../m.js';
    const ehImagem = /['"]\\.(png|jpe?g)$/i.test(nome);
    const dividido = total / 2;
    const usa = NOME;
  `;
  const bugs = findReexportBindingBugs(code);
  assert.equal(bugs.length, 1, 'o uso real de NOME continua sendo visto');
});

test('stripCommentsAndLiterals preserva as linhas, as aspas e as posições', () => {
  const origem = `const a = 'oi';\n// nota\nconst b = 2;`;
  const limpo = stripCommentsAndLiterals(origem);
  assert.equal(limpo.length, origem.length, 'o conteúdo vira espaço, não some — a linha do erro depende disso');
  assert.equal(limpo.split('\n').length, 3);
  assert.match(limpo, /const a = ' {2}';/);
  assert.doesNotMatch(limpo, /nota/);
  assert.match(limpo, /const b = 2;/);
});

test('divisão seguida de string não é confundida com regex', () => {
  const bugs = findReexportBindingBugs(`
    export { NOME } from '../m.js';
    const media = soma / total;
    const rotulo = 'NOME';
    const usa = NOME;
  `);
  assert.equal(bugs.length, 1, 'NOME em string não conta, mas o uso real conta');
});
