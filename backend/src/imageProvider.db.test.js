import assert from 'node:assert/strict';
import test from 'node:test';
import { nanoid } from 'nanoid';

const { db, now } = await import('./db.js');
const { encryptSecret } = await import('./crypto.js');
const { resolveImageProvider } = await import('./imageProvider.js');
const { getUserProvider } = await import('./userProvider.js');

// O banco é PostgreSQL: sem ele os testes se pulam (não falham). Ver TESTING.md.
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const CATALOGO_OPENROUTER = [
  { id: 'deepseek/deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'google/gemini-2.5-flash-image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] } }
];
const CATALOGO_DEEPSEEK = [{ id: 'deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }];
// `api_key_enc` é NOT NULL, então a linha órfã do mundo real não é uma chave
// vazia: é uma cifra que a ENCRYPTION_KEY atual não abre (chave mestra trocada,
// backup restaurado sem o arquivo de chave). `decryptSecret` devolve null nesse
// caso — do ponto de vista do app, provedor sem chave.
const CIFRA_ILEGIVEL = 'AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB==:Q0lGUkE=';

async function criarUsuario() {
  const id = `img-user-${nanoid(8)}`;
  const stamp = now();
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(id, 'Teste imagem', `${id}@t.com`, false, stamp, stamp);
  return id;
}

// `createdAt` explícito: a ordem de cadastro é o que define o provedor "mais
// antigo", e é justamente ela que o defeito original usava como critério.
async function criarProvedor(userId, { tipo, nome, baseURL, chave, models, criadoEm }) {
  const id = `prov-${nanoid(8)}`;
  const stamp = criadoEm || now();
  await db.prepare(`INSERT INTO user_ai_providers
    (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, tipo, nome, baseURL, chave === null ? CIFRA_ILEGIVEL : encryptSecret(chave),
      JSON.stringify(models), models[0]?.id || null, stamp, stamp);
  return id;
}

test('a imagem sai pela chave que gera imagem, mesmo quando ela não é a mais antiga', { skip }, async () => {
  const userId = await criarUsuario();
  await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK, criadoEm: '2026-01-01T00:00:00.000Z'
  });
  const orId = await criarProvedor(userId, {
    tipo: 'openrouter', nome: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
    chave: 'sk-or', models: CATALOGO_OPENROUTER, criadoEm: '2026-06-01T00:00:00.000Z'
  });

  const escolha = await resolveImageProvider(userId, `prov-desconhecido::x`);
  assert.equal(escolha.error, undefined);
  assert.equal(escolha.provider.id, orId);
  assert.equal(escolha.provider.apiKey, 'sk-or');
  assert.equal(escolha.model, 'google/gemini-2.5-flash-image');
});

test('conta só com provedor sem geração de imagem: o erro diz o que falta, não que falta chave', { skip }, async () => {
  const userId = await criarUsuario();
  await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK
  });
  const escolha = await resolveImageProvider(userId, '');
  assert.equal(escolha.code, 'IMAGE_SEM_PROVEDOR');
  assert.match(escolha.error, /DeepSeek/);
  assert.doesNotMatch(escolha.error, /Nenhuma chave de API configurada/);
});

test('conta sem chave nenhuma continua devolvendo NO_API_KEY', { skip }, async () => {
  const userId = await criarUsuario();
  const escolha = await resolveImageProvider(userId, '');
  assert.equal(escolha.code, 'NO_API_KEY');
});

// O sintoma relatado: chat respondendo normalmente e a geração de imagem
// acusando "nenhuma chave configurada". Uma linha de provedor sem chave
// utilizável na frente da fila derrubava a resolução por referência VAZIA.
test('provedor órfão (sem chave utilizável) não faz a conta inteira parecer sem chave', { skip }, async () => {
  const userId = await criarUsuario();
  await criarProvedor(userId, {
    tipo: 'custom', nome: 'Antigo', baseURL: 'https://exemplo.invalido/v1',
    chave: null, models: CATALOGO_DEEPSEEK, criadoEm: '2026-01-01T00:00:00.000Z'
  });
  const orId = await criarProvedor(userId, {
    tipo: 'openrouter', nome: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
    chave: 'sk-or', models: CATALOGO_OPENROUTER, criadoEm: '2026-06-01T00:00:00.000Z'
  });

  // Sem referência de modelo, o padrão passa a ser a primeira chave UTILIZÁVEL.
  const ativo = await getUserProvider(userId, '');
  assert.equal(ativo.hasKey, true);
  assert.equal(ativo.id, orId);

  const escolha = await resolveImageProvider(userId, '');
  assert.equal(escolha.error, undefined);
  assert.equal(escolha.provider.id, orId);
});
