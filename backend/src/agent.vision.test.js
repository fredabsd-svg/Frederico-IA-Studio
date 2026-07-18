import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-vision-tests';

const { attachImagesToLastUserMessage, stripImagePartsFromMessages } = await import('./agent.js');

const imgPart = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };

test('anexa imagens à última mensagem do usuário preservando o texto', () => {
  const messages = [
    { role: 'system', content: 'regras' },
    { role: 'user', content: 'Primeira pergunta' },
    { role: 'assistant', content: 'resposta' },
    { role: 'user', content: 'O que diz este documento?' }
  ];
  const changed = attachImagesToLastUserMessage(messages, [imgPart]);
  assert.equal(changed, true);
  const last = messages[3];
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content[0].type, 'text');
  assert.equal(last.content[0].text, 'O que diz este documento?');
  assert.equal(last.content[1].type, 'image_url');
  // não mexeu na mensagem anterior do usuário
  assert.equal(messages[1].content, 'Primeira pergunta');
});

test('usa um texto padrão quando o usuário só mandou a imagem', () => {
  const messages = [{ role: 'user', content: '' }];
  attachImagesToLastUserMessage(messages, [imgPart]);
  assert.equal(messages[0].content[0].text.length > 0, true);
});

test('sem imagens não altera nada', () => {
  const messages = [{ role: 'user', content: 'oi' }];
  assert.equal(attachImagesToLastUserMessage(messages, []), false);
  assert.equal(messages[0].content, 'oi');
});

test('strip volta o conteúdo do usuário para texto puro (fallback de OCR)', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'ler isto' }, imgPart] }];
  stripImagePartsFromMessages(messages);
  assert.equal(messages[0].content, 'ler isto');
});
