import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

process.env.WORKSPACE_ROOT = '/tmp/frederico-agent-resume-tests';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
const { writeResumeMarker, readResumeMarker, clearResumeMarker, resumeTaskNote } = await import('./agent.js');
const { workspaceFor } = await import('./sandbox.js');

const CONV = 'conv-resume-teste';

test('grava e lê de volta o marcador de retomada', () => {
  clearResumeMarker(CONV);
  writeResumeMarker(CONV, { reason: 'A tarefa atingiu o limite de 60 etapas antes da conclusão.', task: 'Extraia os dados do extrato.pdf para uma planilha' });
  const marker = readResumeMarker(CONV);
  assert.ok(marker);
  assert.match(marker.reason, /limite de 60 etapas/);
  assert.match(marker.task, /extrato\.pdf/);
  assert.ok(marker.at);
});

test('limpar remove o marcador', () => {
  writeResumeMarker(CONV, { reason: 'x', task: 'y' });
  clearResumeMarker(CONV);
  assert.equal(readResumeMarker(CONV), null);
});

test('sem marcador gravado, a leitura devolve null', () => {
  clearResumeMarker(CONV);
  assert.equal(readResumeMarker(CONV), null);
});

test('o pedido original é limitado no marcador (não incha o prompt)', () => {
  writeResumeMarker(CONV, { reason: 'r', task: 'x'.repeat(5000) });
  const marker = readResumeMarker(CONV);
  assert.ok(marker.task.length <= 300);
  clearResumeMarker(CONV);
});

test('o marcador fica na base do workspace, fora de outputs (não vira download)', () => {
  writeResumeMarker(CONV, { reason: 'r', task: 't' });
  const ws = workspaceFor(CONV);
  assert.ok(fs.existsSync(path.join(ws.base, '.tarefa-incompleta.json')));
  assert.ok(!fs.existsSync(path.join(ws.outputs, '.tarefa-incompleta.json')));
  clearResumeMarker(CONV);
});

test('a nota de retomada orienta a reaproveitar o que já existe', () => {
  const note = resumeTaskNote({ reason: 'A tarefa atingiu o limite de 60 etapas antes da conclusão.', task: 'Gerar planilha do extrato' });
  assert.match(note, /RETOMADA DE TAREFA INTERROMPIDA/);
  assert.match(note, /limite de 60 etapas/);
  assert.match(note, /Gerar planilha do extrato/);
  assert.match(note, /REAPROVEITE/);
  assert.match(note, /mudar de assunto, ignore/);
});

test('a nota de retomada funciona mesmo com um marcador vazio ou corrompido', () => {
  for (const marker of [null, undefined, {}, { reason: '', task: '' }]) {
    const note = resumeTaskNote(marker);
    assert.match(note, /RETOMADA DE TAREFA INTERROMPIDA/);
    assert.ok(!note.includes('()'));
    assert.ok(!note.includes('""'));
  }
});
