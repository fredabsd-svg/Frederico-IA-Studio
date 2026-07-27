import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWLEDGE, findKnowledge, scoreEntry, normalize } from './knowledge.js';

// O risco desta base não é errar o verbete certo — é anexar documentação a
// perguntas que nada têm com o Studio (gasto de tokens e resposta enviesada).
// Por isso os testes cobrem tanto o acerto quanto o silêncio.

test('normalize tira acento, caixa e pontuação', () => {
  assert.equal(normalize('Configuração, ÀÉÎÕÜ ç!'), 'configuracao aeiou c');
  assert.equal(normalize(null), '');
});

test('cada verbete tem título, palavras-chave e conteúdo', () => {
  assert.ok(KNOWLEDGE.length >= 10);
  const ids = new Set();
  for (const e of KNOWLEDGE) {
    assert.ok(e.id && e.title && e.content, `verbete incompleto: ${e.id}`);
    assert.ok(Array.isArray(e.keywords) && e.keywords.length > 0, `sem keywords: ${e.id}`);
    assert.ok(!ids.has(e.id), `id duplicado: ${e.id}`);
    ids.add(e.id);
  }
});

test('acha o verbete certo para perguntas típicas do painel', () => {
  const casos = [
    ['como eu gero uma planilha de Excel?', 'documentos'],
    ['minha chave da OpenAI deu erro de API', 'provedores'],
    ['o Nino pode ler meu chat principal?', 'copiloto'],
    ['como funciona a memória das conversas?', 'memoria'],
    ['dá para comparar vários modelos na mesma pergunta?', 'multimodelo'],
    ['como agendo uma rotina automática?', 'rotinas'],
  ];
  for (const [pergunta, esperado] of casos) {
    const hits = findKnowledge(pergunta);
    assert.ok(hits.length > 0, `nada encontrado para: ${pergunta}`);
    assert.equal(hits[0].id, esperado, `esperava ${esperado} para "${pergunta}", veio ${hits[0].id}`);
  }
});

test('fica em silêncio quando a pergunta não é sobre o Studio', () => {
  assert.deepEqual(findKnowledge('qual a capital da França?'), []);
  assert.deepEqual(findKnowledge('escreva um poema sobre o mar'), []);
  assert.deepEqual(findKnowledge(''), []);
  assert.deepEqual(findKnowledge('   '), []);
});

test('respeita o limite de resultados', () => {
  const hits = findKnowledge('como configuro o provedor de IA e a chave da API no Studio', { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(findKnowledge('provedor chave api', { limit: 0 }).length, 0);
});

test('scoreEntry pesa palavra-chave acima de palavra solta no corpo', () => {
  const entry = { id: 't', title: 'Título neutro', keywords: ['docling'], content: 'menciona rotina uma vez' };
  assert.ok(scoreEntry(entry, 'docling') > scoreEntry(entry, 'rotina'));
  assert.equal(scoreEntry(entry, ''), 0);
});

test('aceita flexão por prefixo, mas vale menos que o acerto exato', () => {
  const entry = { id: 'r', title: 'X', keywords: ['agendar'], content: 'y' };
  const aprox = scoreEntry(entry, 'como agendo isso');       // agendo ~ agendar
  const exato = scoreEntry(entry, 'quero agendar isso');
  assert.ok(aprox > 0 && aprox < exato);
  // Prefixo curto demais não casa (evita "conta" puxar "container").
  assert.equal(scoreEntry({ id: 'z', title: 'X', keywords: ['git'], content: 'y' }, 'gita'), 0);
});

test('expressão de várias palavras conta como frase inteira', () => {
  const entry = { id: 'pr', title: 'X', keywords: ['pull request'], content: 'y' };
  assert.ok(scoreEntry(entry, 'como abro um pull request?') >= 4);
  assert.equal(scoreEntry(entry, 'pull'), 0);   // metade da expressão não vale
});
