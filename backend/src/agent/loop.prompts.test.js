// Montagem das mensagens do loop (runAgent) — revisão de prompts 2026-09.
//
// O runAgent inteiro depende de banco, provedor e sandbox; os contratos daqui
// moram em funções PURAS exportadas pelo loop, e a fiação entre elas e o loop é
// guardada por um teste de fonte (mesmo recurso do teste de fiação do orçamento
// em subagents.test.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/frederico-loop-prompts-tests';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';

const { conversationTailMessages, noToolsReason, webSearchNote } = await import('./loop.js');
const { runSubagent } = await import('./subagents.js');
const { webResearchFinalizationNote } = await import('./webResearch.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const loopSource = readFileSync(path.join(here, 'loop.js'), 'utf8');

// ---- 1. O sub-agente recebe a própria tarefa --------------------------------

test('sub-agente recebe a subtarefa como mensagem do usuário (sem histórico)', () => {
  const tail = conversationTailMessages({
    isSubagent: true,
    history: [{ role: 'user', content: 'mensagem antiga da conversa' }],
    userText: 'Some a coluna B de /workspace/uploads/a.xlsx'
  });
  assert.deepEqual(tail, [{ role: 'user', content: 'Some a coluna B de /workspace/uploads/a.xlsx' }]);
});

test('agente principal segue recebendo o histórico, sem a tarefa duplicada', () => {
  const tail = conversationTailMessages({
    isSubagent: false,
    history: [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'faça a planilha' }
    ],
    userText: 'faça a planilha'
  });
  assert.deepEqual(tail.map(m => m.content), ['oi', 'faça a planilha']);
});

test('a tarefa escrita pelo pai chega às mensagens do filho (runSubagent → loop)', async () => {
  // O runner falso captura o que o runAgent receberia; as mensagens do filho
  // são montadas pela MESMA função que o loop usa.
  let childMessages = null;
  const runner = async (params) => {
    childMessages = conversationTailMessages({ isSubagent: params.subagentDepth > 0, history: [], userText: params.userText });
    return { text: 'feito', usage: null };
  };
  await runSubagent({
    userId: 'u', conversationId: 'c', args: { tarefa: 'Conferir os totais do balancete de março', entregar: 'a diferença em R$' },
    model: 'm', control: null, onEvent: () => {}, runner, delegationId: 'd1'
  });
  assert.ok(childMessages, 'o runner deveria ter sido chamado');
  assert.equal(childMessages.length, 1);
  assert.equal(childMessages[0].role, 'user');
  assert.match(childMessages[0].content, /Conferir os totais do balancete de março/);
  assert.match(childMessages[0].content, /ENTREGUE AO FINAL: a diferença em R\$/);
});

test('o loop monta a cauda das mensagens pela função testada', () => {
  assert.match(loopSource, /conversationTailMessages\(\{ isSubagent, history: historyPlan\.rows, userText \}\)/);
});

// ---- 2. Regras de projeto do usuário não são "dado não confiável" ------------

test('o loop manda as regras de projeto no envelope do usuário, não como untrusted', () => {
  assert.doesNotMatch(loopSource, /untrustedContext\('project-rules'/);
  assert.match(loopSource, /userProjectRulesBlock\(developerContext\?\.userRules\)/);
});

// ---- 4. Motivo real da ausência de ferramentas -------------------------------

test('motivo sem ferramentas: turno social, modelo sem tool calling ou configuração', () => {
  assert.equal(noToolsReason({ lowSignalTurn: true, requestedToolCount: 0 }), 'greeting');
  // Assistente com ferramentas + modelo que não as aceita = motivo é o MODELO.
  assert.equal(noToolsReason({ requestedToolCount: 5, plannedToolCount: 0 }), 'model');
  assert.equal(noToolsReason({ requestedToolCount: 5, plannedToolCount: 5, toolFallbackApplied: true }), 'model');
  // Nada pedido, nada oferecido: configuração do assistente.
  assert.equal(noToolsReason({ requestedToolCount: 0, plannedToolCount: 0 }), 'config');
  // Pesquisa encerrada num assistente que só tinha as ferramentas web: o plano
  // tinha ferramentas, então não é culpa do modelo.
  assert.equal(noToolsReason({ requestedToolCount: 2, plannedToolCount: 2 }), 'config');
});

test('todas as reconstruções da nota de ferramentas passam pelo mesmo montador', () => {
  // Antes eram quatro chamadas com opções diferentes (o inventário sumia no meio
  // do run e o motivo nunca era informado).
  const direct = loopSource.match(/toolAvailabilityNote\(/g) || [];
  assert.equal(direct.length, 1, 'só o montador `toolNoteFor` chama toolAvailabilityNote');
  assert.match(loopSource, /toolNoteFor\(tools, \{ fallback: true \}\)/);
});

// ---- 13. Notas citam só ferramentas presentes --------------------------------

test('nota de pesquisa web só cita consultar_cnpj quando ele está na chamada', () => {
  assert.match(webSearchNote(['web_search', 'web_fetch', 'consultar_cnpj']), /consultar_cnpj/);
  assert.doesNotMatch(webSearchNote(['web_search', 'web_fetch']), /consultar_cnpj/);
});

test('fim da pesquisa web só manda gerar arquivo com run_python quando há run_python', () => {
  const comPython = webResearchFinalizationNote('limite', ['run_python', 'consultar_cnpj']);
  assert.match(comPython, /GERE o arquivo agora com run_python/);
  const semPython = webResearchFinalizationNote('limite', ['consultar_cnpj']);
  assert.doesNotMatch(semPython, /run_python/);
  assert.match(semPython, /não há ferramenta para gerar arquivo/);
  // Chamada antiga (sem lista) mantém o comportamento anterior.
  assert.match(webResearchFinalizationNote('limite'), /run_python/);
});

test('o loop passa as ferramentas restantes para a nota de fim de pesquisa', () => {
  const calls = loopSource.match(/webResearchFinalizationNote\(webResearchStop, tools\.map\(tool => tool\.function\.name\)\)/g) || [];
  assert.equal(calls.length, 2);
});

// ---- 14. Troca de modelo reescreve a nota de elementos visuais ---------------

test('a troca de modelo reescreve a nota visual e reanexa as figuras do Docling', () => {
  const activate = loopSource.slice(loopSource.indexOf('const activateModel = (nextModel) =>'), loopSource.indexOf('const activateNextFallback'));
  assert.match(activate, /visualElementsNote\(docContext\?\.pictures \|\| \[\], hasVision\)/);
  assert.match(activate, /attachImagesToLastUserMessage\(messages, visualPartsForRun\(\)\)/);
  assert.match(loopSource, /const visualPartsForRun = \(\) => \[\.\.\.imageUploadParts\(userId, conversationId\), \.\.\.doclingImageParts\(/);
});
