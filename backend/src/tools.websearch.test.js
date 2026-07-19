import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-websearch-tests';

const { decodeDuckUrl, parseDuckHtml, parseDuckLite } = await import('./tools.js');

test('decodeDuckUrl extrai a URL final do redirecionador uddg', () => {
  assert.equal(
    decodeDuckUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.gov.br%2Freceitafederal&rut=abc'),
    'https://www.gov.br/receitafederal'
  );
  // href já direto, sem esquema → recebe https:
  assert.equal(decodeDuckUrl('//exemplo.com/pagina'), 'https://exemplo.com/pagina');
  // href absoluto normal fica intacto
  assert.equal(decodeDuckUrl('https://exemplo.com/x'), 'https://exemplo.com/x');
});

// HTML realista do html.duckduckgo.com — repare que num resultado o href vem
// ANTES da class e no outro DEPOIS (ordem de atributos varia no HTML real).
const HTML_NORMAL = `
<div class="result results_links web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.gov.br%2Freceitafederal&rut=1">Receita Federal do Brasil</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.gov.br%2Freceitafederal">Portal oficial da <b>Receita Federal</b>.</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title">
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbrasilapi.com.br&rut=2" class="result__a">BrasilAPI</a>
  </h2>
  <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbrasilapi.com.br" class="result__snippet">APIs públicas do Brasil.</a>
</div>`;

test('parseDuckHtml lê títulos, links e resumos independente da ordem dos atributos', () => {
  const r = parseDuckHtml(HTML_NORMAL);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Receita Federal do Brasil');
  assert.equal(r[0].url, 'https://www.gov.br/receitafederal');
  assert.match(r[0].snippet, /Receita Federal/);
  assert.equal(r[1].title, 'BrasilAPI');
  assert.equal(r[1].url, 'https://brasilapi.com.br');
});

test('parseDuckHtml respeita o limite', () => {
  assert.equal(parseDuckHtml(HTML_NORMAL, 1).length, 1);
});

// HTML realista da versão "lite" (tabela).
const HTML_LITE = `
<table>
  <tr><td class="result-count">Resultados</td></tr>
  <tr>
    <td class="result-link"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.planalto.gov.br%2Flei&rut=1" class='result-link'>Lei Complementar</a></td>
  </tr>
  <tr><td class='result-snippet'>Texto da <b>lei</b> no Planalto.</td></tr>
  <tr>
    <td class="result-link"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.gov.br%2Fx&rut=2" class="result-link">Gov.br</a></td>
  </tr>
  <tr><td class="result-snippet">Serviços do governo.</td></tr>
</table>`;

test('parseDuckLite lê a tabela de resultados da versão lite', () => {
  const r = parseDuckLite(HTML_LITE);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Lei Complementar');
  assert.equal(r[0].url, 'https://www.planalto.gov.br/lei');
  assert.match(r[0].snippet, /lei no Planalto/);
  assert.equal(r[1].url, 'https://www.gov.br/x');
});

test('parsers devolvem lista vazia (não quebram) para HTML sem resultados', () => {
  assert.deepEqual(parseDuckHtml('<html><body>bloqueado</body></html>'), []);
  assert.deepEqual(parseDuckLite('<html><body>bloqueado</body></html>'), []);
});

test('filtra links de anúncio/rastreamento do DuckDuckGo', () => {
  const html = `
    <a class="result-link" href="https://duckduckgo.com/y.js?ad_provider=bingv7aa&u3=x">Anúncio patrocinado</a>
    <a class="result-link" href="https://www.planalto.gov.br/lei">Lei Complementar 123</a>
  `;
  const r = parseDuckLite(html);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://www.planalto.gov.br/lei');
  assert.doesNotMatch(JSON.stringify(r), /y\.js|ad_provider/);
});
