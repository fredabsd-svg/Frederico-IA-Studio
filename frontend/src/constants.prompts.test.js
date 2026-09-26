import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// `constants.js` usa import.meta.env (Vite) e não é importável no Node: o texto
// dos prompts é conferido direto na fonte.
const fonte = readFileSync(new URL('./constants.js', import.meta.url), 'utf8');
const trechoDoApp = (titulo) => {
  const inicio = fonte.indexOf(`title: '${titulo}'`);
  assert.ok(inicio >= 0, `app "${titulo}" deveria existir`);
  return fonte.slice(inicio, fonte.indexOf('},', fonte.indexOf('prompt:', inicio)));
};

// O kit do backend (prompts/docpro/atual.txt, REGRA ZERO) proíbe diagramar fora
// do kit e define fonte, cor e capa pelo PRESET. O app embutido mandava Arial/
// Calibri, azul-marinho e python-docx na mão — duas ordens contrárias na mesma
// chamada.
test('"Documento profissional" pede o kit, sem regras de diagramação próprias', () => {
  const app = trechoDoApp('Documento profissional');
  assert.match(app, /kit de documentos profissionais/);
  assert.match(app, /docpro/);
  for (const proibido of [/Arial/, /Calibri/, /azul-marinho/i, /python-docx/, /DOC_RULES/]) {
    assert.doesNotMatch(app, proibido);
  }
  assert.doesNotMatch(fonte, /const DOC_RULES/);
});

test('os modelos de assistente seguem o idioma do usuário (padrão pt-BR)', () => {
  const inicio = fonte.indexOf('export const TEMPLATES');
  const templates = fonte.slice(inicio, fonte.indexOf('];', inicio));
  assert.doesNotMatch(templates, /Responda em português do Brasil/);
  assert.equal((templates.match(/Responda no idioma do usuário \(padrão: português do Brasil\)/g) || []).length, 6);
});
