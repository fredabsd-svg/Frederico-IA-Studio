import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, parseSlideBody, splitColumns, renderSlidesDeck, renderPlaceholder } from './render.js';
import { detectTokens } from './tokens.js';

// O deck de slides é o único HTML do Modo Design que NÓS montamos — nos
// projetos `web`/`document` o HTML é do modelo e roda em origem opaca. Aqui o
// esqueleto é nosso, então o texto vindo do modelo (e do usuário, via prompt)
// não pode virar marcação: é o que estes testes travam.

test('escapa os cinco caracteres que quebram marcação', () => {
  assert.equal(escapeHtml('<a href="x">& \'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp; &#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
});

test('título e corpo do slide não injetam HTML no deck', () => {
  const html = renderSlidesDeck([
    { layout: 'content', title: '<img src=x onerror=alert(1)>', body: '- <script>alert(2)</script>', notes: '' },
  ], { title: '</title><script>alert(3)</script>' });
  assert.ok(!html.includes('<img src=x'), 'o título não pode virar tag');
  assert.ok(!html.includes('<script>alert(2)'), 'o marcador não pode virar tag');
  assert.ok(!html.includes('<script>alert(3)'), 'o título do documento não pode fechar o <title>');
  assert.match(html, /&lt;img src=x/);
});

test('linhas iniciadas por marcador viram uma lista só', () => {
  const blocks = parseSlideBody('Intro\n- um\n- dois\n\nFecho');
  assert.deepEqual(blocks, [
    { type: 'text', text: 'Intro' },
    { type: 'list', items: ['um', 'dois'] },
    { type: 'text', text: 'Fecho' },
  ]);
});

test('marcadores aceitam -, * e •', () => {
  assert.deepEqual(parseSlideBody('- a\n* b\n• c'), [{ type: 'list', items: ['a', 'b', 'c'] }]);
});

test('duas colunas: separador --- manda; sem ele, divide os blocos ao meio', () => {
  assert.deepEqual(splitColumns('esquerda\n---\ndireita'), ['esquerda\n', '\ndireita']);
  const [left, right] = splitColumns('- a\n- b\n\nc\n\nd');
  assert.match(left, /- a/);
  assert.match(right, /d/);
  // Corpo curto demais para dividir: tudo na primeira coluna, nada quebrado.
  assert.deepEqual(splitColumns('só isto'), ['só isto', '']);
});

test('o deck é autocontido: sem CDN, sem fonte remota', () => {
  const html = renderSlidesDeck([{ layout: 'title', title: 'A', body: '', notes: '' }]);
  // Exportado, o arquivo precisa abrir offline — e o Chromium que gera o PDF
  // roda sem rede garantida.
  assert.ok(!/https?:\/\//.test(html), 'nenhuma URL externa no deck');
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /@page\{size:1280px 720px/);
});

test('cada slide vira uma seção numerada', () => {
  const html = renderSlidesDeck([
    { layout: 'title', title: 'A', body: '', notes: '' },
    { layout: 'content', title: 'B', body: '- x', notes: 'falar devagar' },
    { layout: 'two-column', title: 'C', body: 'e\n---\nd', notes: '' },
    { layout: 'image-full', title: 'D', body: 'legenda', notes: '' },
  ], { title: 'Deck' });
  assert.equal((html.match(/class="slide /g) || []).length, 4);
  assert.match(html, /data-slide="4"/);
  assert.match(html, /slide-two-column/);
  assert.match(html, /<ul><li>x<\/li><\/ul>/);
  // Notas do apresentador ficam no HTML (para o .pptx e para quem inspeciona),
  // mas escondidas no slide.
  assert.match(html, /class="notes">falar devagar/);
});

test('o design system pinta o deck sem escapar da declaração CSS', () => {
  const html = renderSlidesDeck([{ layout: 'title', title: 'A', body: '', notes: '' }], {
    designSystem: { primaryColor: '#0a7d55', secondaryColor: '#ffb703', fontHeading: 'Playfair Display' },
  });
  assert.match(html, /--fred-cor-primaria:#0a7d55/);
  assert.match(html, /--fred-cor-secundaria:#ffb703/);
  assert.match(html, /'Playfair Display'/);
});

test('o deck declara as MESMAS variáveis do catálogo de ajustes', () => {
  // É o que faz os sliders de cor valerem para uma apresentação: a interface
  // descobre os controles lendo o HTML servido, e aqui o HTML é nosso.
  // `--fred-fonte-base` fica de fora de propósito — o deck escala a tipografia
  // em `cqw`, e um controle em px não teria efeito nenhum.
  const html = renderSlidesDeck([{ layout: 'title', title: 'A', body: '', notes: '' }]);
  const tokens = detectTokens(html).map(t => t.id);
  assert.deepEqual(tokens.sort(), ['corFundo', 'corPrimaria', 'corSecundaria', 'corTexto', 'raio']);
});

test('deck sem slides não quebra (gera um documento vazio válido)', () => {
  const html = renderSlidesDeck([], { title: 'Vazio' });
  assert.match(html, /<main class="deck">/);
  assert.ok(!html.includes('class="slide '));
});

test('o placeholder também escapa a mensagem', () => {
  assert.match(renderPlaceholder('<b>ops</b>'), /&lt;b&gt;ops&lt;\/b&gt;/);
});
