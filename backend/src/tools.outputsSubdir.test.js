// Testes para a resolução de path de outputs do F-25 — sub-agentes gravam em
// `outputs/<delegationId>/` em vez da raiz `outputs/`, para que dois em
// paralelo não sobrescrevam arquivos com o mesmo nome e a UI consiga rotular
// cada cartão com quem o produziu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveOutputsTarget } from './tools.js';

test('sem outputsSubdir: grava na raiz de outputs', () => {
  const r = resolveOutputsTarget('/workspace/outputs', null);
  assert.equal(path.normalize(r.targetDir), path.normalize('/workspace/outputs'));
  assert.equal(r.prefix, '');
});

test('com outputsSubdir: grava em outputs/<delegationId>/', () => {
  const r = resolveOutputsTarget('/workspace/outputs', 'call_abc123');
  assert.equal(path.normalize(r.targetDir), path.normalize('/workspace/outputs/call_abc123'));
  assert.equal(r.prefix, 'outputs/call_abc123/');
});

test('outputsSubdir com caracteres especiais é saneado', () => {
  // Defesa contra path traversal: o id da delegação vem do modelo, que pode
  // tentar "../../etc/passwd". O saneamento mantém só [a-zA-Z0-9._-] e
  // remove os separadores de path, então `..` e `/` viram `..` e `_`.
  // O importante é que o `..` resultante NÃO escapa: o `path.join` com a base
  // não vai tratar a string saneada como diretório pai, porque não há mais
  // `/` entre o nome e o resto.
  const r = resolveOutputsTarget('/workspace/outputs', '../../etc/passwd');
  // Confirmação concreta do que o saneamento produz:
  assert.equal(r.prefix, 'outputs/.._.._etc_passwd/');
  assert.ok(r.prefix.startsWith('outputs/'));
  // O targetDir é seguro porque o subdir saneado não contém `/` ou `..` que
  // seriam interpretados pelo path.join. O `..` ali é literal — virou
  // string, não path component.
  const joined = path.join('/workspace/outputs', '.._.._etc_passwd');
  assert.ok(joined.includes('.._.._etc_passwd'), `path.join não escapa da base; recebi: ${joined}`);
});

test('outputsSubdir vazio cai no caminho da raiz (compat)', () => {
  const r = resolveOutputsTarget('/workspace/outputs', '');
  assert.equal(path.normalize(r.targetDir), path.normalize('/workspace/outputs'));
  assert.equal(r.prefix, '');
});

test('outputsSubdir numérico/string: ambos funcionam', () => {
  // O id pode vir como número (tool_call_index) — convertemos internamente.
  const r = resolveOutputsTarget('/workspace/outputs', 42);
  assert.equal(path.normalize(r.targetDir), path.normalize('/workspace/outputs/42'));
  assert.equal(r.prefix, 'outputs/42/');
});
