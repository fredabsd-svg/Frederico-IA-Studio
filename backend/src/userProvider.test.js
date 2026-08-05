// F-1 (causa-raiz do 401 do PR #140): o assistente passa a guardar a
// referência COMPLETA do modelo (`<provedor>::<modelo>`) e `getUserProvider`
// devolve erro claro quando o modelo pedido não está em catálogo nenhum — em
// vez de cair silenciosamente no `rows[0]` da tabela `user_ai_providers` (o
// provedor mais antigo), que é o que produzia o 401 errado.
//
// O teste prova:
//   1) com dois provedores cadastrados, o assistente escolhe o provedor certo;
//   2) um modelo que não está em catálogo nenhum devolve erro com mensagem;
//   3) a migration 028 acrescenta `model_ref` à tabela `assistants`.
// Segue a convenção do repositório: roda contra PostgreSQL real e se auto-pula
// sem `DATABASE_URL`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nanoid } from 'nanoid';

const { db, now } = await import('./db.js');
const { encryptSecret } = await import('./crypto.js');
const { getUserProvider, resolveBareModelToRef } = await import('./userProvider.js');
const { DEFAULT_MODEL_REF, resolveDefaultModelRef } = await import('./defaults.js');
const { makeModelRef, parseModelRef } = await import('./modelRef.js');

let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const CIFRA_ILEGIVEL = 'AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB==:Q0lGUkE=';
const CATALOGO_OPENROUTER = [
  { id: 'deepseek/deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'google/gemini-2.5-flash-image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] } }
];
const CATALOGO_DEEPSEEK = [
  { id: 'deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }
];

async function criarUsuario() {
  const id = `modelref-u-${nanoid(8)}`;
  const stamp = now();
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(id, 'Teste modelRef', `${id}@t.com`, false, stamp, stamp);
  return id;
}

async function criarProvedor(userId, { tipo, nome, baseURL, chave, models, criadoEm }) {
  const id = `modelref-prov-${nanoid(6)}`;
  const stamp = criadoEm || now();
  await db.prepare(`INSERT INTO user_ai_providers
    (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, tipo, nome, baseURL, chave === null ? CIFRA_ILEGIVEL : encryptSecret(chave),
      JSON.stringify(models), models[0]?.id || null, stamp, stamp);
  return id;
}

async function criarAssistente(userId, { model, modelRef = null }) {
  const id = `modelref-a-${nanoid(6)}`;
  const stamp = now();
  await db.prepare(`INSERT INTO assistants
    (id,user_id,name,emoji,model,model_ref,system_prompt,tools,personality,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, 'Teste', 'bot', model, modelRef, '', '[]', '{}', stamp, stamp);
  return id;
}

test('DEFAULT_MODEL_REF é a forma OpenRouter canonical e tem o prefixo esperado', () => {
  assert.equal(DEFAULT_MODEL_REF, 'deepseek/deepseek-chat');
  // Não tem `::` porque é o id do MODELO (formato OpenRouter), não a
  // modelRef interna (que ganha `::` no momento da gravação).
  assert.equal(parseModelRef(DEFAULT_MODEL_REF).providerId, null);
  assert.equal(parseModelRef(DEFAULT_MODEL_REF).modelId, 'deepseek/deepseek-chat');
  // env vazio → usa o default canônico
  const prev = process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_MODEL;
  try { assert.equal(resolveDefaultModelRef(), DEFAULT_MODEL_REF); }
  finally { if (prev !== undefined) process.env.DEEPSEEK_MODEL = prev; }
});

test('resolveBareModelToRef: modelo em 1 provedor vira modelRef', { skip }, async () => {
  const userId = await criarUsuario();
  const dsId = await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK
  });
  const ref = await resolveBareModelToRef(userId, 'deepseek-chat');
  assert.equal(ref, makeModelRef(dsId, 'deepseek-chat'));
});

test('resolveBareModelToRef: modelo em 2 provedores escolhe o que tem chave utilizável', { skip }, async () => {
  const userId = await criarUsuario();
  // Provedor órfão (sem chave utilizável) cadastrado ANTES do válido — o
  // `rows[0]` original usaria este. A nova heurística pula.
  await criarProvedor(userId, {
    tipo: 'custom', nome: 'Antigo', baseURL: 'https://exemplo.invalido/v1',
    chave: null, models: CATALOGO_DEEPSEEK, criadoEm: '2026-01-01T00:00:00.000Z'
  });
  const dsId = await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK, criadoEm: '2026-06-01T00:00:00.000Z'
  });
  const ref = await resolveBareModelToRef(userId, 'deepseek-chat');
  assert.equal(ref, makeModelRef(dsId, 'deepseek-chat'));
});

test('resolveBareModelToRef: modelo ausente em qualquer catálogo devolve null', { skip }, async () => {
  const userId = await criarUsuario();
  await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK
  });
  const ref = await resolveBareModelToRef(userId, 'modelo-que-nao-existe');
  assert.equal(ref, null);
});

// O cenário central da frente 1: dois provedores cadastrados, um assistente
// com id de modelo NU (sem `::`). Antes da fix, o `getUserProvider` caía no
// `rows[0]` (o provedor mais antigo) e o chat falhava com a chave do provedor
// errado. Agora cada id resolve inequivocamente para o provedor que o tem em
// catálogo.
test('getUserProvider: dois provedores, id de modelo NU escolhe o provedor certo', { skip }, async () => {
  const userId = await criarUsuario();
  const dsId = await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK, criadoEm: '2026-01-01T00:00:00.000Z'
  });
  const orId = await criarProvedor(userId, {
    tipo: 'openrouter', nome: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
    chave: 'sk-or', models: CATALOGO_OPENROUTER, criadoEm: '2026-06-01T00:00:00.000Z'
  });

  // id no formato nativo → provedor DeepSeek
  const provedorDs = await getUserProvider(userId, 'deepseek-chat');
  assert.equal(provedorDs.hasKey, true);
  assert.equal(provedorDs.id, dsId);
  assert.equal(provedorDs.model, 'deepseek-chat');

  // id no formato OpenRouter → provedor OpenRouter
  const provedorOr = await getUserProvider(userId, 'deepseek/deepseek-chat');
  assert.equal(provedorOr.hasKey, true);
  assert.equal(provedorOr.id, orId);
  assert.equal(provedorOr.model, 'deepseek/deepseek-chat');
});

// O `modelRef` completo (<provedor>::<modelo>) sempre tem prioridade: nem
// passa pela busca em catálogo. Aqui o id é genuinamente ambíguo (DeepSeek
// e OpenRouter podem servir "deepseek/deepseek-chat" pelo nome do catálogo),
// mas o `::` aponta o provedor certo.
test('getUserProvider: modelRef completo escolhe o provedor indicado pelo prefixo', { skip }, async () => {
  const userId = await criarUsuario();
  const dsId = await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK, criadoEm: '2026-01-01T00:00:00.000Z'
  });
  await criarProvedor(userId, {
    tipo: 'openrouter', nome: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
    chave: 'sk-or', models: CATALOGO_OPENROUTER, criadoEm: '2026-06-01T00:00:00.000Z'
  });

  const provedor = await getUserProvider(userId, makeModelRef(dsId, 'deepseek-chat'));
  assert.equal(provedor.hasKey, true);
  assert.equal(provedor.id, dsId);
});

// A causa-raiz do 401 do PR #140: o usuário pediu um modelo específico que
// não está no catálogo de NENHUM provedor cadastrado. Antes da fix, o sistema
// caía silenciosamente no provedor mais antigo da conta e a chamada falhava
// com a chave errada (o "401 do provedor errado"). Agora a falha tem uma
// mensagem que diz o que aconteceu.
test('getUserProvider: modelo sem catálogo devolve erro claro em vez de cair no rows[0]', { skip }, async () => {
  const userId = await criarUsuario();
  // Provedor mais antigo: é o que seria escolhido pelo `rows[0]` legado. A
  // correção é justamente recusar este caminho quando o usuário pediu um
  // modelo específico.
  const primeiro = await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK, criadoEm: '2026-01-01T00:00:00.000Z'
  });
  await criarProvedor(userId, {
    tipo: 'openrouter', nome: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
    chave: 'sk-or', models: CATALOGO_OPENROUTER, criadoEm: '2026-06-01T00:00:00.000Z'
  });

  const provedor = await getUserProvider(userId, 'modelo-que-nao-existe-em-catalogo');
  assert.equal(provedor.hasKey, false);
  assert.equal(provedor.id, null);
  assert.match(provedor.attributionError, /modelo-que-nao-existe-em-catalogo/);
  assert.match(provedor.attributionError, /nenhum dos seus provedores/);
  // Garantia explícita: o provedor errado (o que teria sido escolhido pelo
  // rows[0] legado) NÃO foi devolvido.
  assert.notEqual(provedor.id, primeiro);
});

// A migration 028 não quebra uma linha de assistente existente: a coluna
// nova é NULLABLE, e o `loadAssistant` continua devolvendo o registro inteiro
// (com `model_ref=NULL` para linhas pré-migration).
test('assistants.model_ref existe e aceita NULL (compatibilidade com linhas pré-migration)', { skip }, async () => {
  const userId = await criarUsuario();
  const assistenteId = await criarAssistente(userId, { model: 'deepseek/deepseek-chat', modelRef: null });
  const row = await db.prepare('SELECT id, model, model_ref FROM assistants WHERE id=? AND user_id=?').get(assistenteId, userId);
  assert.ok(row, 'assistente deveria ter sido recuperado');
  assert.equal(row.model, 'deepseek/deepseek-chat');
  assert.equal(row.model_ref, null);
});

// Quando o assistente tem `model_ref` gravado, o `getUserProvider` recebe a
// referência completa e resolve direto para o provedor certo — sem depender
// do catálogo, sem ambiguidade, sem `rows[0]`. É o caminho "feliz" da
// correção e o que o seed/route gravam depois desta migration.
test('getUserProvider: a partir de um modelRef gravado, resolve o provedor certo', { skip }, async () => {
  const userId = await criarUsuario();
  const orId = await criarProvedor(userId, {
    tipo: 'openrouter', nome: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
    chave: 'sk-or', models: CATALOGO_OPENROUTER, criadoEm: '2026-01-01T00:00:00.000Z'
  });
  await criarProvedor(userId, {
    tipo: 'deepseek', nome: 'DeepSeek', baseURL: 'https://api.deepseek.com',
    chave: 'sk-ds', models: CATALOGO_DEEPSEEK, criadoEm: '2026-06-01T00:00:00.000Z'
  });
  await criarAssistente(userId, {
    model: 'deepseek/deepseek-chat',
    modelRef: makeModelRef(orId, 'deepseek/deepseek-chat')
  });

  const provedor = await getUserProvider(userId, makeModelRef(orId, 'deepseek/deepseek-chat'));
  assert.equal(provedor.id, orId);
  assert.equal(provedor.model, 'deepseek/deepseek-chat');
});
