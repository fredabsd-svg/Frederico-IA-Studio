import assert from 'node:assert/strict';
import test from 'node:test';
import { createDoomLoopDetector, doomLoopResult } from './doomLoop.js';

test('três chamadas idênticas com o mesmo resultado são bloqueadas na terceira', () => {
  const detector = createDoomLoopDetector({ threshold: 3 });
  const args = '{"command":"npm test"}';

  const first = detector.shouldBlock('bash', args);
  assert.equal(first.blocked, false);
  detector.record(first.key, '{"exitCode":1,"output":"FAIL"}');

  const second = detector.shouldBlock('bash', args);
  assert.equal(second.blocked, false);
  detector.record(second.key, '{"exitCode":1,"output":"FAIL"}');

  const third = detector.shouldBlock('bash', args);
  assert.equal(third.blocked, true, 'a terceira repetição idêntica não executa');
  assert.equal(third.repeats, 3);
});

test('resultado NOVO zera a contagem — repetir argumentos com progresso é legítimo', () => {
  const detector = createDoomLoopDetector({ threshold: 3 });
  const args = '{"path":"src/app.js"}';
  const a = detector.shouldBlock('read_file', args);
  detector.record(a.key, 'conteudo v1');
  const b = detector.shouldBlock('read_file', args);
  detector.record(b.key, 'conteudo v2 (editado no meio)');
  const c = detector.shouldBlock('read_file', args);
  assert.equal(c.blocked, false, 'resultados diferentes = progresso, não loop');
  assert.equal(c.repeats, 2);
});

test('argumentos diferentes têm chaves independentes', () => {
  const detector = createDoomLoopDetector({ threshold: 2 });
  const a = detector.shouldBlock('bash', '{"command":"ls"}');
  detector.record(a.key, 'x');
  const b = detector.shouldBlock('bash', '{"command":"pwd"}');
  assert.equal(b.blocked, false);
});

test('o erro estruturado instrui a mudar de estratégia e nomeia a ferramenta', () => {
  const parsed = JSON.parse(doomLoopResult('bash', 3));
  assert.equal(parsed.code, 'DOOM_LOOP');
  assert.equal(parsed.tool, 'bash');
  assert.match(parsed.error, /MUDE DE ESTRATÉGIA/);
  assert.match(parsed.error, /ask_user/);
});
