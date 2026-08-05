// F-16: relevância de memória (casos negativos) — filtros que decidem se a
// camada externa (memórias, conversas, arquivos) deve ser carregada.
//
// Sem esses casos cobertos, o agente carrega memórias irrelevantes em
// qualquer turno (saudações, confirmações, mensagens curtas) — desperdiça
// tokens e polui o contexto com coisas que o usuário não pediu.
//
// Cobre os edge cases do `isLowSignalTurn` que NÃO estão no teste
// original: unicode, emojis, whitespace, comprimento-limite, edge cases
// de comprimento zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLowSignalTurn, LOW_SIGNAL_TURN_NOTE } from './retrievalPolicy.js';

// ---- Saudação pura: SINAL BAIXO -----------------------------

test('saudações puras com e sem acento são baixo-sinal', () => {
  // O normalize() joga acentos fora — "olá" e "ola" viram a mesma coisa.
  for (const text of ['oi', 'oii', 'oiii', 'oie', 'olá', 'olá!', 'ola', 'Ola, tudo bem?', 'bom dia', 'boa tarde', 'boa noite', 'e aí', 'opa', 'hey', 'hello', 'hi']) {
    assert.equal(isLowSignalTurn(text), true, `regressão: "${text}" deveria ser baixo-sinal`);
  }
});

test('confirmações puras (sem resposta pendente) são baixo-sinal', () => {
  for (const text of ['ok', 'okay', 'beleza', 'valeu', 'obrigado', 'obrigada']) {
    assert.equal(isLowSignalTurn(text), true, `regressão: "${text}" deveria ser baixo-sinal`);
  }
});

// ---- Confirmações em resposta a pergunta do agente: SINAL ALTO -----

test('confirmações simples NÃO são baixo-sinal (resposta a pergunta do agente)', () => {
  // Quando o agente perguntou "posso gerar o relatório?", o "pode" é a
  // RESPOSTA — sem ferramentas o agente não executa o que prometeu.
  for (const text of ['pode', 'sim', 'não', 'nao', 'continua', 'continua por favor', 'claro', 'pode sim', 'pode ir']) {
    assert.equal(isLowSignalTurn(text), false, `regressão: "${text}" NÃO deveria ser baixo-sinal (resposta pendente)`);
  }
});

// ---- Pedidos REAIS misturados com saudação: SINAL ALTO -----

test('pedido misturado com saudação mantém o sinal alto', () => {
  // "oi, analise meu workspace" começa com saudação mas tem pedido real.
  // Carregar memórias aqui é OK — o usuário quer algo.
  for (const text of [
    'oi, analise meu workspace',
    'bom dia, gere um relatório de vendas',
    'olá, qual modelo você recomenda para PDF?',
    'ei, lembre que prefiro respostas curtas',
    'opa, pode me ajudar com a planilha?'
  ]) {
    assert.equal(isLowSignalTurn(text), false, `regressão: "${text}" tem pedido real, NÃO deveria ser baixo-sinal`);
  }
});

// ---- Edge cases do normalize() -----------------------------

test('saudação com emojis e símbolos é normalizada corretamente', () => {
  // Emojis viram espaços via regex `[^a-z0-9\s]` — "olá 👋" vira "ola" + espaço.
  // A regex de saudação deve casar mesmo após a normalização.
  for (const text of ['oi 👋', 'olá! 😊', 'ola!!!', 'bom dia 🌅', 'e ai?', 'hey 👀']) {
    assert.equal(isLowSignalTurn(text), true, `"${text}" deveria ser baixo-sinal após normalização`);
  }
});

test('whitespace puro e string vazia NÃO são baixo-sinal (não há turno)', () => {
  // Edge case: normalize() retorna string vazia para entrada vazia/
  // whitespace-only. isLowSignalTurn exige length > 0, então devolve
  // false — o que está certo: turno vazio não é "baixo sinal", é
  // ausência de turno. O agente não deve tratar como baixo sinal (o
  // que ligaria ferramentas), nem como alto (que vasculharia memórias
  // à toa). Devolve false → comportamento padrão.
  assert.equal(isLowSignalTurn(''), false);
  assert.equal(isLowSignalTurn('   '), false);
  assert.equal(isLowSignalTurn('\n\n\t'), false);
  assert.equal(isLowSignalTurn(null), false);
  assert.equal(isLowSignalTurn(undefined), false);
});

test('saudação com whitespace extra é normalizada', () => {
  // Múltiplos espaços, quebras de linha, tabs — tudo vira um espaço só
  // antes de casar a regex.
  for (const text of ['  oi  ', 'oi\n', 'oi\t\t', '   bom   dia   ']) {
    assert.equal(isLowSignalTurn(text), true, `"${text}" deveria casar após normalização`);
  }
});

// ---- Comprimento: limite de 80 chars após normalização -----

test('texto > 80 chars (mesmo sendo saudação) NÃO é baixo-sinal', () => {
  // Defesa contra "oi" + 80 chars de lorem ipsum — não é saudação,
  // tem informação real, mesmo que contenha "oi".
  const longo = 'oi ' + 'a'.repeat(80);
  assert.ok(longo.length > 80);
  assert.equal(isLowSignalTurn(longo), false);
});

test('saudação curta de até 80 chars é baixo-sinal', () => {
  // "oi tudo bem?" tem ~14 chars — bem dentro do limite.
  assert.equal(isLowSignalTurn('oi tudo bem?'), true);
  // 80 chars exatos: ainda é baixo-sinal.
  const limite = 'olá tudo bem'.padEnd(80, ' ');
  assert.ok(limite.length === 80);
  assert.equal(isLowSignalTurn(limite), true);
});

// ---- LOW_SIGNAL_TURN_NOTE — texto da nota -------------------------

test('LOW_SIGNAL_TURN_NOTE contém os pontos críticos', () => {
  // A nota é o que o agente recebe no lugar das memórias — tem que
  // deixar claro: sem ferramentas, sem vasculhar contexto anterior.
  assert.match(LOW_SIGNAL_TURN_NOTE, /ferramentas/i);
  assert.match(LOW_SIGNAL_TURN_NOTE, /mem\u00f3rias|conversas anteriores/i);
  assert.match(LOW_SIGNAL_TURN_NOTE, /sem a pessoa pedir/i);
});
