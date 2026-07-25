// Teste de CONTINUIDADE entre chats do mesmo projeto.
//
// Reproduz o fluxo que estava quebrado, exatamente como o usuário descreveu:
//   1. começar uma tarefa num chat e registrar decisões;
//   2. abrir um chat NOVO dentro do mesmo projeto;
//   3. pedir a continuidade;
//   4. conferir que as últimas conversas e decisões voltaram;
//   5. conferir que memórias irrelevantes (contabilidade genérica, COBOL,
//      planilhas) NÃO entraram.
//
// Requer PostgreSQL (DATABASE_URL). Sem banco, o teste é pulado — igual aos
// outros testes de integração do projeto.
import test from 'node:test';
import assert from 'node:assert/strict';

// Sonda a conexão de verdade em vez de olhar só a variável: o CI aponta
// DATABASE_URL para um Postgres inalcançável de propósito, justamente para
// conferir que a suíte degrada com `skip` em vez de falhar.
let hasDb = false;
try {
  const { db: probe } = await import('../db.js');
  await probe.prepare('SELECT 1 AS ok').get();
  hasDb = true;
} catch { hasDb = false; }
const maybe = (name, fn) => test(name, { skip: hasDb ? false : 'requer PostgreSQL (DATABASE_URL)' }, fn);

let db, now, runMigrations, buildContext, upsertProject, linkConversationToProject, adoptConversations, addMemory, setSettings, loadSettings;

if (hasDb) {
  ({ db, now } = await import('../db.js'));
  ({ runMigrations } = await import('../migrate.js'));
  ({ buildContext } = await import('./contextBuilder.js'));
  ({ upsertProject, linkConversationToProject, adoptConversations } = await import('./projectStore.js'));
  ({ addMemory, setSettings, loadSettings } = await import('./memoryService.js'));
  await runMigrations();
  await loadSettings();
  // review_auto_memory desligado para os fatos virarem memória direto no teste.
  await setSettings({ memory_enabled: 1, economy_mode: 0, review_auto_memory: 0 });
}

const USER = 'u_continuidade_test';
const PROJECT_ID = 'p_spedhub_test';

async function reset() {
  for (const t of ['conversation_chunks', 'memory', 'memory_suggestions', 'messages', 'conversations', 'dev_projects']) {
    await db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(USER).catch(() => {});
  }
  await db.prepare('DELETE FROM messages WHERE conversation_id LIKE ?').run('c_test_%').catch(() => {});
  await db.prepare('DELETE FROM "user" WHERE id=?').run(USER).catch(() => {});
  await db.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?,?,?,?,now(),now()) ON CONFLICT (id) DO NOTHING')
    .run(USER, 'Teste', `${USER}@example.com`, false);
}

async function makeConversation(id, title, { summary, projectId = null, daysAgo = 0 }) {
  const t = new Date(Date.now() - daysAgo * 86400000).toISOString();
  await db.prepare(`INSERT INTO conversations (id, user_id, title, model, created_at, updated_at, summary_short, summary_long, project_id)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, USER, title, 'gpt-4o', t, t, summary.slice(0, 300), summary, projectId);
  return id;
}

async function makeChunk(id, conversationId, title, content, { projectId = null, daysAgo = 0 } = {}) {
  const t = new Date(Date.now() - daysAgo * 86400000).toISOString();
  await db.prepare(`INSERT INTO conversation_chunks (id, user_id, conversation_id, project_id, source_title, scope, content, token_count, created_at)
                    VALUES (?,?,?,?,?,'global',?,?,?)`)
    .run(id, USER, conversationId, projectId, title, content, 100, t);
}

// ─── Cenário compartilhado ────────────────────────────────────────────────
const DECISOES = `Decidimos usar FastAPI + Jinja2 no SPED-HUB. Implementamos o parser de ECD e a
geração do balanço em PDF com WeasyPrint. Corrigimos o bug de encoding no bloco I250.
Pendências: período anterior no Balanço/DRE (comparativo) e fontes customizadas no WeasyPrint.
Próxima etapa: Fase 3 — Dashboard Web com upload, KPIs e gráficos.`;

const RUIDO = [
  'O usuário se chama Frederico.',
  'Frederico trabalha na área de contabilidade e administração de empresas.',
  'Programas essenciais incluem Domínio Sistemas, SPED, Conectividade Social/SEFIP e ferramentas de office.',
  'O usuário precisa de orientação sobre como responder a pedidos de redução de aviso prévio.',
  'O usuário solicitou que os cálculos fossem baseados em 30 dias, não 31.',
  'O usuário precisa de análises financeiras detalhadas, com foco em balanço patrimonial e DRE.',
];

async function seedScenario() {
  await reset();
  await upsertProject(USER, {
    id: PROJECT_ID,
    name: 'SPED-HUB',
    description: 'Plataforma de leitura de arquivos SPED com dashboard web.',
    techs: 'Python, FastAPI, Jinja2, HTMX, Alpine.js, WeasyPrint',
    rules: 'Sempre rodar os testes antes de entregar.',
    memory: {
      arquitetura: 'FastAPI + Jinja2 no backend; HTMX/Alpine.js no frontend.',
      decisoes: 'PDF gerado com WeasyPrint. Parser de ECD próprio.',
      corrigidos: 'Bug de encoding no bloco I250 do ECD.',
      proximos: 'Fase 3 — dashboard web com upload, KPIs e gráficos.',
    },
  });

  // Chat 1 do projeto (ontem): onde as decisões foram registradas.
  const c1 = await makeConversation('c_test_fase2', 'SPED-HUB Fase 2 — parser ECD e PDF', {
    summary: DECISOES, projectId: PROJECT_ID, daysAgo: 1,
  });
  await makeChunk('ch_test_fase2', c1, 'SPED-HUB Fase 2 — parser ECD e PDF', DECISOES, { projectId: PROJECT_ID, daysAgo: 1 });

  // Conversas ANTIGAS e sem relação — o ruído que vinha no lugar do que importa.
  const c2 = await makeConversation('c_test_cobol', 'Aprender programação em COBOL', {
    summary: 'Estudo de COBOL para sistemas legados bancários: divisões IDENTIFICATION, DATA, PROCEDURE.', daysAgo: 30,
  });
  await makeChunk('ch_test_cobol', c2, 'Aprender programação em COBOL',
    'Quero aprender COBOL para manutenção de sistemas legados bancários. Divisões IDENTIFICATION, DATA e PROCEDURE.', { daysAgo: 30 });

  const c3 = await makeConversation('c_test_aviso', 'Redução de aviso prévio', {
    summary: 'Cálculo de aviso prévio proporcional e rescisão pela CLT, base 30 dias.', daysAgo: 45,
  });
  await makeChunk('ch_test_aviso', c3, 'Redução de aviso prévio',
    'Cálculo de aviso prévio proporcional, rescisão, CLT, FGTS e homologação. Base de 30 dias.', { daysAgo: 45 });

  // Memórias genéricas de perfil/preferência (as 42 do print vinham daqui).
  for (const content of RUIDO) {
    await addMemory(USER, { content, type: 'preferencia', scope: 'global', importance: 3 });
  }
  return c1;
}

// O chat NOVO: conversa vazia, já vinculada ao projeto (é o que o app faz agora).
async function newChatInProject(id = 'c_test_novo') {
  const t = now();
  await db.prepare('INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, USER, 'Nova conversa', 'gpt-4o', t, t);
  await linkConversationToProject(USER, id, PROJECT_ID);
  return id;
}

function allText(blocks) { return blocks.join('\n'); }

maybe('continuidade: chat novo no projeto recupera as últimas conversas e decisões', async () => {
  await seedScenario();
  const convId = await newChatInProject();

  const { blocks, meta } = await buildContext({
    userId: USER, conversationId: convId, assistantId: null, clientScope: null,
    userText: 'Vamos continuar de onde paramos.', model: 'gpt-4o', projectId: PROJECT_ID,
  });
  const text = allText(blocks);

  assert.equal(meta.project?.id, PROJECT_ID, 'o contexto deve reconhecer o projeto ativo');
  assert.match(text, /SPED-HUB/, 'deve trazer a identidade do projeto');
  assert.match(text, /WeasyPrint/, 'deve trazer as decisões técnicas registradas');
  assert.match(text, /I250/, 'deve trazer as correções já feitas');
  assert.match(text, /Fase 3/, 'deve trazer a próxima etapa planejada');
});

maybe('continuidade: memórias e conversas irrelevantes NÃO entram', async () => {
  await seedScenario();
  const convId = await newChatInProject();

  const { blocks, meta } = await buildContext({
    userId: USER, conversationId: convId, assistantId: null, clientScope: null,
    userText: 'Implemente o upload de arquivos do dashboard.', model: 'gpt-4o', projectId: PROJECT_ID,
  });
  const text = allText(blocks);

  assert.doesNotMatch(text, /COBOL/i, 'conversa de COBOL não tem relação com a tarefa');
  assert.doesNotMatch(text, /aviso prévio/i, 'aviso prévio não tem relação com a tarefa');
  assert.doesNotMatch(text, /Conectividade Social/i, 'preferência genérica de contabilidade não deve entrar');

  // A enxurrada: antes TODAS as memórias de perfil/preferência entravam sempre.
  assert.ok(meta.memories.length <= 3, `esperado no máximo 3 memórias gerais, veio ${meta.memories.length}`);
});

maybe('continuidade: o projeto vence uma conversa recente de outro assunto', async () => {
  await seedScenario();
  // Conversa de contabilidade de HOJE — mais recente que a do projeto (ontem).
  const c = await makeConversation('c_test_hoje', 'Fechamento contábil do mês', {
    summary: 'Conciliação bancária e balancete do fechamento mensal do cliente.', daysAgo: 0,
  });
  await makeChunk('ch_test_hoje', c, 'Fechamento contábil do mês',
    'Conciliação bancária, balancete, lançamentos de fechamento e apuração de IRPJ/CSLL do mês.', { daysAgo: 0 });

  const convId = await newChatInProject();
  const { blocks } = await buildContext({
    userId: USER, conversationId: convId, assistantId: null, clientScope: null,
    userText: 'Continue a implementação.', model: 'gpt-4o', projectId: PROJECT_ID,
  });
  const text = allText(blocks);

  assert.match(text, /WeasyPrint|I250|Fase 3/, 'a conversa do projeto (ontem) deve estar no contexto');
  assert.doesNotMatch(text, /balancete|Conciliação bancária/i, 'a conversa recente de outro assunto não deve entrar');
});

maybe('projeto antigo: conversas do histórico do navegador são adotadas', async () => {
  await seedScenario();
  // Simula o estado de quem já usava o app: a conversa existe e o navegador
  // sabe que ela é do projeto, mas o servidor ainda não tinha esse vínculo.
  await db.prepare('UPDATE conversations SET project_id=NULL WHERE id=?').run('c_test_fase2');
  await db.prepare('UPDATE conversation_chunks SET project_id=NULL WHERE conversation_id=?').run('c_test_fase2');

  const adotadas = await adoptConversations(USER, PROJECT_ID, ['c_test_fase2']);
  assert.equal(adotadas, 1, 'a conversa do histórico deveria ser adotada');

  const convId = await newChatInProject('c_test_novo2');
  const { blocks } = await buildContext({
    userId: USER, conversationId: convId, assistantId: null, clientScope: null,
    userText: 'Continue de onde paramos.', model: 'gpt-4o', projectId: PROJECT_ID,
  });
  assert.match(allText(blocks), /WeasyPrint|I250/, 'o histórico adotado deve voltar no contexto');
});

maybe('sem projeto ativo o comportamento antigo continua contido (sem enxurrada)', async () => {
  await seedScenario();
  const t = now();
  await db.prepare('INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('c_test_solto', USER, 'Nova conversa', 'gpt-4o', t, t);

  const { meta } = await buildContext({
    userId: USER, conversationId: 'c_test_solto', assistantId: null, clientScope: null,
    userText: 'Me ajude a revisar uma frase do e-mail.', model: 'gpt-4o', projectId: null,
  });
  assert.ok(meta.memories.length <= 3, `esperado no máximo 3 memórias, veio ${meta.memories.length}`);
});

// Regressão do bug que veio no Context Builder 3.1 (#134): `chunksIncluded`
// era usado sem nunca ter sido declarado. O push acontecia dentro de um
// `try {} catch {}`, que engolia o ReferenceError; a montagem seguinte, fora do
// try, derrubava o buildContext inteiro. Efeito prático: TODA resposta caía no
// fallback simples de memória — o Context Builder não rodava nunca.
maybe('buildContext não explode quando há conversas antigas candidatas', async () => {
  await seedScenario();
  const t = now();
  await db.prepare('INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('c_test_reg', USER, 'Nova conversa', 'gpt-4o', t, t);

  // Não deve lançar: antes da correção, lançava ReferenceError aqui.
  const { blocks, meta } = await buildContext({
    userId: USER, conversationId: 'c_test_reg', assistantId: null, clientScope: null,
    userText: 'analise o balanço patrimonial e a conciliação bancária do cliente',
    model: 'gpt-4o', projectId: null,
  });
  assert.ok(Array.isArray(blocks), 'buildContext deve devolver blocos, não explodir');
  assert.equal(typeof meta.stats.chunksUsed, 'number');
});
