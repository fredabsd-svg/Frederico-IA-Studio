// Modo gratuito decidido pelos MODELOS da execução (resolveFreeUsage) e
// fallback EXPLÍCITO para o modo gratuito (Regra 5.5).
//
// Antes: a rota decidia "é modo gratuito?" pelo provedor PADRÃO da conta; o
// runner resolvia pelo modelo pedido. Um usuário com chave própria que pedisse
// "free::X" caía na chave da plataforma sem passar pelos limites. E quando a
// chave de um provedor do usuário ficava ilegível, getUserProvider trocava
// para o modo gratuito sem deixar rastro nenhum da troca.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nanoid } from 'nanoid';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-free-usage-'));
process.env.DATA_DIR = dataDir;
process.env.FREE_TIER_API_KEY = 'chave-da-plataforma-teste';
process.env.FREE_TIER_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.FREE_TIER_MODELS = 'gratis-a:free,gratis-b:free';

const { db, now } = await import('./db.js');
const { encryptSecret } = await import('./crypto.js');
const { getUserProvider, resolveFreeUsage } = await import('./userProvider.js');

let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const CIFRA_ILEGIVEL = 'AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB==:Q0lGUkE=';
const criados = [];

async function usuario({ free = true } = {}) {
  const id = `free-usage-${nanoid(8)}`;
  criados.push(id);
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(id, id, `${id}@t.local`, false, now(), now());
  if (free) await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(id, 1, now(), now());
  return id;
}

async function provedor(userId, { chave = 'sk-propria', modelo = 'modelo-proprio' } = {}) {
  const id = `fu-prov-${nanoid(6)}`;
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, 'custom', 'Meu provedor', 'http://127.0.0.1:9/v1', chave === null ? CIFRA_ILEGIVEL : encryptSecret(chave),
      JSON.stringify([{ id: modelo }]), modelo, now(), now());
  return id;
}

test.after(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const id of criados) {
    for (const table of ['user_ai_providers', 'user_settings']) { try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id); } catch {} }
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

test('chave própria + modelo próprio: a execução NÃO é do modo gratuito', { skip }, async () => {
  const userId = await usuario();
  const prov = await provedor(userId);
  assert.equal(await resolveFreeUsage(userId, [`${prov}::modelo-proprio`]), null);
  assert.equal(await resolveFreeUsage(userId, ['']), null, 'sem modelo pedido, vale o provedor padrão (próprio)');
});

test('chave própria + "free::X": a execução É do modo gratuito (mesma resolução do runner)', { skip }, async () => {
  const userId = await usuario();
  const prov = await provedor(userId);
  // É exatamente o que o runner faz: getUserProvider com o modelo pedido.
  assert.equal((await getUserProvider(userId, 'free::gratis-b:free')).source, 'free');
  const free = await resolveFreeUsage(userId, ['free::gratis-b:free']);
  assert.equal(free?.source, 'free');
  assert.equal(free.model, 'gratis-b:free');
  // Basta UM membro gratuito num multimodelo.
  const mix = await resolveFreeUsage(userId, [`${prov}::modelo-proprio`, 'free::gratis-a:free']);
  assert.equal(mix?.source, 'free');
});

test('sem adesão ao modo gratuito, "free::X" não usa a chave da plataforma', { skip }, async () => {
  const userId = await usuario({ free: false });
  await provedor(userId);
  assert.equal(await resolveFreeUsage(userId, ['free::gratis-a:free']), null);
  assert.equal((await getUserProvider(userId, 'free::gratis-a:free')).hasKey, false);
});

test('FALLBACK EXPLÍCITO: provedor pedido sem chave legível cai no gratuito COM motivo rastreável', { skip }, async () => {
  const userId = await usuario();
  const prov = await provedor(userId, { chave: null });
  const p = await getUserProvider(userId, `${prov}::modelo-proprio`);
  assert.equal(p.source, 'free');
  assert.equal(p.fallback?.to, 'free');
  assert.equal(p.fallback.reason, 'provider_key_unavailable');
  assert.equal(p.fallback.requestedProviderId, prov);
  assert.match(p.fallback.message, /modo gratuito/);
  assert.doesNotMatch(JSON.stringify(p.fallback), /sk-|chave-da-plataforma/, 'o aviso não carrega segredo');
  // E a rota enxerga a troca como uso do modo gratuito (limites valem).
  assert.equal((await resolveFreeUsage(userId, [`${prov}::modelo-proprio`]))?.fallback?.reason, 'provider_key_unavailable');
});

test('provedor com chave legível nunca carrega marca de fallback', { skip }, async () => {
  const userId = await usuario();
  const prov = await provedor(userId);
  const p = await getUserProvider(userId, `${prov}::modelo-proprio`);
  assert.equal(p.source, 'user');
  assert.equal(p.fallback, undefined);
});
