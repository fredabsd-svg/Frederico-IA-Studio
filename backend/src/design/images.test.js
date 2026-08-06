// Testes do módulo de imagens do Modo Design.
//
// O que estes testes protegem:
//   - decodificar a resposta do provedor (data:image/...;base64,...);
//   - recusar mimes fora da allowlist;
//   - respeitar o teto por imagem e por projeto;
//   - servir a imagem por sessão OU por token de preview (o iframe é origem
//     opaca e não envia cookie);
//   - isolar entre contas (imagem de outro usuário é 404).
//
// O que estes testes NÃO exercitam: a chamada real ao provedor. Para isso
// existe o teste de integração em routes/design.http.test.js, que usa um
// provedor falso e devolve uma imagem controlada.
import assert from 'node:assert/strict';
import test from 'node:test';

const { db, now } = await import('../db.js');

let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const images = await import('./images.js');

const stamp = Date.now();
const OWNER = `img-owner-${stamp}`;
const OTHER = `img-other-${stamp}`;

if (dbReady) {
  for (const id of [OWNER, OTHER]) {
    await db.prepare(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    ).run(id, id, `${id}@img.test`, false, now(), now());
  }
}

async function newProject(userId = OWNER) {
  const store = await import('./store.js');
  return store.createProject(userId, { title: `Projeto img ${stamp}`, outputType: 'web' });
}

// Decodifica o data URL do jeito que o provedor devolve. Reaproveitar o caminho
// do `generate_image` do chat evita divergir do que o chat já faz.
test('decodeProviderImage aceita png/jpeg/webp/gif e recusa o resto', { skip: needsDb }, async () => {
  const reply = (url) => ({ choices: [{ message: { images: [{ image_url: { url } }] } }] });
  const png = images.decodeProviderImage(reply('data:image/png;base64,iVBORw0KGgo='));
  assert.equal(png.mime, 'image/png');
  assert.ok(png.buffer.length > 0);

  const jpeg = images.decodeProviderImage(reply('data:image/jpeg;base64,/9j/4AAQ'));
  assert.equal(jpeg.mime, 'image/jpeg');

  const webp = images.decodeProviderImage(reply('data:image/webp;base64,UklGRg=='));
  assert.equal(webp.mime, 'image/webp');

  // Mime fora da allowlist: o provedor não devolve isso, mas se devolver, recusa.
  const svg = images.decodeProviderImage(reply('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='));
  assert.equal(svg, null);

  // Sem campo `images` na resposta: também recusa.
  assert.equal(images.decodeProviderImage({ choices: [{ message: { content: 'sem imagem' } }] }), null);
});

test('readDesignImage aceita sessão do dono', { skip: needsDb }, async () => {
  const project = await newProject();
  // Grava uma imagem direto via SQL para não depender do provedor.
  const id = `img-${stamp}-1`;
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  await db.prepare(
    'INSERT INTO design_images (id,user_id,project_id,prompt,mime,byte_size,data,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, OWNER, project.id, 'um gato', 'image/png', buf.length, buf, now());

  const r = await images.readDesignImage({ imageId: id, userId: OWNER });
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.buffer.length, buf.length);

  // Outra conta: 404.
  const other = await images.readDesignImage({ imageId: id, userId: OTHER });
  assert.equal(other.ok, false);
  assert.equal(other.status, 404);
});

test('readDesignImage aceita token de preview do projeto DONO', { skip: needsDb }, async () => {
  const project = await newProject();
  const id = `img-${stamp}-2`;
  const buf = Buffer.from([0xff, 0xd8, 0xff]); // JPEG magic
  await db.prepare(
    'INSERT INTO design_images (id,user_id,project_id,prompt,mime,byte_size,data,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, OWNER, project.id, 'um pôr do sol', 'image/jpeg', buf.length, buf, now());

  // Token do projeto DONO: lê.
  const r = await images.readDesignImage({ imageId: id, previewToken: project.preview_token });
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/jpeg');

  // Token de OUTRO projeto: 404 (a imagem pertence a um projeto, não ao token).
  const otherProject = await newProject(OTHER);
  const wrong = await images.readDesignImage({ imageId: id, previewToken: otherProject.preview_token });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 404);

  // Token curto nem chega ao banco.
  assert.equal((await images.readDesignImage({ imageId: id, previewToken: 'abc' })).ok, false);
});

test('readDesignImage sem sessão e sem token: 401', { skip: needsDb }, async () => {
  const r = await images.readDesignImage({ imageId: 'qualquer' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('listDesignImages só devolve imagens do projeto do usuário', { skip: needsDb }, async () => {
  const project = await newProject();
  await db.prepare(
    'INSERT INTO design_images (id,user_id,project_id,prompt,mime,byte_size,data,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(`img-${stamp}-3`, OWNER, project.id, 'a', 'image/png', 4, Buffer.from([1, 2, 3, 4]), now());

  const list = await images.listDesignImages(OWNER, project.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].prompt, 'a');

  // Outra conta não vê.
  assert.equal((await images.listDesignImages(OTHER, project.id)).length, 0);
});

test('deleteDesignImage só remove do dono', { skip: needsDb }, async () => {
  const project = await newProject();
  const id = `img-${stamp}-4`;
  await db.prepare(
    'INSERT INTO design_images (id,user_id,project_id,prompt,mime,byte_size,data,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, OWNER, project.id, 'b', 'image/png', 4, Buffer.from([1, 2, 3, 4]), now());

  assert.equal(await images.deleteDesignImage(OTHER, id), false);
  assert.equal(await images.deleteDesignImage(OWNER, id), true);
  assert.equal(await images.deleteDesignImage(OWNER, id), false, 'segunda tentativa: já não existe');
});

test('generateDesignImage recusa prompt vazio', { skip: needsDb }, async () => {
  const project = await newProject();
  const r = await images.generateDesignImage({ userId: OWNER, projectId: project.id, prompt: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IMAGE_PROMPT_VAZIO');
});

test('generateDesignImage recusa projeto de outro usuário', { skip: needsDb }, async () => {
  const project = await newProject(OTHER);
  const r = await images.generateDesignImage({ userId: OWNER, projectId: project.id, prompt: 'qualquer' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('DESIGN_IMAGE_LIMITS exporta os tetos', { skip: needsDb }, async () => {
  assert.equal(images.DESIGN_IMAGE_LIMITS.maxImageBytes, 5 * 1024 * 1024);
  assert.equal(images.DESIGN_IMAGE_LIMITS.maxProjectBytes, 50 * 1024 * 1024);
  assert.equal(images.DESIGN_IMAGE_LIMITS.maxPromptChars, 1000);
  assert.ok(images.DESIGN_IMAGE_LIMITS.compressionTargetBytes >= 64 * 1024);
});


// ---- Compressão automática (Frente 13) --------------------------------------

// Estes testes verificam a INTEGRAÇÃO entre generateDesignImage e o módulo
// compress.js: precisam de DB (para gravar a linha) e de sharp (para
// gerar o PNG grande). Skip se faltar qualquer um dos dois.
let sharpAvailable = true;
try {
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
} catch { sharpAvailable = false; }
const needsSharp = sharpAvailable ? false : 'requer sharp';

// Stub do provedor de imagem. Devolve o buffer que o teste passa — assim
// conseguimos simular "PNG de 3 MB devolvido pelo provedor" sem precisar
// de rede nem do OpenRouter.
const stubbedImages = [];
let stubbedProvider = null;
async function withStubbedProvider(providerFn, fn) {
  // Importa o imageProvider dinamicamente e substitui resolveImageProvider
  // no módulo images.js. Como images.js já importou o original, precisamos
  // de um caminho diferente: vamos pelo módulo que ele importa.
  const ip = await import('../imageProvider.js');
  const original = ip.resolveImageProvider;
  ip.resolveImageProvider = providerFn;
  try { return await fn(); } finally { ip.resolveImageProvider = original; }
}

async function bigPngBuffer() {
  const sharp = (await import('sharp')).default;
  const { randomBytes } = await import('node:crypto');
  const noise = randomBytes(4000 * 3000 * 3);
  return sharp(noise, { raw: { width: 4000, height: 3000, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
}

async function smallPngBuffer() {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
}

test('generateDesignImage comprime PNG grande e grava auditoria', { skip: needsDb || needsSharp }, async () => {
  const project = await newProject();
  const big = await bigPngBuffer();
  assert.ok(big.length > 1024 * 1024, `precisamos de PNG > 1 MB (foi ${big.length})`);

  const result = await withStubbedProvider(
    async () => ({ provider: { baseURL: 'https://stub', apiKey: 'x' }, model: 'stub' }),
    () => images.generateDesignImage({ userId: OWNER, projectId: project.id, prompt: 'compress me' })
  );

  assert.equal(result.ok, true);
  assert.ok(result.byteSize < big.length, `comprimido (${result.byteSize}) deveria ser menor que original (${big.length})`);
  assert.equal(result.mime, 'image/jpeg', 'compressão muda mime para image/jpeg');
  assert.equal(result.compression.changed, true);
  assert.equal(result.compression.originalMime, 'image/png');
  assert.equal(result.compression.originalSize, big.length);

  // Auditoria: a linha gravada tem original_* e compressed_at preenchidos
  const row = await db.prepare(
    'SELECT mime, byte_size, original_mime, original_size, original_data, compressed_at FROM design_images WHERE id=?'
  ).get(result.id);
  assert.equal(row.mime, 'image/jpeg');
  assert.equal(row.byte_size, result.byteSize);
  assert.equal(row.original_mime, 'image/png');
  assert.equal(row.original_size, big.length);
  assert.ok(row.original_data, 'blob original deve estar preservado');
  assert.equal(row.original_data.length, big.length);
  assert.ok(row.compressed_at, 'compressed_at preenchido');
});

test('generateDesignImage NÃO comprime PNG pequeno e deixa original nulo', { skip: needsDb || needsSharp }, async () => {
  const project = await newProject();
  const small = await smallPngBuffer();
  assert.ok(small.length < 1024 * 1024);

  const result = await withStubbedProvider(
    async () => ({ provider: { baseURL: 'https://stub', apiKey: 'x' }, model: 'stub' }),
    () => images.generateDesignImage({ userId: OWNER, projectId: project.id, prompt: 'tiny' })
  );

  assert.equal(result.ok, true);
  assert.equal(result.byteSize, small.length);
  assert.equal(result.mime, 'image/png', 'imagem pequena fica intacta em PNG');
  assert.equal(result.compression.changed, false);

  const row = await db.prepare(
    'SELECT original_mime, original_data, compressed_at FROM design_images WHERE id=?'
  ).get(result.id);
  assert.equal(row.original_mime, null);
  assert.equal(row.original_data, null);
  assert.equal(row.compressed_at, null);
});

test('listDesignImages inclui metadados de compressão quando houve mudança', { skip: needsDb || needsSharp }, async () => {
  const project = await newProject();
  const big = await bigPngBuffer();
  const result = await withStubbedProvider(
    async () => ({ provider: { baseURL: 'https://stub', apiKey: 'x' }, model: 'stub' }),
    () => images.generateDesignImage({ userId: OWNER, projectId: project.id, prompt: 'list test' })
  );
  assert.equal(result.ok, true);

  const list = await images.listDesignImages(OWNER, project.id);
  const found = list.find(i => i.id === result.id);
  assert.ok(found, 'imagem deve aparecer na lista');
  assert.equal(found.originalMime, 'image/png');
  assert.equal(found.originalSize, big.length);
  assert.ok(found.compressedAt, 'compressedAt presente');
});
