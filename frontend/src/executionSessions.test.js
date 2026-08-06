// Sessões de execução: a fonte única lida pelo terminal inferior, pela linha
// compacta do histórico e pelo overlay.
// Roda com: node --test src/executionSessions.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeExecutionSession,
  collectExecutionSessions,
  formatDuration,
  pendingInputRequest,
  pickTerminalSession,
  sessionSummaryLine,
  summarizeSession,
  terminalStatus
} from './executionSessions.js';

const tool = (over = {}) => ({ type: 'tool', name: 'bash', status: 'done', started: 1000, ended: 3000, ...over });
const assistant = (over = {}) => ({ role: 'assistant', content: '', blocks: [], ...over });

test('mensagem sem ferramenta não gera sessão', () => {
  const messages = [{ role: 'user', content: 'oi' }, assistant({ id: 'a', content: 'ola' })];
  assert.deepEqual(collectExecutionSessions(messages), []);
});

test('cada resposta com ferramentas vira uma sessão, na ordem da conversa', () => {
  const messages = [
    { role: 'user', content: 'faz' },
    assistant({ _key: 'm1', blocks: [{ type: 'text', content: 'ok' }, tool({ id: 't1' })] }),
    { role: 'user', content: 'de novo' },
    assistant({ _key: 'm2', blocks: [tool({ id: 't2' }), tool({ id: 't3', name: 'write_file' })] })
  ];
  const sessions = collectExecutionSessions(messages);
  assert.deepEqual(sessions.map(s => s.id), ['m1', 'm2']);
  assert.deepEqual(sessions.map(s => s.steps.length), [1, 2]);
  assert.equal(sessions.every(s => s.live === false), true);
});

test('a identidade da sessão usa _key (o id troca no meio do streaming)', () => {
  const antes = collectExecutionSessions([assistant({ _key: 'local-1', id: 'local-1', blocks: [tool({ status: 'running' })] })]);
  const depois = collectExecutionSessions([assistant({ _key: 'local-1', id: 'msg_do_banco', blocks: [tool({ status: 'running' })] })]);
  assert.equal(antes[0].id, depois[0].id, 'o evento saved não pode trocar a sessão do terminal');
});

test('sessão com etapa rodando está ao vivo; a última também, se a conversa processa', () => {
  const rodando = collectExecutionSessions([assistant({ _key: 'm1', blocks: [tool({ status: 'running' })] })]);
  assert.equal(rodando[0].live, true);

  const messages = [assistant({ _key: 'm1', blocks: [tool()] }), assistant({ _key: 'm2', blocks: [tool()] })];
  const comBusy = collectExecutionSessions(messages, { busy: true });
  assert.deepEqual(comBusy.map(s => s.live), [false, true]);
  const semBusy = collectExecutionSessions(messages, { busy: false });
  assert.deepEqual(semBusy.map(s => s.live), [false, false]);
});

test('a sessão do terminal é a que está ao vivo; senão a última', () => {
  const sessions = [
    { id: 'a', live: false }, { id: 'b', live: false }, { id: 'c', live: true }
  ];
  assert.equal(activeExecutionSession(sessions).id, 'c');
  assert.equal(activeExecutionSession(sessions.slice(0, 2)).id, 'b');
  assert.equal(activeExecutionSession([]), null);
});

test('a sessão fixada pelo usuário é respeitada, mas execução AO VIVO tem precedência', () => {
  const historicas = [{ id: 'a', live: false }, { id: 'b', live: false }];
  assert.equal(pickTerminalSession(historicas, 'a').id, 'a');
  // Fixada que não existe mais (conversa recarregada): cai na ativa.
  assert.equal(pickTerminalSession(historicas, 'sumiu').id, 'b');
  const comAoVivo = [...historicas, { id: 'c', live: true }];
  assert.equal(pickTerminalSession(comAoVivo, 'a').id, 'c');
});

test('duração é legível em segundos e em minutos', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(4200), '4s');
  assert.equal(formatDuration(60000), '1min');
  assert.equal(formatDuration(635000), '10min 35s');
});

test('o resumo conta por categoria e mede a duração da sessão', () => {
  const steps = [
    tool({ name: 'read_file', started: 1000, ended: 2000 }),
    tool({ name: 'bash', started: 2000, ended: 5000 }),
    tool({ name: 'write_file', started: 5000, ended: 6000 }),
    tool({ name: 'web_search', started: 6000, ended: 7000 }),
    tool({ name: 'delegar_subagente', started: 7000, ended: 8000 }),
    tool({ name: 'bash', status: 'error', started: 8000, ended: 9000 })
  ];
  const sum = summarizeSession(steps, 9000);
  assert.equal(sum.total, 6);
  assert.equal(sum.reads, 1);
  assert.equal(sum.commands, 2, 'dois bash — o que falhou continua sendo um comando executado');
  assert.equal(sum.files, 1);
  assert.equal(sum.searches, 1);
  assert.equal(sum.delegations, 1);
  assert.equal(sum.errors, 1);
  assert.equal(sum.elapsed, '8s');
  assert.equal(sum.running, false);
});

test('com etapa em execução, a duração acompanha o relógio recebido', () => {
  const steps = [tool({ started: 1000, ended: null, status: 'running' })];
  assert.equal(summarizeSession(steps, 5000).elapsed, '4s');
  assert.equal(summarizeSession(steps, 65000).elapsed, '1min 4s');
  assert.equal(summarizeSession(steps, 5000).running, true);
});

test('o status do terminal distingue pergunta, execução, avisos e interrupção', () => {
  assert.equal(terminalStatus({ live: true }).label, 'Executando');
  assert.equal(terminalStatus({ live: true, awaitingUser: true }).label, 'Aguardando resposta');
  assert.equal(terminalStatus({ stopped: true }).label, 'Interrompido');
  assert.equal(terminalStatus({ errors: 2 }).label, 'Concluído com avisos');
  assert.equal(terminalStatus({}).label, 'Concluído');
  // Uma pergunta NUNCA se apresenta como falha.
  assert.notEqual(terminalStatus({ awaitingUser: true }).tone, 'err');
});

test('a linha do histórico resume etapas, arquivos e tempo', () => {
  const sum = summarizeSession([
    tool({ name: 'bash', started: 1000, ended: 636000 }),
    tool({ name: 'write_file', started: 1000, ended: 636000 })
  ], 636000);
  const linha = sessionSummaryLine(sum, { live: false });
  assert.match(linha, /Execução concluíd/i);
  assert.match(linha, /2 etapas/);
  assert.match(linha, /1 arquivo/);
  assert.match(linha, /10min 35s/);
  assert.match(sessionSummaryLine(sum, { live: true }), /em andamento/);
});

// ---- Pergunta pendente -------------------------------------------------------

test('a pergunta da última resposta fica pendente até o usuário responder', () => {
  const request = { id: 'iq_1', kind: 'confirm', question: 'Publico?' };
  const pendente = pendingInputRequest([
    { role: 'user', content: 'faz' },
    assistant({ _key: 'm1', execution: { state: 'awaiting_user', inputRequest: request } })
  ]);
  assert.equal(pendente.request.id, 'iq_1');
  assert.equal(pendente.resolved, false);
  assert.equal(pendente.messageId, 'm1');
});

test('mensagem posterior do usuário marca a pergunta como resolvida', () => {
  const request = { id: 'iq_1', kind: 'text', question: 'Qual formato?' };
  const resolvida = pendingInputRequest([
    assistant({ _key: 'm1', execution: { state: 'awaiting_user', inputRequest: request } }),
    { role: 'user', content: 'XLSX' },
    assistant({ _key: 'm2', content: 'Pronto.' })
  ]);
  assert.equal(resolvida.resolved, true);
});

test('sem pergunta nenhuma, devolve null', () => {
  assert.equal(pendingInputRequest([assistant({ _key: 'm1', content: 'ok' })]), null);
  assert.equal(pendingInputRequest([]), null);
  assert.equal(pendingInputRequest(null), null);
});

test('a pergunta considerada é a MAIS RECENTE (não a de um turno antigo)', () => {
  const antiga = { id: 'iq_antiga', kind: 'text', question: 'Antiga?' };
  const nova = { id: 'iq_nova', kind: 'text', question: 'Nova?' };
  const pendente = pendingInputRequest([
    assistant({ _key: 'm1', execution: { state: 'awaiting_user', inputRequest: antiga } }),
    { role: 'user', content: 'respondi' },
    assistant({ _key: 'm2', execution: { state: 'awaiting_user', inputRequest: nova } })
  ]);
  assert.equal(pendente.request.id, 'iq_nova');
  assert.equal(pendente.resolved, false);
});
