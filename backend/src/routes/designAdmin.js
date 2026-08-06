// Rotas admin para o Modo Design: métricas de uso de imagens e purge dos
// originais preservados pela compressão automática (Frente 13).
//
// Por que duas rotas: o painel admin precisa ver o quanto a compressão está
// economizando (bytes salvos ÷ bytes totais) e o purge de blob precisa rodar
// de vez em quando para liberar o BYTEA original após o prazo de auditoria
// (30 dias). Sem cron nativo no app, o purge é exposto como endpoint que o
// agendador externo (ou um admin clicando) chama.

import { db, now } from '../db.js';
import { makeRouter, requireAdmin, recordAdminAction } from './helpers.js';

const router = makeRouter();

// Dias que o BYTEA original fica preservado após a compressão. Defina
// DESIGN_IMAGE_ORIGINAL_TTL_DAYS no ambiente se precisar mudar (testes de
// integração usam valor menor).
const DEFAULT_TTL_DAYS = Number(process.env.DESIGN_IMAGE_ORIGINAL_TTL_DAYS || 30);

// Métricas agregadas de uso de imagens do Design.
//
// Devolve contagens e bytes — sem o BYTEA em si, só somas. A coluna
// `original_size` é confiável mesmo quando `original_data` já foi purgada
// (o purge zera o blob mas mantém o número, para que a métrica histórica
// não caia). Ver 030_design_image_compression.sql.
router.get('/admin/design/image-stats', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  // Cada agregação é independente — não dá pra fazer tudo num único SELECT
  // sem subquery correlacionada, e a complexidade não compensa aqui (a
  // tabela costuma ter milhares de linhas, não milhões).
  const total = await db.prepare(
    'SELECT COUNT(*)::int AS images, COALESCE(SUM(byte_size),0)::bigint AS bytes FROM design_images'
  ).get();

  const compressed = await db.prepare(
    `SELECT COUNT(*)::int AS images,
            COALESCE(SUM(byte_size),0)::bigint AS compressed_bytes,
            COALESCE(SUM(original_size),0)::bigint AS original_bytes
       FROM design_images
      WHERE original_data IS NOT NULL OR compressed_at IS NOT NULL`
  ).get();

  const kept = await db.prepare(
    `SELECT COUNT(*)::int AS images,
            COALESCE(SUM(original_size),0)::bigint AS original_bytes,
            COALESCE(SUM(byte_size),0)::bigint AS compressed_bytes
       FROM design_images
      WHERE original_data IS NOT NULL`
  ).get();

  const totalImages = Number(total?.images || 0);
  const totalBytes = Number(total?.bytes || 0);
  const compressedImages = Number(compressed?.images || 0);
  const originalBytes = Number(compressed?.original_bytes || 0);
  const compressedBytes = Number(compressed?.compressed_bytes || 0);
  const keptImages = Number(kept?.images || 0);
  const savedBytes = Math.max(0, originalBytes - compressedBytes);

  res.json({
    totalImages,
    totalBytes,
    compressedImages,
    keptOriginalImages: keptImages,
    originalBytes,
    compressedBytes,
    savedBytes,
    // Porcentagem com 1 casa: arredondar 67.4% vs 67% pouparia "parece que
    // não comprime quase nada" no painel quando o usuário olha de relance.
    savingsRatio: originalBytes > 0 ? Number((savedBytes / originalBytes).toFixed(3)) : 0,
    ttlDays: DEFAULT_TTL_DAYS,
  });
});

// Purga o BYTEA original das imagens cujo `compressed_at` é mais antigo que
// o TTL. Mantém `original_mime` e `original_size` por valor histórico (a
// métrica de "saved bytes" continua precisa). Idempotente: rodar de novo
// não faz nada se não houver linhas aptas.
//
// Retorna quantas linhas foram purgadas. O caller (job ou admin) usa esse
// número para decidir se loga ou se ignora.
router.post('/admin/design/purge-stale-image-originals', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  // Aceita `?days=N` para testes/integridade. Default = DEFAULT_TTL_DAYS.
  // Sanitiza: NaN/negativo cai pro default (não confiamos no caller).
  const days = Number(req.query.days);
  const ttl = Number.isFinite(days) && days >= 0 ? days : DEFAULT_TTL_DAYS;

  const cutoff = new Date(Date.now() - ttl * 24 * 60 * 60 * 1000).toISOString();
  const r = await db.prepare(
    `UPDATE design_images
        SET original_data = NULL
      WHERE original_data IS NOT NULL
        AND compressed_at IS NOT NULL
        AND compressed_at < ?`
  ).run(cutoff);

  await recordAdminAction(req, 'admin.design.image-originals.purged', {
    cutoff,
    ttlDays: ttl,
    purged: r.changes,
  });

  res.json({ ok: true, purged: r.changes, cutoff, ttlDays: ttl });
});

export default router;
