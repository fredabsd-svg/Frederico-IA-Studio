import assert from 'node:assert/strict';
import test from 'node:test';
import { toPptxColor, bodyRuns, slidesToPptx } from './pptx.js';

// O .pptx sai do JSON de slides (não do HTML), então o que precisa de guarda é
// a tradução: cores no formato do OOXML, marcadores como bullet de verdade e um
// arquivo que realmente se abre — um .pptx corrompido só aparece no PowerPoint.

test('cor do OOXML: sem #, sempre 6 dígitos, com queda para o padrão', () => {
  assert.equal(toPptxColor('#1f3b8a', 'X'), '1F3B8A');
  assert.equal(toPptxColor('#abc', 'X'), 'AABBCC');
  assert.equal(toPptxColor('azul', 'FALLBACK'), 'FALLBACK');
  assert.equal(toPptxColor(null, 'FALLBACK'), 'FALLBACK');
});

test('marcador vira bullet do PowerPoint, não um "- " digitado', () => {
  const runs = bodyRuns('Intro\n- um\n- dois');
  assert.equal(runs.length, 3);
  assert.equal(runs[0].options.bullet, undefined);
  assert.equal(runs[1].options.bullet, true);
  assert.equal(runs[1].text, 'um');
});

test('corpo vazio ainda produz um run (a caixa de texto não pode ficar sem conteúdo)', () => {
  const runs = bodyRuns('');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, '');
});

test('gera um .pptx abrível: assinatura ZIP e as partes obrigatórias do OOXML', async () => {
  const buffer = await slidesToPptx([
    { layout: 'title', title: 'Proposta', body: 'Subtítulo', notes: 'abrir com o problema' },
    { layout: 'content', title: 'Contexto', body: '- a\n- b', notes: '' },
    { layout: 'two-column', title: 'Antes e depois', body: 'antes\n---\ndepois', notes: '' },
    { layout: 'image-full', title: 'Fechamento', body: 'obrigado', notes: '' },
  ], { title: 'Proposta', designSystem: { primaryColor: '#0a7d55', secondaryColor: '#ffb703' } });

  assert.ok(Buffer.isBuffer(buffer), 'deve devolver um Buffer');
  // "PK\x03\x04": um .pptx é um zip. Sem isto o arquivo baixa e não abre.
  assert.equal(buffer.subarray(0, 4).toString('binary'), 'PK');
  const raw = buffer.toString('binary');
  assert.match(raw, /\[Content_Types\]\.xml/);
  assert.match(raw, /ppt\/presentation\.xml/);
  assert.ok(buffer.length > 5000, 'quatro slides não cabem em poucos bytes');
});

test('apresentação sem slides não lança (gera um arquivo vazio válido)', async () => {
  const buffer = await slidesToPptx([], { title: 'Vazio' });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 4).toString('binary'), 'PK');
});
