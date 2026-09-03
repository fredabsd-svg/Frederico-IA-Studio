// O bloco CONTEXTO DESTA CHAMADA é o ÚLTIMO do prompt e o único com variáveis.
// Ele existe por um motivo concreto: sem a data de hoje escrita no prompt, o
// modelo usa a data do próprio treinamento — e assina um relatório com o ano
// errado, calcula um vencimento a partir de uma segunda-feira que não existe e
// põe "2024" numa proposta de 2026.
//
// Estes testes cobram as três coisas que podem sair erradas em silêncio: a data
// no fuso certo, a ausência de placeholder cru (`{{...}}` no texto é lido pelo
// modelo como conteúdo e reaparece na resposta) e a ORDEM dos blocos finais.
import assert from 'node:assert/strict';
import test from 'node:test';
import { callContextVars, preencher, CONTEXTO_DA_CHAMADA, ORDEM_DE_CONFLITO } from './systemPromptV4.js';
import { promptFor } from './prompts.js';

// Uma quarta-feira de setembro, às 15h de Brasília. A hora importa: perto da
// meia-noite, um fuso errado troca o DIA.
const QUARTA = new Date('2026-09-02T15:00:00-03:00');

test('a data da chamada entra no prompt, no fuso do aplicativo', () => {
  const prompt = promptFor(null, { now: QUARTA, model: 'x-ai/grok-4-fast' });
  assert.match(prompt, /quarta-feira/);
  assert.match(prompt, /02\/09\/2026/);
  assert.match(prompt, /"Este ano" = 2026/);
  assert.match(prompt, /Modelo em uso: x-ai\/grok-4-fast/);
});

test('nenhum placeholder cru sobrevive no prompt entregue', () => {
  // Vale para as duas formas do prompt: com e sem a seção de documentos.
  assert.doesNotMatch(promptFor(null, { now: QUARTA }), /\{\{/);
  assert.doesNotMatch(promptFor({ tools: ['consultar_cnpj'] }, { now: QUARTA }), /\{\{/);
});

test('variável sem valor vira vazio, não sobra a marca no texto', () => {
  assert.equal(preencher('a {{b}} c', {}), 'a  c');
  assert.equal(preencher('a {{b}} c', { b: 'X' }), 'a X c');
});

test('o estado da rede do sandbox é dito, não deduzido', () => {
  assert.match(promptFor(null, { sandboxNetworkEnabled: true }), /Rede direta do sandbox: LIGADA/);
  assert.match(promptFor(null, { sandboxNetworkEnabled: false }), /Rede direta do sandbox: DESLIGADA/);
});

test('a hora NÃO entra: ela invalidaria o cache de prompt a cada turno', () => {
  // `messages[0]` é o prefixo estável da conversa e o primeiro breakpoint do
  // cache. A data muda uma vez por dia; a hora mudaria a cada chamada.
  const manha = promptFor(null, { now: new Date('2026-09-02T09:00:00-03:00') });
  const tarde = promptFor(null, { now: new Date('2026-09-02T21:00:00-03:00') });
  assert.equal(manha, tarde);
});

test('o fuso vem da configuração do aplicativo', () => {
  const vars = callContextVars({ now: QUARTA, timeZone: 'America/Manaus' });
  assert.equal(vars.fuso, 'America/Manaus');
  // Manaus é uma hora atrás: às 15h de Brasília ainda é o mesmo dia.
  assert.equal(vars.data_ddmmaaaa, '02/09/2026');
  // Mas às 00h30 de Brasília, em Manaus ainda é o dia anterior — e é por isso
  // que a data é formatada NO FUSO, e não com `toISOString()`.
  const madrugada = callContextVars({ now: new Date('2026-09-03T00:30:00-03:00'), timeZone: 'America/Manaus' });
  assert.equal(madrugada.data_ddmmaaaa, '02/09/2026');
});

test('a hierarquia de conflito é o penúltimo bloco e o contexto o último', () => {
  // A ordem é contrato: a hierarquia só se lê como hierarquia quando vem DEPOIS
  // de tudo que ela ordena, e o contexto da chamada fecha o prompt.
  const prompt = promptFor(null, { now: QUARTA });
  const conflito = prompt.indexOf(ORDEM_DE_CONFLITO);
  const contexto = prompt.indexOf(CONTEXTO_DA_CHAMADA.split('\n')[0]);
  assert.ok(conflito > 0, 'a hierarquia de conflito deveria estar no prompt');
  assert.ok(contexto > conflito, 'o contexto da chamada tem de vir DEPOIS da hierarquia');
  const blocos = prompt.split('\n\n');
  assert.equal(blocos.at(-1).startsWith('CONTEXTO DESTA CHAMADA'), true,
    'o contexto da chamada tem de ser o ÚLTIMO bloco');
});

test('o prompt cabe no orçamento de contexto', () => {
  // Catraca contra crescimento silencioso. O prompt é enviado em TODA chamada;
  // cada mil caracteres aqui custam em cada turno de cada conversa.
  const comDocumentos = promptFor(null, { now: QUARTA });
  const semDocumentos = promptFor({ tools: ['consultar_cnpj'] }, { now: QUARTA });
  assert.ok(comDocumentos.length < 23000,
    `com a seção de documentos: ${comDocumentos.length} caracteres`);
  assert.ok(semDocumentos.length < 11000,
    `sem a seção de documentos: ${semDocumentos.length} caracteres`);
  // E a diferença entre as duas é justamente a seção — a prova de que ela não
  // está sendo carregada para quem não pode executar.
  assert.ok(comDocumentos.length - semDocumentos.length > 8000);
});
