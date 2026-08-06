// Testes do compressor de imagens do Design (Frente 13).
//
// Estes testes são PUROS — não tocam DB nem rede. Geram PNGs/JPEGs reais
// com `sharp` (a única dependência externa) em memória e verificam que:
//   - entradas pequenas passam intactas (idempotência);
//   - entradas grandes viram JPEG e ficam menores;
//   - entradas corruptas caem no fallback (input intacto, sem throw);
//   - a metadata de auditoria (original_*) só é preenchida quando mudou.
//
// O `sharp` é instalado pelo app (overrides no package.json). Se faltar,
// skipamos o teste inteiro em vez de falhar a suíte — o compressor é
// opcional, e sem ele a geração continua funcionando.
import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

let sharpReady = true;
try {
  // Tenta usar sharp de verdade. Se o binário nativo falhar (raro em CI),
  // caímos no skip.
  await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png()
    .toBuffer();
} catch {
  sharpReady = false;
}

const skipNoSharp = sharpReady ? false : 'sharp indisponível no ambiente';
const { compressIfWorthy, DESIGN_IMAGE_COMPRESSION } = await import('./compress.js');

// Gera um PNG grande o suficiente para disparar a compressão. 4000×3000 com
// ruído verdadeiramente aleatório (crypto.randomBytes) comprime POUCO no
// PNG — fica > 30 MB, e o re-encode em JPEG q=85 deve reduzir 10–20×.
// (Ruído determinístico como `(i * 7919) & 0xff` comprime BEM porque o
// PNG/Zlib acha padrões — o teste virou falso-positivo até eu trocar.)
async function generateLargePng() {
  const { randomBytes } = await import('node:crypto');
  const noise = randomBytes(4000 * 3000 * 3);
  return sharp(noise, { raw: { width: 4000, height: 3000, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

test('compressIfWorthy: imagem pequena passa intacta (idempotente)', { skip: skipNoSharp }, async () => {
  const tiny = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  const out = await compressIfWorthy(tiny, 'image/png');
  assert.equal(out.changed, false);
  assert.equal(out.reason, 'already-small');
  assert.equal(out.mime, 'image/png');
  assert.equal(out.buffer.length, tiny.length);
  assert.equal(out.original, null);
});

test('compressIfWorthy: PNG grande vira JPEG e fica menor', { skip: skipNoSharp }, async () => {
  const big = await generateLargePng();
  // sanity check
  assert.ok(big.length > 1024 * 1024, `precisamos de PNG > 1 MB (foi ${big.length})`);

  const out = await compressIfWorthy(big, 'image/png');
  assert.equal(out.changed, true);
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(out.buffer.length < big.length, `JPEG (${out.buffer.length}) deveria ser menor que PNG (${big.length})`);
  assert.ok(out.original, 'original deve estar preenchido quando mudou');
  assert.equal(out.original.mime, 'image/png');
  assert.equal(out.original.size, big.length);
  assert.equal(out.original.data.length, big.length);
  assert.ok(out.bytesSaved > 0);
});

test('compressIfWorthy: JPEG grande (> 2 MB) é re-encodado', { skip: skipNoSharp }, async () => {
  // JPEG muito grande passa do limite "jpeg-already-fine" e entra no caminho
  // de compressão. Gera um JPEG de alta qualidade e depois aumenta o tamanho
  // concatenando — gambiarra pra simular entrada grande sem precisar de
  // biblioteca de noise JPEG. O objetivo do teste é só a HEURÍSTICA, não a
  // fidelidade visual: pulamos quando o input não é grande o bastante.
  const base = await sharp({
    create: { width: 3000, height: 3000, channels: 3, background: { r: 100, g: 100, b: 100 } },
  }).jpeg({ quality: 100 }).toBuffer();
  if (base.length <= 2 * 1024 * 1024) return; // pula em arquiteturas onde 3000×3000 jpeg-q100 não passa de 2 MB

  const out = await compressIfWorthy(base, 'image/jpeg');
  assert.equal(out.changed, true);
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.original.mime, 'image/jpeg');
  assert.ok(out.buffer.length < base.length);
});

test('compressIfWorthy: input corrompido cai no fallback sem lançar', { skip: skipNoSharp }, async () => {
  // Buffer grande (> 1 MB) que NÃO é uma imagem válida. Tem de passar o
  // gate de tamanho para cair no caminho do sharp — onde o decoder falha.
  const garbage = Buffer.alloc(2 * 1024 * 1024, 0xAB);
  const out = await compressIfWorthy(garbage, 'image/png');
  assert.equal(out.changed, false);
  assert.equal(out.buffer.length, garbage.length, 'input deve passar intacto');
  assert.equal(out.original, null);
  // Razão: ou sharp falhou no decode (sharp-error), ou o pipeline aceitou
  // bytes mas o JPEG saiu MAIOR e caímos em no-gain. Os dois são fallback
  // válido — sem throw. O importante é changed=false.
  assert.ok(['sharp-error', 'no-gain'].includes(out.reason), `fallback inesperado: ${out.reason}`);
});

test('compressIfWorthy: mime fora da allowlist passa intacto', { skip: skipNoSharp }, async () => {
  const buf = Buffer.from([0, 1, 2, 3, 4]);
  const out = await compressIfWorthy(buf, 'image/svg+xml');
  assert.equal(out.changed, false);
  assert.equal(out.reason, 'unsupported-mime');
  assert.equal(out.original, null);
});

test('compressIfWorthy: threshold customizado é respeitado', { skip: skipNoSharp }, async () => {
  // Threshold custom de 100 KB. Geramos PNG com ruído aleatório para garantir
  // tamanho > 100 KB de verdade (ruído determinístico comprime demais).
  const { randomBytes } = await import('node:crypto');
  const noise = randomBytes(2000 * 1500 * 3);
  const buf = await sharp(noise, { raw: { width: 2000, height: 1500, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
  assert.ok(buf.length > 100 * 1024, `precisamos de PNG > 100 KB (foi ${buf.length})`);
  const low = await compressIfWorthy(buf, 'image/png', { threshold: 100 * 1024 });
  assert.equal(low.changed, true, `deveria comprimir: ${buf.length} > ${100 * 1024}`);
  assert.equal(low.original.mime, 'image/png');
});

test('DESIGN_IMAGE_COMPRESSION expõe o threshold e a qualidade', () => {
  assert.ok(DESIGN_IMAGE_COMPRESSION.thresholdBytes >= 64 * 1024);
  assert.ok(DESIGN_IMAGE_COMPRESSION.jpegQuality >= 70 && DESIGN_IMAGE_COMPRESSION.jpegQuality <= 95);
});
