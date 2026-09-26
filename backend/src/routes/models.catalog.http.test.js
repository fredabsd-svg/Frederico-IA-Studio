// Catálogo de modelos por HTTP de verdade (Express + PostgreSQL reais; a API
// do provedor é um `fetch` falso só para o host de teste).
//
//  19) GET /api/models listava os modelos de um provedor cuja chave não pode
//      ser decifrada — escolher um deles mandava a mensagem para outro
//      provedor/modo gratuito ou falhava. Agora o provedor sai da lista e vem
//      em `unavailableProviders` para a interface explicar.
//  20) GET /api/models (catálogo vencido) e POST /api/providers/:id/refresh
//      gravavam o catálogo CRU da API, fora do caminho único do catalogSync:
//      um GET /models incompleto apagava preço/contexto já conhecidos e nada
//      entrava no histórico. Agora os dois passam por mergePreserving + histórico.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-models-cat-'));
process.env.DATA_DIR = dataDir;
delete process.env.FREE_TIER_API_KEY;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const modelsRouter = (await import('./models.js')).default;
const providerRouter = (await import('./provider.js')).default;
const { encryptSecret } = await import('../crypto.js');

// Host público de documentação (TEST-NET-3), IP literal: passa pela guarda de
// SSRF sem DNS. Só as chamadas para ele são interceptadas.
const PROVIDER_BASE = 'https://203.0.113.10/v1';
let apiModels = [];
let apiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith(PROVIDER_BASE)) {
    apiCalls += 1;
    return { ok: true, status: 200, json: async () => ({ data: apiModels }) };
  }
  return realFetch(url, options);
};

const stamp = Date.now();
const USER = `cat-user-${stamp}`;
const PROV_OK = `catok${stamp}`;
const PROV_SEM_CHAVE = `catsem${stamp}`;
const CIFRA_ILEGIVEL = 'AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB==:Q0lGUkE=';
const VELHO = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

const CATALOGO_SALVO = [
  { id: 'modelo-a', name: 'Modelo A', context_length: 128000, pricing: { prompt: 0.000001, completion: 0.000002 } }
];

let server, baseUrl;
if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,last_validated_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV_OK, USER, 'custom', 'Provedor OK', PROVIDER_BASE, encryptSecret('sk-teste'), JSON.stringify(CATALOGO_SALVO), 'modelo-a', VELHO, now(), now());
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,last_validated_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV_SEM_CHAVE, USER, 'custom', 'Provedor sem chave', PROVIDER_BASE, CIFRA_ILEGIVEL, JSON.stringify([{ id: 'modelo-fantasma' }]), 'modelo-fantasma', now(), now(), now());
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = USER; req.user = { id: USER }; next(); });
  app.use('/api', modelsRouter);
  app.use('/api', providerRouter);
  app.use((err, _req, res, _next) => { res.status(500).json({ error: 'Erro interno do servidor.' }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  globalThis.fetch = realFetch;
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  await db.prepare('DELETE FROM model_catalog_history WHERE user_id=?').run(USER).catch(() => {});
  await db.prepare('DELETE FROM user_ai_providers WHERE user_id=?').run(USER).catch(() => {});
  await db.prepare('DELETE FROM "user" WHERE id=?').run(USER).catch(() => {});
});

async function savedCatalog(id) {
  const row = await db.prepare('SELECT models FROM user_ai_providers WHERE id=?').get(id);
  return JSON.parse(row.models);
}

test('provedor com chave ilegível NÃO oferece modelos e aparece como indisponível', { skip: needsDb }, async () => {
  apiModels = [{ id: 'modelo-a' }];
  const res = await realFetch(`${baseUrl}/api/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(!body.models.some(m => m.providerId === PROV_SEM_CHAVE), 'nenhum modelo do provedor sem chave');
  assert.ok(!body.models.some(m => String(m.id).includes('modelo-fantasma')));
  assert.deepEqual(body.unavailableProviders, [{ id: PROV_SEM_CHAVE, name: 'Provedor sem chave', providerType: 'custom', reason: 'key_unavailable' }]);
  assert.ok(body.models.some(m => m.providerId === PROV_OK), 'o provedor válido continua listado');
});

test('catálogo vencido lido em /api/models passa pela mescla: preço/contexto preservados e histórico gravado', { skip: needsDb }, async () => {
  // Estado vencido de novo, e uma API que devolve o modelo SEM preço/contexto + um modelo novo.
  await db.prepare('UPDATE user_ai_providers SET models=?, last_validated_at=? WHERE id=?').run(JSON.stringify(CATALOGO_SALVO), VELHO, PROV_OK);
  await db.prepare('DELETE FROM model_catalog_history WHERE user_id=?').run(USER);
  apiModels = [{ id: 'modelo-a' }, { id: 'modelo-novo' }];
  const antes = apiCalls;
  const res = await realFetch(`${baseUrl}/api/models`);
  assert.equal(res.status, 200);
  assert.equal(apiCalls, antes + 1, 'o catálogo vencido foi atualizado na API');
  const salvo = await savedCatalog(PROV_OK);
  const a = salvo.find(m => m.id === 'modelo-a');
  assert.equal(a.context_length, 128000, 'contexto conhecido não foi apagado pela resposta incompleta');
  assert.equal(a.pricing.prompt, 0.000001, 'preço conhecido não foi apagado');
  assert.ok(salvo.some(m => m.id === 'modelo-novo'));
  const hist = await db.prepare("SELECT model_id, change_type FROM model_catalog_history WHERE user_id=? AND provider_id=?").all(USER, PROV_OK);
  assert.ok(hist.some(h => h.model_id === 'modelo-novo' && h.change_type === 'added'), 'a novidade entrou no histórico');
});

test('"atualizar" do cartão do provedor também preserva dado bom e registra histórico', { skip: needsDb }, async () => {
  await db.prepare('UPDATE user_ai_providers SET models=? WHERE id=?').run(JSON.stringify(CATALOGO_SALVO), PROV_OK);
  await db.prepare('DELETE FROM model_catalog_history WHERE user_id=?').run(USER);
  apiModels = [{ id: 'modelo-a' }, { id: 'modelo-outro' }];
  const res = await realFetch(`${baseUrl}/api/providers/${PROV_OK}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).imported, 2);
  const salvo = await savedCatalog(PROV_OK);
  const a = salvo.find(m => m.id === 'modelo-a');
  assert.equal(a.pricing.completion, 0.000002);
  assert.equal(a.context_length, 128000);
  const hist = await db.prepare("SELECT model_id, change_type FROM model_catalog_history WHERE user_id=? AND provider_id=?").all(USER, PROV_OK);
  assert.ok(hist.some(h => h.model_id === 'modelo-outro' && h.change_type === 'added'));
  const row = await db.prepare('SELECT last_sync_status, default_model FROM user_ai_providers WHERE id=?').get(PROV_OK);
  assert.equal(row.last_sync_status, 'ok');
  assert.equal(row.default_model, 'modelo-a');
});

test('provedor de OUTRO usuário não é atualizado (404)', { skip: needsDb }, async () => {
  const res = await realFetch(`${baseUrl}/api/providers/nao-e-meu-${stamp}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 404);
});
