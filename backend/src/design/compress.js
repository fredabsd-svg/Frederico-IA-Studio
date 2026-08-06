// Compressão transparente das imagens geradas para o Modo Design.
//
// Por que existe: o `design_images` aceita até 5 MB por imagem e 50 MB por
// projeto (Regra 6.6). Sem compressão, um PNG de 4 MB entra no banco e
// engole 8% do orçamento do projeto em UMA imagem — o usuário bate no teto
// sem entender por quê. A compressão aqui é oportunística: se a imagem já é
// pequena (≤ 1 MB) ou já está num formato eficiente, ela passa intacta.
//
// Por que JPEG/WebP e não "otimizar PNG": PNG é sem perda, e o teto é de
// TAMANHO, não de perda de qualidade. Re-encodar PNG em PNG raramente reduz
// o suficiente — aplanar para JPEG q=85 comprime 5–10× sem degradação
// visível em fotos de mockup. Para ilustrações com áreas grandes de cor
// chapada, WebP mantém melhor — mas o suporte do navegador no iframe de
// preview é incerto, então JPEG é o padrão.
//
// Auditoria: quando a compressão muda o binário, o ORIGINAL (mime + size +
// data) é preservado em colunas separadas por 30 dias. O endpoint
// `/api/admin/purge-stale-image-originals` remove a coluna `original_data`
// após o prazo, mantendo o registro com `original_mime`/`original_size`
// nulos (sem o blob).
//
// Onde mora: separado de `design/images.js` porque é lógica PURA — recebe
// bytes, devolve bytes — e isso facilita o teste (não precisa de DB nem de
// rede). O módulo que grava no banco orquestra a chamada e o fallback.

import sharp from 'sharp';

// Alvo do esforço de compressão. Se a imagem já está abaixo deste tamanho,
// ela passa intacta — re-encodar uma imagem de 200 KB raramente vale o
// trabalho e pode PIORAR a qualidade.
const COMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024;  // 1 MB

// Qualidade de saída padrão. JPEG q=85 é o ponto-doce para fotos: redução
// grande de tamanho sem degradação visível. Mais alto = arquivo maior;
// mais baixo = blocos visíveis em áreas lisas.
const JPEG_QUALITY = 85;

// Mímicas aceitas na entrada. Mantemos GIF só pra passar pelo `sharp`
// (que consegue re-encodar frame estático), mas o módulo cliente (a rota
// de imagens) filtra antes — `ALLOWED_MIMES` em design/images.js é o
// gate de verdade.
const INPUT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Decide se vale a pena comprimir e, em caso afirmativo, re-encoda.
 *
 * Devolve SEMPRE:
 *   - `buffer`: bytes que vão para o banco (iguais ao input se nada mudou)
 *   - `mime`: mime que vai para o banco (igual ao input se nada mudou)
 *   - `original`: { mime, size, data } SOMENTE se houve mudança (null caso
 *     contrário). Quem grava no banco usa isso para popular as colunas de
 *     auditoria.
 *   - `changed`: boolean — true se a compressão alterou algo
 *
 * O contrato é "retornar o input se não há o que fazer": zero overhead
 * quando o caller não chama sharp, e fácil de testar (idempotência em
 * imagens pequenas é trivial de verificar).
 *
 * Em caso de erro do sharp (formato corrompido, decoder falhou), devolve
 * o input intacto e `original: null` — NÃO falhamos a geração porque a
 * compressão é otimização. O caller loga.
 */
export async function compressIfWorthy(buffer, mime, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : COMPRESS_THRESHOLD_BYTES;
  const quality = Number.isFinite(opts.quality) ? opts.quality : JPEG_QUALITY;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { buffer, mime, original: null, changed: false, reason: 'empty' };
  }
  if (!INPUT_MIMES.has(mime)) {
    return { buffer, mime, original: null, changed: false, reason: 'unsupported-mime' };
  }
  if (buffer.length <= threshold) {
    return { buffer, mime, original: null, changed: false, reason: 'already-small' };
  }

  // JPEG/WebP grandes mas já eficientes: re-encodar normalmente PIORA (mais
  // CPU, mesmo tamanho ou maior por causa de metadados). A heurística aqui
  // é conservadora: se já é JPEG e o tamanho está abaixo de 2 MB, deixa.
  if (mime === 'image/jpeg' && buffer.length <= 2 * 1024 * 1024) {
    return { buffer, mime, original: null, changed: false, reason: 'jpeg-already-fine' };
  }

  try {
    const pipeline = sharp(buffer, { failOn: 'none' }).rotate(); // honor EXIF orientation
    const targetMime = 'image/jpeg';
    const encoded = await pipeline
      .jpeg({ quality, mozjpeg: true, progressive: true })
      .toBuffer();

    // Se o re-encode ficou MAIOR ou IGUAL, não vale a troca (perdeu-se
    // qualidade sem ganhar espaço). Devolve o original.
    if (encoded.length >= buffer.length) {
      return { buffer, mime, original: null, changed: false, reason: 'no-gain' };
    }

    return {
      buffer: encoded,
      mime: targetMime,
      original: { mime, size: buffer.length, data: buffer },
      changed: true,
      reason: 'compressed',
      bytesSaved: buffer.length - encoded.length,
    };
  } catch (err) {
    // Formato corrompido, decoder falhou, OOM no sharp — seja qual for a
    // razão, o caller recebe o input intacto. Logamos pra investigar.
    return {
      buffer,
      mime,
      original: null,
      changed: false,
      reason: 'sharp-error',
      error: err?.message || String(err),
    };
  }
}

export const DESIGN_IMAGE_COMPRESSION = Object.freeze({
  thresholdBytes: COMPRESS_THRESHOLD_BYTES,
  jpegQuality: JPEG_QUALITY,
});