// Testes de endsAwaitingUserReply (repair.js): a resposta que TERMINA com uma
// pergunta ao usuário encerra o turno — o reparo de execução não pode forçar o
// modelo a continuar e "responder a própria pergunta".
// Roda com: node --test src/agent/repair.awaiting.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { endsAwaitingUserReply, MISSING_OUTPUT_NOTICE } from './repair.js';

test('pergunta no final encerra o turno', () => {
  assert.equal(endsAwaitingUserReply('Analisei o projeto.\n\nQuais itens quer que eu ataque agora?'), true);
});

test('lista numerada de perguntas (caso real do bug) conta como pergunta', () => {
  const text = `Diga-me:\n\n1. **Quais itens** quer que eu ataque agora?\n2. Quer que eu faça num **branch separado** e abra **Pull Request**, ou commit direto na main?\n3. Tem alguma correção ou melhoria **específica** que não estava na análise mas você quer que eu inclua?`;
  assert.equal(endsAwaitingUserReply(text), true);
});

test('pergunta com enfeite de markdown no fechamento conta', () => {
  assert.equal(endsAwaitingUserReply('Posso seguir com a opção B?**'), true);
  assert.equal(endsAwaitingUserReply('_Prefere XLSX ou CSV?_'), true);
  assert.equal(endsAwaitingUserReply('(Continuo?)'), true);
});

test('pergunta retórica no MEIO seguida de conclusão NÃO conta', () => {
  assert.equal(endsAwaitingUserReply('E o que isso significa? Significa que o total está correto. Tarefa concluída.'), false);
});

test('resposta afirmativa comum não conta', () => {
  assert.equal(endsAwaitingUserReply('Pronto! O arquivo foi gerado em outputs/relatorio.xlsx.'), false);
});

test('vazio/nulo não conta', () => {
  assert.equal(endsAwaitingUserReply(''), false);
  assert.equal(endsAwaitingUserReply(null), false);
  assert.equal(endsAwaitingUserReply('   \n  '), false);
});

test('aviso padronizado do sistema anexado após a pergunta não esconde a pergunta', () => {
  assert.equal(endsAwaitingUserReply(`Prefere que eu use qual formato?${MISSING_OUTPUT_NOTICE}`), true);
});
