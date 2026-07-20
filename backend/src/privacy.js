// LGPD — direitos do titular e ciclo de vida dos dados.
//
// Reúne, num só lugar, tudo o que o app oferece para o usuário exercer os
// direitos da Lei 13.709/2018 (LGPD):
//   * registro de consentimento aos Termos/Política (art. 8º — com evidência);
//   * exportação de todos os dados (art. 18, V — portabilidade);
//   * exclusão de todo o histórico de conversas (art. 18, VI);
//   * exclusão TOTAL da conta — hard delete, sem "soft delete" (art. 18, VI);
//   * retenção automática: apaga conversas paradas há mais de N dias
//     (minimização — art. 6º, III; desligada por padrão).
//
// As rotas ficam em server.js; aqui vive só a lógica, para ser testável.
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { destroyConversation } from './sandbox.js';
import { isConversationActive } from './agent.js';

// Versão vigente dos Termos de Uso + Política de Privacidade. Ao alterar os
// documentos de forma relevante, mude esta data: todos os usuários verão o
// pedido de aceite novamente no próximo acesso (o frontend usa o mesmo valor
// exposto em /api/consent).
export const TERMS_VERSION = '2026-07-20';

// ---- Consentimento ----

// Último aceite registrado do usuário (ou undefined).
export async function getLatestConsent(userId) {
  return db.prepare('SELECT version, accepted_at FROM user_consents WHERE user_id=? ORDER BY accepted_at DESC LIMIT 1').get(userId);
}

// Registra um aceite da versão vigente, com IP e navegador como evidência.
export async function recordConsent(userId, { ip = null, userAgent = null } = {}) {
  await db.prepare('INSERT INTO user_consents (id,user_id,version,ip,user_agent,accepted_at) VALUES (?,?,?,?,?,?)')
    .run(nanoid(), userId, TERMS_VERSION, ip ? String(ip).slice(0, 100) : null, userAgent ? String(userAgent).slice(0, 300) : null, now());
}

// ---- Exclusão profunda de uma conversa (hard delete) ----
// Apaga a conversa E tudo o que derivou dela: mensagens e arquivos (cascade),
// trechos indexados, memórias extraídas automaticamente, tarefas associadas e
// o workspace em disco (container + uploads + outputs).
export async function deleteConversationDeep(userId, conversationId) {
  await db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(conversationId, userId); // cascade: messages + files
  await db.prepare('DELETE FROM conversation_chunks WHERE conversation_id=? AND user_id=?').run(conversationId, userId);
  await db.prepare("DELETE FROM memory WHERE source_type='auto' AND source_id=? AND user_id=?").run(conversationId, userId);
  // Sem isto, uma tarefa na fila recriaria a conversa apagada ao ser executada.
  await db.prepare("DELETE FROM tasks WHERE conversation_id=? AND user_id=? AND status<>'running'").run(conversationId, userId);
  await destroyConversation(conversationId); // remove container e pasta do workspace
}

// ---- Apagar todo o histórico de conversas do usuário ----
// Retorna { deleted, skipped }: conversas que ainda estão respondendo são
// puladas (o usuário precisa parar o processamento antes).
export async function deleteAllConversations(userId) {
  const convs = await db.prepare('SELECT id FROM conversations WHERE user_id=?').all(userId);
  let deleted = 0, skipped = 0;
  for (const { id } of convs) {
    if (isConversationActive(id)) { skipped++; continue; }
    await deleteConversationDeep(userId, id);
    deleted++;
  }
  return { deleted, skipped };
}

// ---- Exportação de dados (portabilidade) ----
// Devolve TUDO o que o app guarda sobre o usuário num objeto serializável em
// JSON — exceto segredos (chave de API e tokens ficam de fora: são credenciais
// do próprio usuário em outros serviços, não dados a portar) e embeddings
// (derivados binários do próprio conteúdo já incluído).
export async function exportUserData(userId, user = {}) {
  const conversations = await db.prepare('SELECT id, title, model, client_id, created_at, updated_at, summary_short, summary_long, tags FROM conversations WHERE user_id=? ORDER BY created_at ASC').all(userId);
  for (const conv of conversations) {
    conv.messages = await db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC, seq ASC').all(conv.id);
    conv.files = await db.prepare('SELECT kind, name, size, created_at FROM files WHERE conversation_id=? ORDER BY created_at ASC').all(conv.id);
  }
  const settings = await db.prepare('SELECT base_url, model, prefs, created_at, updated_at FROM user_settings WHERE user_id=?').get(userId);
  return {
    formato: 'frederico-ia-studio/export-v1',
    exportado_em: now(),
    conta: {
      id: userId,
      nome: user.name || null,
      email: user.email || null,
      criada_em: user.createdAt || null,
    },
    consentimentos: await db.prepare('SELECT version, accepted_at FROM user_consents WHERE user_id=? ORDER BY accepted_at ASC').all(userId),
    configuracoes: settings ? { ...settings, prefs: safeJson(settings.prefs) } : null,
    conectores: await db.prepare('SELECT provider, account_login, account_name, created_at FROM user_connectors WHERE user_id=?').all(userId),
    clientes: await db.prepare('SELECT id, name, created_at FROM clients WHERE user_id=? ORDER BY created_at ASC').all(userId),
    assistentes: await db.prepare('SELECT name, emoji, model, system_prompt, tools, personality, created_at FROM assistants WHERE user_id=? ORDER BY created_at ASC').all(userId),
    templates: await db.prepare('SELECT name, content, created_at FROM templates WHERE user_id=? ORDER BY created_at ASC').all(userId),
    memorias: await db.prepare('SELECT scope, content, type, importance, pinned, tags, created_at FROM memory WHERE user_id=? ORDER BY created_at ASC').all(userId),
    rotinas: await db.prepare('SELECT title, prompt, cadence, day, hour, enabled, created_at FROM schedules WHERE user_id=? ORDER BY created_at ASC').all(userId),
    uso: await db.prepare('SELECT model, kind, prompt_tokens, completion_tokens, total_tokens, created_at FROM usage WHERE user_id=? ORDER BY created_at ASC').all(userId),
    conversas: conversations,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return s ?? null; } }

// ---- Exclusão TOTAL da conta (hard delete) ----
// Remove primeiro o que vive FORA do banco (workspaces em disco, containers,
// caixa de entrada) e por fim a linha em "user" — as FKs ON DELETE CASCADE
// levam junto sessões, contas OAuth, conversas, mensagens, arquivos, memórias,
// chaves criptografadas, conectores, consentimentos e contadores de uso.
// Nada fica marcado como "inativo": os dados deixam de existir.
export async function deleteAccount(userId) {
  const convs = await db.prepare('SELECT id FROM conversations WHERE user_id=?').all(userId);
  const active = convs.filter(({ id }) => isConversationActive(id));
  if (active.length) {
    return { ok: false, error: 'Há uma conversa ainda processando uma resposta. Pare o processamento e tente de novo.' };
  }
  for (const { id } of convs) {
    try { await destroyConversation(id); } catch {}
  }
  // Caixa de entrada em disco (data/inbox/<userId>/...)
  try {
    const inboxRoot = path.join(path.resolve(process.env.DATA_DIR || './data'), 'inbox');
    const uKey = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (uKey) fs.rmSync(path.join(inboxRoot, uKey), { recursive: true, force: true });
  } catch {}
  await db.prepare('DELETE FROM "user" WHERE id=?').run(userId);
  return { ok: true };
}

// ---- Retenção automática (minimização) ----
// Com CONVERSATION_RETENTION_DAYS > 0, conversas sem atividade há mais de N
// dias são apagadas em profundidade. Desligado por padrão: apagar histórico do
// usuário é decisão do operador — ligue num site público e AVISE na Política
// de Privacidade (a página /privacidade já descreve a regra quando ativa).
export const CONVERSATION_RETENTION_DAYS = Math.max(0, Number(process.env.CONVERSATION_RETENTION_DAYS || 0));

export async function sweepOldConversations() {
  if (!CONVERSATION_RETENTION_DAYS) return { deleted: 0 };
  const cutoff = new Date(Date.now() - CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const old = await db.prepare('SELECT id, user_id FROM conversations WHERE updated_at < ?').all(cutoff);
  let deleted = 0;
  for (const conv of old) {
    if (isConversationActive(conv.id)) continue;
    try { await deleteConversationDeep(conv.user_id, conv.id); deleted++; } catch (e) {
      console.error('[retenção] falha ao apagar conversa antiga:', e.message);
    }
  }
  if (deleted) console.log(`[retenção] ${deleted} conversa(s) com mais de ${CONVERSATION_RETENTION_DAYS} dias removida(s).`);
  return { deleted };
}
