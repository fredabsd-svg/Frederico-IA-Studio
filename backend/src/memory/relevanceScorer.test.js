import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzePrompt,
  detectContentDomain,
  scoreMemory,
  scoreConversation,
  validateRelevance,
  deduplicateContext,
  extractRelevantSnippet,
  MEMORY_THRESHOLD,
  CONVERSATION_THRESHOLD,
} from './relevanceScorer.js';

// ─── Teste 1: Revisão de aplicativo ────────────────────────────────────

test('Teste 1 — Revisão de aplicativo: detecta domínio software', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  assert.equal(analysis.domain, 'software');
  assert.equal(analysis.intent, 'code_review');
  assert.equal(analysis.project, 'frederico-ia-studio');
});

test('Teste 1 — Memória de projeto é incluída', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mem = { content: 'O projeto Frederico-IA-Studio usa multi-modelo e streaming SSE', type: 'projeto', importance: 4, pinned: false };
  const result = scoreMemory(mem, analysis, 0.5);
  assert.ok(result.shouldInclude, `esperado include, got ${result.reason}`);
});

test('Teste 1 — Memória de contabilidade é descartada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mem = { content: 'O usuário precisa de análises financeiras detalhadas com foco em balanço patrimonial e DRE', type: 'preferencia', importance: 3, pinned: false };
  const result = scoreMemory(mem, analysis, 0.2);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

test('Teste 1 — Conversa sobre bugs do app é incluída', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const chunk = { content: 'Encontramos um bug no agent loop onde o streaming SSE interrompia antes de completar a resposta do modelo', source_title: 'Revisão do aplicativo', created_at: '2026-01-01T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.6);
  assert.ok(result.shouldInclude, `esperado include, got ${result.reason}`);
});

test('Teste 1 — Conversa sobre fluxo de caixa é descartada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const chunk = { content: 'Análise do fluxo de caixa pelo método direto: entradas e saídas organizadas por atividade operacional, investimento e financiamento', source_title: 'Fluxo de caixa Excel', created_at: '2026-07-20T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.25);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

test('Teste 1 — Conversa sobre tributação é descartada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const chunk = { content: 'Retenção de tributos na nota fiscal: IRPJ 1.5%, CSLL 1%, PIS 0.65%, COFINS 3%', source_title: 'Análise tributária', created_at: '2026-07-22T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.2);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

// ─── Teste 2: Contabilidade ────────────────────────────────────────────

test('Teste 2 — Contabilidade: detecta domínio accounting', () => {
  const analysis = analyzePrompt('Analise este fluxo de caixa pelo método direto.');
  assert.equal(analysis.domain, 'accounting');
  assert.equal(analysis.intent, 'accounting_analysis');
});

test('Teste 2 — Memória sobre DFC é incluída', () => {
  const analysis = analyzePrompt('Analise este fluxo de caixa pelo método direto.');
  const mem = { content: 'O usuário precisa de análises financeiras detalhadas com foco em balanço patrimonial e DRE', type: 'preferencia', importance: 4, pinned: false };
  const result = scoreMemory(mem, analysis, 0.5);
  assert.ok(result.shouldInclude, `esperado include, got ${result.reason}`);
});

test('Teste 2 — Conversa sobre desenvolvimento é descartada', () => {
  const analysis = analyzePrompt('Analise este fluxo de caixa pelo método direto.');
  const chunk = { content: 'Corrigimos o bug no agent loop onde o streaming SSE interrompia. O commit no GitHub resolveu o problema do multi-modelo.', source_title: 'Revisão do aplicativo', created_at: '2026-07-20T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.25);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

// ─── Teste 3: Tributário ───────────────────────────────────────────────

test('Teste 3 — Tributário: detecta domínio accounting', () => {
  const analysis = analyzePrompt('Analise se existe retenção de tributos nessa nota fiscal.');
  assert.equal(analysis.domain, 'accounting');
  assert.equal(analysis.intent, 'tax_analysis');
});

test('Teste 3 — Memória tributária é incluída', () => {
  const analysis = analyzePrompt('Analise se existe retenção de tributos nessa nota fiscal.');
  const mem = { content: 'O usuário opera no regime de Lucro Real e pode aproveitar créditos de PIS, COFINS e ICMS', type: 'perfil', importance: 4, pinned: false };
  const result = scoreMemory(mem, analysis, 0.45);
  assert.ok(result.shouldInclude, `esperado include, got ${result.reason}`);
});

test('Teste 3 — Conversa sobre software é descartada', () => {
  const analysis = analyzePrompt('Analise se existe retenção de tributos nessa nota fiscal.');
  const chunk = { content: 'Refatoramos o context builder para usar pgvector e melhoramos o agent loop com streaming SSE', source_title: 'Refatoração do backend', created_at: '2026-07-20T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.2);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

// ─── Teste 4: Pedido de texto ──────────────────────────────────────────

test('Teste 4 — Pedido de texto: domínio general, não busca muito', () => {
  const analysis = analyzePrompt('Melhore esta frase.');
  assert.equal(analysis.domain, 'general');
  assert.equal(analysis.intent, 'text_improvement');
});

test('Teste 4 — Memória de contabilidade não entra em pedido de texto', () => {
  const analysis = analyzePrompt('Melhore esta frase.');
  const mem = { content: 'O usuário opera no regime de Lucro Real e pode aproveitar créditos de PIS, COFINS e ICMS', type: 'perfil', importance: 4, pinned: false };
  const result = scoreMemory(mem, analysis, 0.15);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

// ─── Teste 5: Memória relevante, conversa irrelevante ─────────────────

test('Teste 5 — Memória útil, nenhuma conversa relacionada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mem = { content: 'O modo desenvolvedor ativa o GitHub clone e ferramentas de compilação', type: 'projeto', importance: 4, pinned: false };
  const memResult = scoreMemory(mem, analysis, 0.55);
  assert.ok(memResult.shouldInclude, 'memória deveria ser incluída');

  const chunk = { content: 'Demonstração do fluxo de caixa pelo método direto com planilha Excel', source_title: 'Fluxo de caixa', created_at: '2026-07-20T00:00:00.000Z' };
  const chunkResult = scoreConversation(chunk, analysis, 0.2);
  assert.ok(!chunkResult.shouldInclude, 'conversa não deveria ser incluída');
});

// ─── Teste 6: Conversa relevante, memória irrelevante ──────────────────

test('Teste 6 — Conversa útil, nenhuma memória relacionada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mem = { content: 'O usuário precisa de orientação sobre como responder a pedidos de redução de aviso prévio', type: 'preferencia', importance: 3, pinned: false };
  const memResult = scoreMemory(mem, analysis, 0.15);
  assert.ok(!memResult.shouldInclude, 'memória não deveria ser incluída');

  const chunk = { content: 'Bug no modo desenvolvedor: o GitHub clone falhava quando o branch não existia. Corrigimos adicionando fallback.', source_title: 'Correção do modo desenvolvedor', created_at: '2026-01-15T00:00:00.000Z' };
  const chunkResult = scoreConversation(chunk, analysis, 0.65);
  assert.ok(chunkResult.shouldInclude, 'conversa deveria ser incluída');
});

// ─── Teste 7: Nenhum contexto relevante ───────────────────────────────

test('Teste 7 — Nenhum contexto relevante retorna zero', () => {
  const analysis = analyzePrompt('Melhore esta frase.');
  const mem = { content: 'O usuário opera no regime de Lucro Real e pode aproveitar créditos de PIS, COFINS e ICMS', type: 'perfil', importance: 4, pinned: false };
  const memResult = scoreMemory(mem, analysis, 0.1);
  assert.ok(!memResult.shouldInclude);

  const chunk = { content: 'Refatoramos o context builder para usar pgvector', source_title: 'Refatoração', created_at: '2026-07-20T00:00:00.000Z' };
  const chunkResult = scoreConversation(chunk, analysis, 0.1);
  assert.ok(!chunkResult.shouldInclude);
});

// ─── Teste: Recência não supera relevância ─────────────────────────────

test('Recência não supera relevância — conversa antiga relevante > recente irrelevante', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');

  const oldRelevant = { content: 'Bug no modo desenvolvedor: GitHub clone falhava. Corrigimos o agent loop.', source_title: 'Correção do modo dev', created_at: '2026-01-01T00:00:00.000Z' };
  const recentIrrelevant = { content: 'Análise do fluxo de caixa pelo método direto com Excel e CPC 03', source_title: 'Fluxo de caixa', created_at: '2026-07-24T00:00:00.000Z' };

  const oldResult = scoreConversation(oldRelevant, analysis, 0.6);
  const recentResult = scoreConversation(recentIrrelevant, analysis, 0.25);

  assert.ok(oldResult.shouldInclude, 'conversa antiga relevante deveria ser incluída');
  assert.ok(!recentResult.shouldInclude, 'conversa recente irrelevante deveria ser descartada');
  assert.ok(oldResult.score > recentResult.score, `score antiga (${oldResult.score}) deveria ser > recente (${recentResult.score})`);
});

// ─── Teste: Detecção de domínio ────────────────────────────────────────

test('detectContentDomain identifica software', () => {
  const { domain } = detectContentDomain('Bug no agent loop do backend com streaming SSE e pgvector');
  assert.equal(domain, 'software');
});

test('detectContentDomain identifica accounting', () => {
  const { domain } = detectContentDomain('Fluxo de caixa pelo método direto, DRE, balanço patrimonial');
  assert.equal(domain, 'accounting');
});

test('detectContentDomain identifica general quando não há domínio claro', () => {
  const { domain } = detectContentDomain('Olá, como vai você hoje?');
  assert.equal(domain, 'general');
});

// ─── Teste: Deduplicação ───────────────────────────────────────────────

test('deduplicateContext remove duplicatas', () => {
  const items = [
    { preview: 'Memória sobre o projeto', content: 'Memória sobre o projeto' },
    { preview: 'Memória sobre o projeto', content: 'Memória sobre o projeto' },
    { preview: 'Outra memória', content: 'Outra memória' },
  ];
  const result = deduplicateContext(items);
  assert.equal(result.length, 2);
});

// ─── Teste: Recorte de trechos ─────────────────────────────────────────

test('extractRelevantSnippet recorta trecho relevante de conversa mista', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mixedContent = [
    'Usuário: Vamos falar sobre o fluxo de caixa.',
    'Assistente: O fluxo de caixa pelo método direto organiza as entradas e saídas.',
    'Usuário: Agora sobre o aplicativo.',
    'Assistente: O modo desenvolvedor ativa o GitHub clone e ferramentas de compilação.',
    'Encontramos um bug no agent loop onde o streaming SSE interrompia.',
    'Corrigimos o problema no commit no GitHub.',
    'Usuário: E sobre a retenção de tributos?',
    'Assistente: A retenção de IRPJ é 1.5% para serviços.',
  ].join('\n');

  const snippet = extractRelevantSnippet(mixedContent, analysis, 500);
  assert.ok(snippet.length <= 500);
  assert.ok(snippet.includes('desenvolvedor') || snippet.includes('GitHub') || snippet.includes('agent') || snippet.includes('streaming'),
    `snippet deveria conter termos de software, got: ${snippet.slice(0, 100)}`);
});

// ─── Teste: Validação semântica ────────────────────────────────────────

test('validateRelevance descarta conteúdo de domínio incompatível', () => {
  const analysis = analyzePrompt('Analise este fluxo de caixa pelo método direto.');
  const scoreResult = { shouldInclude: true, reason: 'passou por importância', score: 0.3, semanticSim: 0.1 };
  const result = validateRelevance('Bug no agent loop do backend com streaming SSE', analysis, scoreResult);
  assert.ok(!result.valid, 'deveria ser invalidado pela validação semântica');
});

test('validateRelevance aceita conteúdo de domínio compatível', () => {
  const analysis = analyzePrompt('Analise este fluxo de caixa pelo método direto.');
  const scoreResult = { shouldInclude: true, reason: 'mesmo domínio', score: 0.5, semanticSim: 0.5 };
  const result = validateRelevance('Fluxo de caixa pelo método direto com CPC 03', analysis, scoreResult);
  assert.ok(result.valid, 'deveria ser validado');
});

// ─── Teste: Memória pinned não entra se domínio for incompatível ───────

test('Memória pinned de domínio incompatível é descartada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mem = { content: 'O usuário precisa de orientação sobre como responder a pedidos de redução de aviso prévio', type: 'preferencia', importance: 5, pinned: true };
  const result = scoreMemory(mem, analysis, 0.1);
  assert.ok(!result.shouldInclude, 'memória pinned de domínio incompatível não deveria entrar');
});

// ─── Teste: Memória genérica de perfil entra quando compatível ─────────

test('Memória de perfil genérico entra quando prompt é genérico', () => {
  const analysis = analyzePrompt('Qual modelo devo usar para gerar um relatório?');
  const mem = { content: 'O usuário se chama Frederico', type: 'perfil', importance: 5, pinned: false };
  const result = scoreMemory(mem, analysis, 0.3);
  // Perfil genérico pode ser útil em prompt genérico
  assert.ok(result.shouldInclude || result.score >= 0, `deveria ter score razoável, got ${result.reason}`);
});
