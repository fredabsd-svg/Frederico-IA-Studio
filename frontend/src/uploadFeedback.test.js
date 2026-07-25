// Feedback honesto do upload na interface.
//
// Dois problemas que estes testes travam:
//  1) o selo "✓ verificado" aparecia guiado por `scanned`, mas quando o antivírus
//     estava fora do ar (modo degradado) o usuário simplesmente NÃO via aviso
//     nenhum — e supunha que o arquivo tinha sido verificado;
//  2) qualquer recusa do backend virava "Verifique o tamanho (máx. 50 MB)", mesmo
//     quando o motivo era o total do lote, a cota ou envios simultâneos demais.
import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadErrorFor, scanWarningFor } from './uploadFeedback.js';

test('cada recusa do backend tem uma mensagem própria e acionável', () => {
  assert.match(uploadErrorFor(413), /lotes menores/i);
  assert.match(uploadErrorFor(429), /envios demais/i);
  assert.match(uploadErrorFor(503), /antivírus/i);
  assert.match(uploadErrorFor(404), /não encontrada/i);
  assert.match(uploadErrorFor(0), /Falha no envio/i);
});

test('nenhuma mensagem culpa o tamanho do arquivo quando o motivo é outro', () => {
  // A regressão concreta: 413 por total do lote ou cota exibia "máx. 50 MB",
  // levando o usuário a diminuir o arquivo errado.
  assert.doesNotMatch(uploadErrorFor(429), /50 MB/);
  assert.doesNotMatch(uploadErrorFor(503), /50 MB/);
  assert.doesNotMatch(uploadErrorFor(413), /50 MB/);
});

test('o aviso de "não verificado" só aparece no modo degradado', () => {
  assert.equal(scanWarningFor('verificado', 3), null, 'analisado de verdade: o selo é legítimo, sem aviso');
  assert.equal(scanWarningFor('sem-antivirus', 3), null, 'recurso desligado: nada é prometido, nada a alertar');
  const aviso = scanWarningFor('degradado', 3);
  assert.match(aviso, /NÃO foi possível verificá-los/);
  assert.match(aviso, /^3 arquivo/);
});
