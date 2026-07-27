import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESIGN_TOKENS, TOKENS_PROMPT, tokenById, detectTokens, normalizeHex, parseMeasure,
  sanitizeAdjustments, buildOverrideCss, applyAdjustments, injectBeforeClosingTag,
  ADJUSTMENTS_STYLE_ID,
} from './tokens.js';

// Os controles de ajuste escrevem CSS a partir de valores vindos do cliente.
// É a superfície onde um valor livre viraria declaração de estilo (e, com
// `url()`, requisição de rede) dentro do artefato — por isso a validação por
// tipo é o que a maior parte destes testes trava.

const ARTEFATO = `<!DOCTYPE html><html><head><style>
:root{--fred-cor-primaria:#1F3B8A;--fred-cor-secundaria:#e8523f;--fred-fonte-base:16px;--fred-raio:12px}
h1{color:var(--fred-cor-primaria)}
</style></head><body><h1>Oi</h1></body></html>`;

// ---- Catálogo --------------------------------------------------------------

test('todo token tem nome de variável próprio e tipo conhecido', () => {
  const vars = new Set();
  for (const token of DESIGN_TOKENS) {
    assert.match(token.cssVar, /^--fred-/, `${token.id} deve usar o prefixo do app`);
    assert.ok(!vars.has(token.cssVar), `variável repetida: ${token.cssVar}`);
    vars.add(token.cssVar);
    assert.ok(['cor', 'medida'].includes(token.kind));
    if (token.kind === 'medida') {
      assert.ok(Number.isFinite(token.min) && Number.isFinite(token.max) && token.max > token.min);
      assert.ok(token.unit, `${token.id} precisa de unidade — o CSS sai sem ela`);
    }
  }
});

test('o system prompt lista as variáveis que a interface procura', () => {
  // Se o prompt e o catálogo divergirem, o modelo declara um nome e a interface
  // procura outro: nenhum controle aparece e ninguém entende por quê.
  for (const token of DESIGN_TOKENS) assert.ok(TOKENS_PROMPT.includes(token.cssVar), `faltou ${token.cssVar} no prompt`);
});

test('tokenById só reconhece o que está no catálogo', () => {
  assert.equal(tokenById('corPrimaria').cssVar, '--fred-cor-primaria');
  assert.equal(tokenById('corInventada'), null);
  assert.equal(tokenById(''), null);
});

// ---- Leitura do artefato ---------------------------------------------------

test('detecta só as variáveis que o artefato declara, com o valor dele', () => {
  const found = detectTokens(ARTEFATO);
  assert.deepEqual(found.map(t => t.id), ['corPrimaria', 'corSecundaria', 'fonteBase', 'raio']);
  assert.equal(found[0].defaultValue, '#1f3b8a', 'hex normalizado para minúsculas');
  assert.equal(found.find(t => t.id === 'fonteBase').defaultValue, 16, 'medida vira número, sem unidade');
});

test('artefato que não segue o contrato devolve lista vazia', () => {
  // É o caso de um design gerado antes da v2 (ou por um modelo que ignorou a
  // regra). A interface usa isso para dizer que não há controles, em vez de
  // mostrar sliders que não fazem nada.
  assert.deepEqual(detectTokens('<html><style>h1{color:#123456}</style></html>'), []);
  assert.deepEqual(detectTokens(''), []);
  assert.deepEqual(detectTokens(null), []);
});

test('valor declarado fora da faixa é trazido para dentro dela', () => {
  const found = detectTokens('<style>:root{--fred-fonte-base:200px}</style>');
  assert.equal(found[0].defaultValue, 24, 'o máximo do token');
});

test('valor declarado ilegível é ignorado em vez de virar controle quebrado', () => {
  assert.deepEqual(detectTokens('<style>:root{--fred-cor-primaria:var(--outra)}</style>'), []);
  assert.deepEqual(detectTokens('<style>:root{--fred-raio:auto}</style>'), []);
});

// ---- Validação -------------------------------------------------------------

test('cor: hex de 3 ou 6 dígitos, normalizado — nada mais', () => {
  assert.equal(normalizeHex('#ABCDEF'), '#abcdef');
  assert.equal(normalizeHex('#0a7'), '#00aa77');
  assert.equal(normalizeHex('red'), null);
  assert.equal(normalizeHex('rgb(1,2,3)'), null);
  // O valor vai para dentro de uma declaração CSS: aceitar texto livre aqui
  // seria injeção de estilo — e, com url(), de requisição de rede.
  assert.equal(normalizeHex('#fff;background-image:url(http://x/y)'), null);
  assert.equal(normalizeHex(''), null);
  assert.equal(normalizeHex(null), null);
});

test('medida: número dentro da faixa, com ou sem unidade', () => {
  const raio = tokenById('raio');
  assert.equal(parseMeasure('12px', raio), 12);
  assert.equal(parseMeasure(12, raio), 12);
  assert.equal(parseMeasure('999', raio), raio.max);
  assert.equal(parseMeasure('-5', raio), raio.min);
  assert.equal(parseMeasure('grande', raio), null);
});

test('ajustes: só chaves do catálogo sobrevivem', () => {
  const clean = sanitizeAdjustments({
    corPrimaria: '#0a7d55',
    raio: '18',
    naoExiste: '#000000',
    corSecundaria: 'azul',
  });
  assert.deepEqual(clean, { corPrimaria: '#0a7d55', raio: 18 });
});

test('ajuste vazio ou nulo APAGA o ajuste (volta ao valor do design)', () => {
  assert.deepEqual(sanitizeAdjustments({ corPrimaria: null, raio: '' }), {});
  assert.deepEqual(sanitizeAdjustments(null), {});
  assert.deepEqual(sanitizeAdjustments('nada'), {});
});

// ---- Escrita do CSS --------------------------------------------------------

test('o CSS de sobreposição sai com unidade e !important', () => {
  const css = buildOverrideCss({ corPrimaria: '#0a7d55', fonteBase: 18, raio: 0 });
  assert.match(css, /^:root\{/);
  assert.match(css, /--fred-cor-primaria: #0a7d55 !important;/);
  assert.match(css, /--fred-fonte-base: 18px !important;/);
  // Zero é um ajuste legítimo (cantos retos) e não pode sumir por ser falsy.
  assert.match(css, /--fred-raio: 0px !important;/);
});

test('sem ajuste válido não sai CSS nenhum', () => {
  assert.equal(buildOverrideCss({}), '');
  assert.equal(buildOverrideCss({ naoExiste: 1 }), '');
  assert.equal(buildOverrideCss({ corPrimaria: 'javascript:alert(1)' }), '');
});

test('a sobreposição entra no fim do <head>, sem tocar no artefato', () => {
  const out = applyAdjustments(ARTEFATO, { corPrimaria: '#0a7d55' });
  assert.ok(out.includes(`<style id="${ADJUSTMENTS_STYLE_ID}">`));
  assert.ok(out.indexOf(ADJUSTMENTS_STYLE_ID) < out.indexOf('</head>'), 'antes de fechar o head');
  // O artefato original continua inteiro: o ajuste é camada, não reescrita.
  assert.ok(out.includes('--fred-cor-primaria:#1F3B8A'));
});

test('sem ajustes, o HTML sai byte a byte igual', () => {
  assert.equal(applyAdjustments(ARTEFATO, {}), ARTEFATO);
  assert.equal(applyAdjustments(ARTEFATO, null), ARTEFATO);
});

test('documento sem <head> ainda recebe a sobreposição', () => {
  const out = applyAdjustments('<html><body><h1>x</h1></body></html>', { raio: 4 });
  assert.ok(out.includes('</body>'));
  assert.ok(out.indexOf(ADJUSTMENTS_STYLE_ID) < out.indexOf('</body>'));
});

test('a injeção acha o fechamento VERDADEIRO do head, não um exemplo no corpo', () => {
  // Uma página gerada pode exibir marcação como conteúdo. Se a busca fosse pela
  // última ocorrência de "</head>", o estilo entraria dentro do comentário — no
  // meio do corpo, fora do head, onde talvez nem valha.
  const html = '<html><head><style>x</style></head><body><!-- exemplo: </head> --></body></html>';
  const out = injectBeforeClosingTag(html, '<!--AQUI-->');
  assert.ok(out.indexOf('<!--AQUI-->') < out.indexOf('<body>'), 'antes do corpo');
  assert.equal(out.indexOf('<!--AQUI-->'), html.indexOf('</head>'));
});

test('sem head, o alvo é o ÚLTIMO </body> (esse é o fechamento de verdade)', () => {
  const html = '<html><body><p>fim: &lt;/body&gt;</p></body></html>';
  const out = injectBeforeClosingTag(html, '<!--AQUI-->');
  assert.ok(out.indexOf('<!--AQUI-->') > out.indexOf('<p>'));
});

test('documento sem head nem body ainda recebe o trecho', () => {
  assert.equal(injectBeforeClosingTag('<h1>solto</h1>', '<!--X-->'), '<h1>solto</h1><!--X-->');
});
