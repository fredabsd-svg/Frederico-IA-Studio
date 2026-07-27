import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeSnippet, BRIDGE_MESSAGES, BRIDGE_STYLE_ID, ADJUSTMENTS_LIVE_STYLE_ID } from './bridge.js';

// A ponte é o ÚNICO código nosso que roda dentro da prévia — um documento de
// origem opaca onde também roda o HTML gerado pela IA. Ela não pode ter nada
// interpolado de fora, e o que ela envia é apenas descritor de elemento.
//
// O comportamento em si (realce, clique, ajuste ao vivo) é exercitado em
// navegador de verdade por e2e/tests/design.spec.js; aqui travamos o contrato
// que dá para conferir sem navegador.

test('o trecho traz o estilo do realce e o script, e é sintaticamente válido', () => {
  const snippet = bridgeSnippet();
  assert.ok(snippet.includes(`<style id="${BRIDGE_STYLE_ID}">`));
  assert.ok(snippet.includes('<script>'));
  const script = snippet.slice(snippet.indexOf('<script>') + 8, snippet.lastIndexOf('</script>'));
  // Um erro de sintaxe aqui deixaria a prévia sem seleção e sem ajuste ao vivo,
  // silenciosamente — o console é o do iframe, que ninguém abre.
  assert.doesNotThrow(() => new Function(script), 'o script da ponte precisa compilar');
});

test('o trecho é constante: nada vindo de fora é interpolado', () => {
  // Um pedaço montado por template com dado do usuário viraria injeção de
  // script dentro da própria prévia.
  assert.equal(bridgeSnippet(), bridgeSnippet());
});

test('os tipos de mensagem são os que a interface escuta', () => {
  // O outro lado está em frontend/src/design/designCore.js. Divergir aqui faz a
  // seleção parar de funcionar sem nenhum erro visível.
  assert.deepEqual(Object.keys(BRIDGE_MESSAGES).sort(), ['ajustes', 'limparSelecao', 'modo', 'pronto', 'selecionado']);
  for (const valor of Object.values(BRIDGE_MESSAGES)) assert.match(valor, /^fred-preview-/);
});

test('a ponte fala com o pai por postMessage, nunca tocando o DOM de fora', () => {
  const script = bridgeSnippet();
  assert.match(script, /parent\.postMessage/);
  // `parent.document` seria bloqueado pela origem opaca — e tentar significaria
  // não ter entendido por que a ponte existe.
  assert.ok(!script.includes('parent.document'));
  assert.ok(!script.includes('top.location'));
});

test('o clique de seleção é capturado antes do artefato', () => {
  // Sem a fase de captura, um menu ou um formulário da própria página comeria o
  // clique e a seleção nunca chegaria à interface.
  const script = bridgeSnippet();
  assert.match(script, /addEventListener\('click'[\s\S]*?,\s*true\)/);
  assert.match(script, /preventDefault/);
});

test('o ajuste ao vivo vai para um <style> próprio, sem apagar o do artefato', () => {
  const script = bridgeSnippet();
  assert.ok(script.includes(ADJUSTMENTS_LIVE_STYLE_ID));
  assert.match(script, /createElement\('style'\)/);
});
