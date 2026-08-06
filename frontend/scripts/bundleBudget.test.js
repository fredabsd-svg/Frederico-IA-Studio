import test from 'node:test';
import assert from 'node:assert/strict';
import { initialChunksFromHtml, TETO_ENTRADA_KB, TETO_TOTAL_KB } from './bundleBudget.mjs';

// O que entra na primeira pintura vem do HTML gerado, não do nome do arquivo.
test('pega o script de entrada e os modulepreload, sem duplicar', () => {
  const html = `
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/jsx-runtime-def.js">
    <link rel="modulepreload" crossorigin href="/assets/jsx-runtime-def.js">
    <link rel="stylesheet" href="/assets/index-ghi.css">
  `;
  assert.deepEqual(initialChunksFromHtml(html).sort(), ['/assets/index-abc.js', '/assets/jsx-runtime-def.js']);
});

// Um chunk baixado sob demanda (React.lazy) NÃO custa primeira pintura — é o
// ponto inteiro da separação dos dois tetos.
test('chunk sem modulepreload fica de fora da conta de entrada', () => {
  const html = '<script type="module" src="/assets/index-abc.js"></script>';
  assert.deepEqual(initialChunksFromHtml(html), ['/assets/index-abc.js']);
});

test('HTML sem script de entrada devolve lista vazia (o portão trata como erro)', () => {
  assert.deepEqual(initialChunksFromHtml('<html><body>nada</body></html>'), []);
});

// Guarda contra o erro que motivou esta mudança: se os dois tetos forem iguais,
// voltamos ao número único que punia code splitting.
test('o teto do total é mais folgado que o da entrada', () => {
  assert.ok(TETO_TOTAL_KB > TETO_ENTRADA_KB,
    'o total inclui os chunks sob demanda; um teto igual ao da entrada reprovaria toda separação nova');
});
