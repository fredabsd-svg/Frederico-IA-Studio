import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OUTPUT_TYPES, MAX_SLIDES, buildSystemPrompt, designSystemBlock, buildGenerateMessages,
  stripCodeFence, extractHtmlDocument, extractJsonObject, parseSlidesJson, normalizeSlide,
  extractArtifact, contentMatchesType, sanitizeProjectInput, sanitizeColor, sanitizeFontName,
  sanitizeDesignSystemInput, versionSummary, resolveExportFormat, safeFileName,
  sanitizeTarget, targetBlock, MAX_TARGET_HTML, MAX_TARGET_TEXT,
} from './core.js';

// A resposta do modelo é a fronteira menos confiável do Modo Design: ele pode
// devolver o artefato limpo, embrulhado em cerca de código, com um "claro,
// segue abaixo" na frente ou simplesmente errado. Estes testes fixam o que
// entra no banco — e, por consequência, o que o iframe renderiza.

const HTML = '<!DOCTYPE html>\n<html lang="pt-BR"><head><title>x</title></head><body><h1>Oi</h1></body></html>';

// ---- System prompt ---------------------------------------------------------

test('o system prompt muda com o tipo de saída', () => {
  assert.match(buildSystemPrompt('web'), /mobile-first/i);
  assert.match(buildSystemPrompt('slides'), /"slides"/);
  assert.match(buildSystemPrompt('document'), /A4/);
  // Regras específicas não se misturam: pedir slides não deve trazer a
  // instrução de responsividade de página web (o modelo obedeceria as duas).
  assert.doesNotMatch(buildSystemPrompt('slides'), /mobile-first/i);
});

test('tipo desconhecido cai nas regras de web em vez de ficar sem regra', () => {
  assert.equal(buildSystemPrompt('planilha'), buildSystemPrompt('web'));
});

test('o design system entra no prompt só quando tem algum campo', () => {
  assert.equal(designSystemBlock(null), '');
  assert.equal(designSystemBlock({ name: '' }), '');
  const block = designSystemBlock({ name: 'Frederico', primaryColor: '#123456', fontBody: 'Inter' });
  assert.match(block, /Frederico/);
  assert.match(block, /#123456/);
  assert.match(block, /Inter/);
});

test('a edição manda o conteúdo atual e instrui a não recomeçar', () => {
  const msgs = buildGenerateMessages({ outputType: 'web', prompt: 'deixe o botão verde', current: HTML });
  const user = msgs.at(-1).content;
  assert.match(user, /HTML ATUAL/);
  assert.ok(user.includes(HTML), 'o HTML atual precisa ir inteiro');
  assert.match(user, /deixe o botão verde/);
});

test('a primeira geração não inventa um "conteúdo atual" vazio', () => {
  const msgs = buildGenerateMessages({ outputType: 'web', prompt: 'landing de contabilidade' });
  assert.equal(msgs.length, 2);
  assert.equal(msgs.at(-1).content, 'landing de contabilidade');
});

test('o histórico do chat entra limitado e sem papéis estranhos', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  history.push({ role: 'system', content: 'ignorar isto' });
  const msgs = buildGenerateMessages({ outputType: 'web', prompt: 'x', history, maxHistory: 4 });
  assert.equal(msgs.length, 2 + 4);
  assert.ok(!msgs.some(m => m.content === 'ignorar isto'));
});

// ---- Extração --------------------------------------------------------------

test('desembrulha a cerca de código que envolve a resposta inteira', () => {
  assert.equal(stripCodeFence('```html\n<h1>a</h1>\n```'), '<h1>a</h1>');
  assert.equal(stripCodeFence('```\n<h1>a</h1>\n```'), '<h1>a</h1>');
  assert.equal(stripCodeFence('<h1>a</h1>'), '<h1>a</h1>');
});

test('uma cerca NO MEIO do HTML não é cortada', () => {
  // Uma página gerada pode conter um bloco de código como conteúdo. Se a
  // heurística cortasse no primeiro ```, o documento sairia truncado.
  const doc = `${HTML.replace('</body>', '<pre>```bash\nls\n```</pre></body>')}`;
  assert.equal(stripCodeFence(doc), doc);
  assert.ok(extractHtmlDocument(doc).endsWith('</html>'));
});

test('recorta o documento HTML mesmo com conversa em volta', () => {
  const noisy = `Claro! Segue a página:\n\n${HTML}\n\nQualquer ajuste me diga.`;
  assert.equal(extractHtmlDocument(noisy), HTML);
});

test('sem documento HTML reconhecível o resultado é vazio (e a geração falha)', () => {
  assert.equal(extractHtmlDocument('só um texto explicando o design'), '');
  const r = extractArtifact('só um texto explicando o design', 'web');
  assert.equal(r.ok, false);
  assert.match(r.error, /HTML completo/);
});

test('aceita o documento que começa em <html> sem DOCTYPE', () => {
  const r = extractArtifact('<html><body><p>a</p></body></html>', 'web');
  assert.equal(r.ok, true);
});

test('extração de JSON ignora chaves dentro de string', () => {
  // Sem tratar string, um título com "{" desbalancearia a contagem e o recorte
  // sairia no lugar errado — JSON inválido a partir de um JSON válido.
  const raw = 'Segue: {"slides":[{"layout":"title","title":"Plano { A }","body":"ok"}]} pronto';
  const json = extractJsonObject(raw);
  assert.deepEqual(JSON.parse(json).slides[0].title, 'Plano { A }');
});

test('extração de JSON tolera chave escapada dentro de string', () => {
  const raw = '{"slides":[{"layout":"content","title":"a \\" { b","body":""}]}';
  assert.equal(extractJsonObject(raw), raw);
});

test('slides: layout inválido cai em content em vez de virar slide em branco', () => {
  assert.equal(normalizeSlide({ layout: 'carrossel-3d' }).layout, 'content');
  assert.equal(normalizeSlide({ layout: 'two-column' }).layout, 'two-column');
  assert.equal(normalizeSlide(null).layout, 'content');
});

test('slides: campos desconhecidos são descartados', () => {
  const s = normalizeSlide({ layout: 'title', title: 'a', body: 'b', notes: 'c', onclick: 'alert(1)' });
  assert.deepEqual(Object.keys(s).sort(), ['body', 'layout', 'notes', 'title']);
});

test('slides: JSON sem a chave "slides" é recusado com mensagem própria', () => {
  assert.match(parseSlidesJson('{"paginas":[]}').error, /"slides"/);
  assert.match(parseSlidesJson('{"slides":[]}').error, /nenhum slide/);
  assert.match(parseSlidesJson('{"slides": [ops]}').error, /inválido/);
  assert.match(parseSlidesJson('nada aqui').error, /não trouxe/);
  // Objeto que nunca fecha: não há o que recortar, então a mensagem é a de
  // "não veio JSON" — e não a de JSON inválido.
  assert.match(parseSlidesJson('{"slides":').error, /não trouxe/);
});

test(`slides: a lista é cortada em ${MAX_SLIDES}`, () => {
  const many = { slides: Array.from({ length: MAX_SLIDES + 20 }, () => ({ layout: 'content', title: 't' })) };
  const parsed = parseSlidesJson(JSON.stringify(many));
  assert.equal(parsed.slides.length, MAX_SLIDES);
});

test('slides: o artefato guardado é o JSON normalizado, não a resposta crua', () => {
  const raw = '```json\n{"slides":[{"layout":"xpto","title":"A","extra":1}]}\n```';
  const r = extractArtifact(raw, 'slides');
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.content);
  assert.deepEqual(parsed.slides, [{ layout: 'content', title: 'A', body: '', notes: '' }]);
});

test('resposta vazia do modelo é erro, não artefato vazio', () => {
  assert.equal(extractArtifact('', 'web').ok, false);
  assert.equal(extractArtifact('   ', 'slides').ok, false);
});

// ---- Conteúdo × tipo -------------------------------------------------------

test('o conteúdo salvo é conferido contra o tipo antes de renderizar', () => {
  assert.equal(contentMatchesType(HTML, 'web'), true);
  assert.equal(contentMatchesType(HTML, 'document'), true);
  // O descasamento que este guarda existe para pegar: JSON gravado num projeto
  // `web` (ou HTML num projeto `slides`) renderizaria fora do formato previsto.
  assert.equal(contentMatchesType(HTML, 'slides'), false);
  assert.equal(contentMatchesType('{"slides":[{"layout":"title"}]}', 'web'), false);
  assert.equal(contentMatchesType('{"slides":[{"layout":"title"}]}', 'slides'), true);
  assert.equal(contentMatchesType('', 'web'), false);
  assert.equal(contentMatchesType(HTML, 'planilha'), false);
});

test('HTML precisa COMEÇAR com o documento para ser aceito como salvo', () => {
  // `extractArtifact` já recorta a resposta; o que chega ao banco não deve ter
  // texto antes do documento. Aceitar aqui esconderia uma escrita malfeita.
  assert.equal(contentMatchesType(`oi\n${HTML}`, 'web'), false);
});

// ---- Entradas do cliente ---------------------------------------------------

test('tipo de saída desconhecido cai em web e o título ganha padrão', () => {
  const p = sanitizeProjectInput({ outputType: 'video' });
  assert.equal(p.outputType, 'web');
  assert.equal(p.title, 'Novo site');
  assert.equal(sanitizeProjectInput({ outputType: 'slides' }).title, 'Nova apresentação');
  for (const type of OUTPUT_TYPES) assert.equal(sanitizeProjectInput({ outputType: type }).outputType, type);
});

test('cor só passa como hex — o valor vai para dentro de CSS', () => {
  assert.equal(sanitizeColor('#1f3b8a'), '#1f3b8a');
  assert.equal(sanitizeColor('#ABC'), '#ABC');
  assert.equal(sanitizeColor('red'), null);
  assert.equal(sanitizeColor('#fff; content:url(http://x)'), null);
  assert.equal(sanitizeColor(''), null);
});

test('nome de fonte recusa aspas e ponto e vírgula (fuga da declaração CSS)', () => {
  assert.equal(sanitizeFontName('Inter'), 'Inter');
  assert.equal(sanitizeFontName('Playfair Display'), 'Playfair Display');
  assert.equal(sanitizeFontName("Inter'; } body{display:none} '"), null);
  assert.equal(sanitizeFontName('Inter<script>'), null);
});

test('design system inválido vira nulo em vez de valor cru', () => {
  const ds = sanitizeDesignSystemInput({ name: '', primaryColor: 'azul', fontBody: 'a"b', notes: '  x  ' });
  assert.equal(ds.name, 'Minha marca');
  assert.equal(ds.primaryColor, null);
  assert.equal(ds.fontBody, null);
  assert.equal(ds.notes, 'x');
});

// ---- Exportação ------------------------------------------------------------

test('formato de exportação só pode ser um dos permitidos pelo tipo', () => {
  assert.equal(resolveExportFormat('web', 'pptx'), 'html');
  assert.equal(resolveExportFormat('web', 'html'), 'html');
  assert.equal(resolveExportFormat('slides', 'pptx'), 'pptx');
  assert.equal(resolveExportFormat('slides', 'PDF'), 'pdf');
  assert.equal(resolveExportFormat('document', 'pptx'), 'html');
  assert.equal(resolveExportFormat('document', 'pdf'), 'pdf');
  assert.equal(resolveExportFormat('web', undefined), 'html');
});

test('nome de arquivo perde acento, espaço e barra (vai no Content-Disposition)', () => {
  assert.equal(safeFileName('Proposta Comercial — Ação', 'pdf'), 'proposta-comercial-acao.pdf');
  assert.equal(safeFileName('../../etc/passwd', 'html'), 'etc-passwd.html');
  assert.equal(safeFileName('"; rm -rf /', 'html'), 'rm-rf.html');
  assert.equal(safeFileName('', 'html'), 'design.html');
});

test('o resumo da versão diz o que mudou sem despejar o artefato', () => {
  assert.match(versionSummary('slides', 3, '{"slides":[{"layout":"title"},{"layout":"content"}]}'), /Versão 3.*2 slides/);
  assert.match(versionSummary('slides', 1, '{"slides":[{"layout":"title"}]}'), /1 slide\./);
  assert.match(versionSummary('web', 2, HTML), /Versão 2.*KB de HTML/);
});

// ---- Edição inline ---------------------------------------------------------

test('o alvo vindo da prévia é normalizado antes de virar prompt', () => {
  // O descritor nasce DENTRO do iframe, o contexto que executa código gerado
  // por IA. Campo fora da lista some; texto e HTML entram limitados.
  const alvo = sanitizeTarget({
    tag: 'H1', classes: 'hero', id: 'titulo', caminho: 'section > h1',
    texto: 'x'.repeat(9999), html: 'y'.repeat(9999), truncado: true,
    onclick: 'alert(1)', extra: { a: 1 },
  });
  assert.equal(alvo.tag, 'h1');
  assert.equal(alvo.texto.length, MAX_TARGET_TEXT);
  assert.equal(alvo.html.length, MAX_TARGET_HTML);
  assert.deepEqual(Object.keys(alvo).sort(), ['caminho', 'classes', 'html', 'id', 'slide', 'tag', 'texto', 'truncado']);
});

test('alvo vazio ou sem nada que identifique vira null (edição normal)', () => {
  assert.equal(sanitizeTarget(null), null);
  assert.equal(sanitizeTarget('h1'), null);
  assert.equal(sanitizeTarget({}), null);
  assert.equal(sanitizeTarget({ classes: 'só isso' }), null);
});

test('número de slide inválido não passa', () => {
  assert.equal(sanitizeTarget({ slide: 0, tag: 'h1' }).slide, null);
  assert.equal(sanitizeTarget({ slide: -3, tag: 'h1' }).slide, null);
  assert.equal(sanitizeTarget({ slide: 'abc', tag: 'h1' }).slide, null);
  assert.equal(sanitizeTarget({ slide: 3.7, tag: 'h1' }).slide, 3);
  assert.equal(sanitizeTarget({ slide: 9999, tag: 'h1' }).slide, MAX_SLIDES);
});

test('o bloco do alvo manda alterar SÓ aquele elemento', () => {
  const bloco = targetBlock(sanitizeTarget({ tag: 'h1', classes: 'hero', texto: 'Bem-vindo', html: '<h1 class="hero">Bem-vindo</h1>' }), 'web');
  assert.match(bloco, /ALVO/);
  assert.match(bloco, /<h1>/);
  assert.match(bloco, /class: hero/);
  assert.match(bloco, /<h1 class="hero">Bem-vindo<\/h1>/);
  assert.match(bloco, /APENAS esse elemento/);
});

test('em slides o alvo é o NÚMERO do slide, nunca o HTML do deck', () => {
  // O modelo edita o JSON; o HTML do deck é montado por nós. Mandar essa
  // marcação o faria devolver HTML onde deve devolver JSON — e o artefato
  // inteiro seria recusado.
  const alvo = sanitizeTarget({ tag: 'h2', slide: 3, texto: 'Escopo', html: '<h2>Escopo</h2>' });
  const bloco = targetBlock(alvo, 'slides');
  assert.match(bloco, /slide 3/);
  assert.match(bloco, /APENAS esse slide/);
  assert.ok(!bloco.includes('<h2>'), 'nada de marcação do deck no prompt de slides');
});

test('clique fora de um slide não vira alvo numa apresentação', () => {
  assert.equal(targetBlock(sanitizeTarget({ tag: 'main', texto: 'fundo' }), 'slides'), '');
});

test('sem alvo, a mensagem de edição fica como era antes', () => {
  const semAlvo = buildGenerateMessages({ outputType: 'web', prompt: 'mude a cor', current: HTML });
  assert.ok(!semAlvo.at(-1).content.includes('ALVO'));
});

test('com alvo, o bloco entra entre o artefato e o pedido', () => {
  const alvo = sanitizeTarget({ tag: 'h1', texto: 'Bem-vindo', html: '<h1>Bem-vindo</h1>' });
  const user = buildGenerateMessages({ outputType: 'web', prompt: 'deixe maior', current: HTML, target: alvo }).at(-1).content;
  assert.ok(user.indexOf('HTML ATUAL') < user.indexOf('ALVO'), 'o artefato vem primeiro');
  assert.ok(user.indexOf('ALVO') < user.indexOf('deixe maior'), 'o pedido vem por último');
});

test('o contrato das variáveis de ajuste só vale para saídas HTML', () => {
  // Em `slides` o CSS é nosso (o deck), e pedir um bloco :root ao modelo o
  // convidaria a devolver CSS onde ele deve devolver JSON.
  assert.match(buildSystemPrompt('web'), /--fred-cor-primaria/);
  assert.match(buildSystemPrompt('document'), /--fred-cor-primaria/);
  assert.doesNotMatch(buildSystemPrompt('slides'), /--fred-cor-primaria/);
});
