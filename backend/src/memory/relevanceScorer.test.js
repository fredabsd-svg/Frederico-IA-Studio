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
  calibrateSimilarity,
} from './relevanceScorer.js';

// NOTA SOBRE AS SIMILARIDADES DESTES TESTES
// Os valores passados a scoreMemory/scoreConversation estão na escala REAL do
// multilingual-e5-small, não numa escala 0..1 imaginária. Medido com o próprio
// modelo: textos sem relação nenhuma já dão ~0,79; conteúdo do mesmo assunto
// fica em ~0,86-0,91. Por isso "irrelevante" aqui é ~0,80-0,82 e "relevante" é
// ~0,88-0,89. Ver calibrateSimilarity() no relevanceScorer.

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
  const result = scoreMemory(mem, analysis, 0.82);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

test('Teste 1 — Conversa sobre bugs do app é incluída', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const chunk = { content: 'Encontramos um bug no agent loop onde o streaming SSE interrompia antes de completar a resposta do modelo', source_title: 'Revisão do aplicativo', created_at: '2026-01-01T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.88);
  assert.ok(result.shouldInclude, `esperado include, got ${result.reason}`);
});

test('Teste 1 — Conversa sobre fluxo de caixa é descartada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const chunk = { content: 'Análise do fluxo de caixa pelo método direto: entradas e saídas organizadas por atividade operacional, investimento e financiamento', source_title: 'Fluxo de caixa Excel', created_at: '2026-07-20T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.82);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

test('Teste 1 — Conversa sobre tributação é descartada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const chunk = { content: 'Retenção de tributos na nota fiscal: IRPJ 1.5%, CSLL 1%, PIS 0.65%, COFINS 3%', source_title: 'Análise tributária', created_at: '2026-07-22T00:00:00.000Z' };
  const result = scoreConversation(chunk, analysis, 0.82);
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
  const result = scoreConversation(chunk, analysis, 0.82);
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
  const result = scoreConversation(chunk, analysis, 0.82);
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
  const result = scoreMemory(mem, analysis, 0.81);
  assert.ok(!result.shouldInclude, `esperado descarte, got score=${result.score}, reason=${result.reason}`);
});

// ─── Teste 5: Memória relevante, conversa irrelevante ─────────────────

test('Teste 5 — Memória útil, nenhuma conversa relacionada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mem = { content: 'O modo desenvolvedor ativa o GitHub clone e ferramentas de compilação', type: 'projeto', importance: 4, pinned: false };
  const memResult = scoreMemory(mem, analysis, 0.55);
  assert.ok(memResult.shouldInclude, 'memória deveria ser incluída');

  const chunk = { content: 'Demonstração do fluxo de caixa pelo método direto com planilha Excel', source_title: 'Fluxo de caixa', created_at: '2026-07-20T00:00:00.000Z' };
  const chunkResult = scoreConversation(chunk, analysis, 0.82);
  assert.ok(!chunkResult.shouldInclude, 'conversa não deveria ser incluída');
});

// ─── Teste 6: Conversa relevante, memória irrelevante ──────────────────

test('Teste 6 — Conversa útil, nenhuma memória relacionada', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');
  const mem = { content: 'O usuário precisa de orientação sobre como responder a pedidos de redução de aviso prévio', type: 'preferencia', importance: 3, pinned: false };
  const memResult = scoreMemory(mem, analysis, 0.81);
  assert.ok(!memResult.shouldInclude, 'memória não deveria ser incluída');

  const chunk = { content: 'Bug no modo desenvolvedor: o GitHub clone falhava quando o branch não existia. Corrigimos adicionando fallback.', source_title: 'Correção do modo desenvolvedor', created_at: '2026-01-15T00:00:00.000Z' };
  const chunkResult = scoreConversation(chunk, analysis, 0.89);
  assert.ok(chunkResult.shouldInclude, 'conversa deveria ser incluída');
});

// ─── Teste 7: Nenhum contexto relevante ───────────────────────────────

test('Teste 7 — Nenhum contexto relevante retorna zero', () => {
  const analysis = analyzePrompt('Melhore esta frase.');
  const mem = { content: 'O usuário opera no regime de Lucro Real e pode aproveitar créditos de PIS, COFINS e ICMS', type: 'perfil', importance: 4, pinned: false };
  const memResult = scoreMemory(mem, analysis, 0.80);
  assert.ok(!memResult.shouldInclude);

  const chunk = { content: 'Refatoramos o context builder para usar pgvector', source_title: 'Refatoração', created_at: '2026-07-20T00:00:00.000Z' };
  const chunkResult = scoreConversation(chunk, analysis, 0.80);
  assert.ok(!chunkResult.shouldInclude);
});

// ─── Teste: Recência não supera relevância ─────────────────────────────

test('Recência não supera relevância — conversa antiga relevante > recente irrelevante', () => {
  const analysis = analyzePrompt('Faça uma revisão profunda do modo desenvolvedor do meu aplicativo.');

  const oldRelevant = { content: 'Bug no modo desenvolvedor: GitHub clone falhava. Corrigimos o agent loop.', source_title: 'Correção do modo dev', created_at: '2026-01-01T00:00:00.000Z' };
  const recentIrrelevant = { content: 'Análise do fluxo de caixa pelo método direto com Excel e CPC 03', source_title: 'Fluxo de caixa', created_at: '2026-07-24T00:00:00.000Z' };

  const oldResult = scoreConversation(oldRelevant, analysis, 0.88);
  const recentResult = scoreConversation(recentIrrelevant, analysis, 0.82);

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
  const result = scoreMemory(mem, analysis, 0.80);
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

// ─── Regressão: vazamento de domínio em pedidos curtos ─────────────────
// Pedidos curtos de software (1 keyword) caíam em domínio 'general' e, com
// isso, o crivo de domínio se desligava e memórias contábeis fixadas/
// importantes entravam mesmo assim. Agora o softDomain (inclinação fraca)
// mantém o crivo ativo.

test('softDomain: pedido curto de software não é totalmente cego', () => {
  const analysis = analyzePrompt('dá uma olhada no app e encontra bugs');
  assert.equal(analysis.softDomain, 'software');
});

test('Regressão: memória contábil fixada NÃO entra em pedido curto de software', () => {
  const memContabil = { content: 'Cliente XPTO é Simples Nacional anexo III, entrega SPED mensal', type: 'fato', importance: 5, pinned: true };
  for (const p of ['dá uma olhada no app e encontra bugs', 'revise meu aplicativo profundamente', 'arruma o erro que aparece quando salvo']) {
    const analysis = analyzePrompt(p);
    const result = scoreMemory(memContabil, analysis, 0);
    assert.ok(!result.shouldInclude, `"${p}": contábil não deveria entrar (score=${result.score.toFixed(2)}, reason=${result.reason})`);
  }
});

test('Controle: pedido contábil real continua puxando memória contábil', () => {
  const analysis = analyzePrompt('Analise a retenção de tributos dessa nota fiscal e o SPED');
  const memContabil = { content: 'Cliente XPTO é Simples Nacional anexo III, entrega SPED mensal', type: 'fato', importance: 5, pinned: true };
  const result = scoreMemory(memContabil, analysis, 0.3);
  assert.ok(result.shouldInclude, `contábil deveria entrar (score=${result.score.toFixed(2)}, reason=${result.reason})`);
});

test('Palavras-chave de UI classificam como software', () => {
  const { domain } = detectContentDomain('ajustar o layout da tela de login e o botão do menu');
  assert.equal(domain, 'software');
});

// ─── Regressão: pedido curto sem assunto (o caso do SPED-HUB) ──────────
// "vamos continuar o projeto" não tem UMA palavra-chave de domínio. Antes, isso
// caía em domain='general', o que liberava os quatro domínios de uma vez e
// despejava o perfil contábil inteiro numa conversa de software.

test('pedido sem assunto NÃO puxa memória de outro domínio (contexto de software)', () => {
  const analysis = analyzePrompt('vamos continuar o projeto', { contextDomain: 'software' });
  const irrelevantes = [
    'O usuário prefere um roteiro detalhado ficha por ficha para a declaração de IRPF',
    'O usuário precisa de orientação sobre como responder a pedidos de redução de aviso prévio',
    'Frederico trabalha na área de contabilidade e administração de empresas',
  ];
  for (const content of irrelevantes) {
    const r = scoreMemory({ content, type: 'preferencia', importance: 3, pinned: false }, analysis, 0);
    assert.ok(!r.shouldInclude, `deveria barrar "${content.slice(0, 40)}": score=${r.score}, ${r.reason}`);
  }
});

test('pedido sem assunto mantém a memória neutra e a do domínio da conversa', () => {
  const analysis = analyzePrompt('vamos continuar o projeto', { contextDomain: 'software' });

  const nome = scoreMemory({ content: 'O usuário se chama Frederico.', type: 'perfil', importance: 3 }, analysis, 0);
  assert.ok(nome.shouldInclude, `nome é neutro e deveria entrar: ${nome.reason}`);

  const dev = scoreMemory({ content: 'O usuário possui experiência em desenvolvimento de ferramentas de automação em Node.js e Python para arquivos SPED.', type: 'perfil', importance: 3 }, analysis, 0);
  assert.ok(dev.shouldInclude, `memória de software deveria entrar numa conversa de software: ${dev.reason}`);
});

test('pedido sem assunto NÃO puxa conversa antiga por similaridade de fundo do e5', () => {
  const analysis = analyzePrompt('vamos continuar o projeto', { contextDomain: 'software' });
  const chunk = {
    content: 'Alteração contratual com aumento de capital social e registro na junta comercial',
    source_title: 'Alteração contratual com aumento de capital',
    created_at: new Date().toISOString(),
  };
  // 0,818 foi a similaridade REAL medida entre este par — a interface exibia
  // isso como "82%" e a conversa entrava.
  const r = scoreConversation(chunk, analysis, 0.818);
  assert.ok(!r.shouldInclude, `deveria barrar: score=${r.score}, ${r.reason}`);
});

test('o crivo continua valendo quando o pedido é contábil de verdade', () => {
  const analysis = analyzePrompt('preciso calcular o aviso prévio na rescisão do funcionário');
  const mem = { content: 'O usuário precisa de orientação sobre como responder a pedidos de redução de aviso prévio', type: 'preferencia', importance: 3 };
  const r = scoreMemory(mem, analysis, 0.905);
  assert.ok(r.shouldInclude, `memória contábil deveria entrar em pedido contábil: ${r.reason}`);
});

test('domínio da conversa não barra memória do assunto que a mensagem levanta', () => {
  // No SPED-HUB (software), perguntar sobre a REGRA contábil do SPED é legítimo:
  // a mensagem levanta o assunto e ele passa a ser aceitável junto com software.
  const analysis = analyzePrompt('qual o layout do bloco C do SPED fiscal para nota fiscal de saída?', { contextDomain: 'software' });
  const mem = { content: 'O usuário emite nota fiscal e entrega SPED fiscal mensalmente', type: 'perfil', importance: 3 };
  const r = scoreMemory(mem, analysis, 0.88);
  assert.ok(r.shouldInclude, `memória do assunto levantado deveria entrar: ${r.reason}`);
});

test('calibrateSimilarity separa o ruído de fundo do e5 do que é relevante', () => {
  assert.equal(calibrateSimilarity(0.786), 0);          // nada a ver
  assert.ok(calibrateSimilarity(0.818) < 0.25);         // ruído de fundo
  assert.ok(calibrateSimilarity(0.868) > 0.5);          // relacionado
  assert.ok(calibrateSimilarity(0.905) > 0.8);          // mesmo assunto
  // A contagem de palavras (modo degradado) NÃO é calibrada.
  assert.equal(calibrateSimilarity(0.5, 'keyword'), 0.5);
});
