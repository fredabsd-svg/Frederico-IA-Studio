import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/frederico-subagent-tests';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';

const {
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_NAME,
  buildDelegationContext,
  buildSubagentTask,
  canLaunchDelegationsInParallel,
  createSubagentLimiter,
  intersectToolDefinitions,
  maxParallelSubagents,
  maxSubagentsPerRun,
  runSubagent,
  shouldNudgeSubagent,
  subagentNudgeStep,
  SUBAGENT_NUDGE_NOTE,
  shouldOfferSubagentTool,
  subagentEffort,
  subagentEventForwarder,
  subagentToolDefinition,
  subagentToolDefinitionFor,
  summarizeSubagentResult
} = await import('./subagents.js');
const { sandboxPolicy } = await import('../sandbox.js');

const toolDef = (name) => ({ type: 'function', function: { name } });

// ---- Guard-rail 1: quando a delegação é oferecida ----

test('oferece a delegação numa execução normal com ferramentas', () => {
  assert.equal(shouldOfferSubagentTool({ depth: 0, hasTools: true, providerSource: 'user' }), true);
});

test('NÃO oferece delegação dentro de um sub-agente (sem cascata)', () => {
  assert.equal(shouldOfferSubagentTool({ depth: MAX_SUBAGENT_DEPTH, hasTools: true }), false);
});

test('NÃO oferece delegação no modo gratuito, em turno social ou sem ferramentas', () => {
  assert.equal(shouldOfferSubagentTool({ depth: 0, hasTools: true, providerSource: 'free' }), false);
  assert.equal(shouldOfferSubagentTool({ depth: 0, hasTools: true, lowSignalTurn: true }), false);
  assert.equal(shouldOfferSubagentTool({ depth: 0, hasTools: false }), false);
});

test('SUBAGENTS_ENABLED=false desliga a delegação sem tocar no código', () => {
  const previous = process.env.SUBAGENTS_ENABLED;
  process.env.SUBAGENTS_ENABLED = 'false';
  try { assert.equal(shouldOfferSubagentTool({ depth: 0, hasTools: true }), false); }
  finally { if (previous === undefined) delete process.env.SUBAGENTS_ENABLED; else process.env.SUBAGENTS_ENABLED = previous; }
});

// ---- Guard-rail 2: recursão bloqueada mesmo se a ferramenta escapar ----

test('runSubagent recusa delegar quando já está na profundidade máxima', async () => {
  let chamou = false;
  const { result, usage } = await runSubagent({
    userId: 'u', conversationId: 'c', args: { tarefa: 'qualquer coisa' },
    depth: MAX_SUBAGENT_DEPTH, onEvent: () => {},
    runner: async () => { chamou = true; return { text: 'ok' }; }
  });
  assert.equal(chamou, false, 'não podia ter chamado o runAgent');
  assert.equal(JSON.parse(result).code, 'SUBAGENT_DEPTH');
  assert.equal(usage, null);
});

test('runSubagent recusa tarefa vazia', async () => {
  const { result } = await runSubagent({
    userId: 'u', conversationId: 'c', args: { tarefa: '   ' }, depth: 0, onEvent: () => {},
    runner: async () => { throw new Error('não deveria rodar'); }
  });
  assert.equal(JSON.parse(result).code, 'SUBAGENT_EMPTY_TASK');
});

// ---- Guard-rail 3: o que o filho recebe do pai ----

test('runSubagent roda o filho isolado: sem persistir, um nível abaixo e sem escrita no GitHub', async () => {
  let recebido = null;
  await runSubagent({
    userId: 'u', conversationId: 'c',
    args: { tarefa: 'analisar o balancete', entregar: 'um resumo' },
    model: 'openai/gpt-4o', effort: 'max', depth: 0, onEvent: () => {},
    runner: async (params) => { recebido = params; return { text: 'pronto', usage: { total_tokens: 10 } }; }
  });
  assert.equal(recebido.conversationId, 'c', 'compartilha o workspace da conversa');
  assert.equal(recebido.subagentDepth, 1);
  assert.equal(recebido.persistReply, false);
  assert.equal(recebido.saveUserMessage, false);
  assert.equal(recebido.gitWriteAuthorization, false);
  // Esforço do pai é limitado para a subtarefa não virar uma segunda execução.
  assert.equal(recebido.effort, 'alto');
  assert.match(recebido.userText, /analisar o balancete/);
  assert.match(recebido.userText, /ENTREGUE AO FINAL: um resumo/);
});

test('subagentEffort limita os esforços altos e preserva os demais', () => {
  assert.equal(subagentEffort('max'), 'alto');
  assert.equal(subagentEffort('extra'), 'alto');
  assert.equal(subagentEffort('baixo'), 'baixo');
  assert.equal(subagentEffort(undefined), 'medio');
});

test('buildSubagentTask deixa explícito que o sub-agente não vê a conversa', () => {
  const texto = buildSubagentTask({ tarefa: 'somar a coluna C' });
  assert.match(texto, /somar a coluna C/);
  assert.match(texto, /não vê o histórico/i);
  assert.match(texto, /ENTREGUE AO FINAL/);
});

// ---- Guard-rail 4: parar propaga e a usage é devolvida ao pai ----

test('runSubagent devolve a usage do filho e sinaliza a parada do usuário', async () => {
  const { usage, stopped, result } = await runSubagent({
    userId: 'u', conversationId: 'c', args: { tarefa: 'x' }, depth: 0, onEvent: () => {},
    runner: async () => ({ text: 'parcial', stopped: true, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
  });
  assert.equal(stopped, true);
  assert.deepEqual(usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.equal(JSON.parse(result).code, 'CANCELED');
});

test('runSubagent transforma exceção do filho em resultado de ferramenta', async () => {
  const { result } = await runSubagent({
    userId: 'u', conversationId: 'c', args: { tarefa: 'x' }, depth: 0, onEvent: () => {},
    runner: async () => { throw new Error('provedor fora do ar'); }
  });
  const payload = JSON.parse(result);
  assert.equal(payload.code, 'SUBAGENT_ERROR');
  assert.match(payload.error, /provedor fora do ar/);
});

// ---- O que volta para o contexto do pai ----

test('summarizeSubagentResult devolve só o resultado, com os arquivos gerados', () => {
  const payload = summarizeSubagentResult(
    { text: 'Total apurado: R$ 1.200,00', files: [{ path: 'outputs/apuracao.xlsx' }] },
    { especialista: 'Fiscal' }
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.especialista, 'Fiscal');
  assert.equal(payload.resultado, 'Total apurado: R$ 1.200,00');
  assert.deepEqual(payload.arquivos, ['outputs/apuracao.xlsx']);
});

test('summarizeSubagentResult trunca resultado longo e marca subtarefa incompleta', () => {
  const longo = summarizeSubagentResult({ text: 'x'.repeat(50) }, { limit: 1000 });
  assert.equal(longo.resultado.length, 50, 'abaixo do limite não trunca');
  const cortado = summarizeSubagentResult({ text: 'x'.repeat(5000) }, { limit: 1000 });
  assert.match(cortado.resultado, /\[resultado truncado\]$/);

  const falhou = summarizeSubagentResult({ text: 'não deu', incomplete: true, failureMessage: 'faltou o arquivo' });
  assert.equal(falhou.ok, false);
  assert.equal(falhou.code, 'SUBAGENT_INCOMPLETE');
  assert.equal(falhou.error, 'faltou o arquivo');
});

// ---- Stream: o texto do filho não pode vazar na resposta do pai ----

test('subagentEventForwarder prefixa o id da chamada com o da delegação', () => {
  // Com duas delegações em paralelo, os ids de ferramenta dos dois filhos podem
  // coincidir (cada provedor numera do seu jeito). Sem o prefixo, a interface
  // fecharia o cartão da delegação errada.
  const vistos = [];
  const forwardA = subagentEventForwarder(ev => vistos.push(ev), 'Fiscal', 'call_a');
  const forwardB = subagentEventForwarder(ev => vistos.push(ev), 'Contábil', 'call_b');
  forwardA({ type: 'tool_start', id: 'call_1', name: 'bash' });
  forwardB({ type: 'tool_start', id: 'call_1', name: 'bash' });
  assert.deepEqual(vistos.map(ev => ev.id), ['call_a:call_1', 'call_b:call_1']);
  assert.deepEqual(vistos.map(ev => ev.parentId), ['call_a', 'call_b']);
});

test('subagentEventForwarder repassa ferramentas e bloqueia o texto do sub-agente', () => {
  const vistos = [];
  const forward = subagentEventForwarder(ev => vistos.push(ev), 'Fiscal');
  forward({ type: 'delta', content: 'texto interno do sub-agente' });
  forward({ type: 'saved', assistantMessageId: 'm1' });
  forward({ type: 'execution_state', state: 'analyzing' });
  forward({ type: 'resumable', value: true });
  forward({ type: 'tool_start', name: 'run_python' });
  forward({ type: 'tool_result', name: 'run_python', content: '{}' });

  assert.deepEqual(vistos.map(ev => ev.type), ['tool_start', 'tool_result']);
  assert.ok(vistos.every(ev => ev.subagent === 'Fiscal'), 'eventos do filho vão etiquetados');
});

// ---- Teto por execução ----

test('maxSubagentsPerRun tem padrão seguro e respeita o teto absoluto', () => {
  const previous = process.env.SUBAGENT_MAX_PER_RUN;
  try {
    delete process.env.SUBAGENT_MAX_PER_RUN;
    assert.equal(maxSubagentsPerRun(), 4);
    process.env.SUBAGENT_MAX_PER_RUN = '2';
    assert.equal(maxSubagentsPerRun(), 2);
    process.env.SUBAGENT_MAX_PER_RUN = '999';
    assert.equal(maxSubagentsPerRun(), 10, 'nunca acima de 10 delegações por execução');
    process.env.SUBAGENT_MAX_PER_RUN = 'abc';
    assert.equal(maxSubagentsPerRun(), 4);
  } finally {
    if (previous === undefined) delete process.env.SUBAGENT_MAX_PER_RUN; else process.env.SUBAGENT_MAX_PER_RUN = previous;
  }
});

// ---- Paralelismo entre delegações do mesmo lote ----

test('createSubagentLimiter roda em paralelo até o teto e enfileira o resto', async () => {
  const limitar = createSubagentLimiter(2);
  const iniciadas = [];
  let ativas = 0;
  let pico = 0;
  const resolvers = new Map();
  const tarefa = (n) => () => new Promise(resolve => {
    iniciadas.push(n);
    ativas += 1;
    pico = Math.max(pico, ativas);
    resolvers.set(n, () => { ativas -= 1; resolve(n); });
  });

  const promessas = [limitar(tarefa(1)), limitar(tarefa(2)), limitar(tarefa(3))];
  await new Promise(setImmediate);
  assert.deepEqual(iniciadas, [1, 2], 'só duas delegações começam de imediato');

  resolvers.get(1)();                        // libera a primeira vaga
  await new Promise(setImmediate);
  assert.deepEqual(iniciadas, [1, 2, 3], 'a terceira começou ao abrir vaga');
  assert.equal(pico, 2, 'nunca passou do teto de simultâneas');

  resolvers.get(2)();
  resolvers.get(3)();
  assert.deepEqual(await Promise.all(promessas), [1, 2, 3]);
});

test('createSubagentLimiter não trava a fila quando uma delegação falha', async () => {
  const limitar = createSubagentLimiter(1);
  const falha = limitar(() => Promise.reject(new Error('quebrou')));
  const depois = limitar(() => Promise.resolve('seguiu'));
  await assert.rejects(falha, /quebrou/);
  assert.equal(await depois, 'seguiu');
});

test('maxParallelSubagents tem padrão conservador e teto absoluto', () => {
  const previous = process.env.SUBAGENT_MAX_PARALLEL;
  try {
    delete process.env.SUBAGENT_MAX_PARALLEL;
    assert.equal(maxParallelSubagents(), 2);
    process.env.SUBAGENT_MAX_PARALLEL = '3';
    assert.equal(maxParallelSubagents(), 3);
    process.env.SUBAGENT_MAX_PARALLEL = '50';
    assert.equal(maxParallelSubagents(), 4, 'nunca acima de 4 delegações simultâneas');
    process.env.SUBAGENT_MAX_PARALLEL = '0';
    assert.equal(maxParallelSubagents(), 2);
  } finally {
    if (previous === undefined) delete process.env.SUBAGENT_MAX_PARALLEL; else process.env.SUBAGENT_MAX_PARALLEL = previous;
  }
});

test('a definição da ferramenta exige a tarefa e avisa que o filho não vê a conversa', () => {
  assert.equal(subagentToolDefinition.function.name, SUBAGENT_TOOL_NAME);
  assert.deepEqual(subagentToolDefinition.function.parameters.required, ['tarefa']);
  assert.match(subagentToolDefinition.function.description, /NÃO vê esta conversa/i);
});

// ---- Limitador: o teto precisa valer com fila de verdade (P0-05) ----

test('createSubagentLimiter nunca ultrapassa o teto com MAIS tarefas do que vagas', async () => {
  // Reprodução do defeito do Promise.race: com duas tarefas esperando a MESMA
  // corrida, a conclusão de uma liberava as duas — pico 3 com limite 2.
  const limitar = createSubagentLimiter(2);
  const iniciadas = [];
  let ativas = 0;
  let pico = 0;
  const resolvers = new Map();
  const tarefa = (n) => () => new Promise(resolve => {
    iniciadas.push(n);
    ativas += 1;
    pico = Math.max(pico, ativas);
    resolvers.set(n, () => { ativas -= 1; resolve(n); });
  });

  const promessas = [1, 2, 3, 4, 5].map(n => limitar(tarefa(n)));
  await new Promise(setImmediate);
  assert.deepEqual(iniciadas, [1, 2]);

  resolvers.get(1)();
  await new Promise(setImmediate);
  assert.deepEqual(iniciadas, [1, 2, 3], 'uma vaga livre solta UMA tarefa, não a fila inteira');
  assert.equal(pico, 2);

  resolvers.get(2)();
  await new Promise(setImmediate);
  assert.deepEqual(iniciadas, [1, 2, 3, 4]);
  assert.equal(pico, 2);

  resolvers.get(3)();
  await new Promise(setImmediate);
  resolvers.get(4)();
  resolvers.get(5)();
  assert.deepEqual(await Promise.all(promessas), [1, 2, 3, 4, 5]);
  assert.equal(pico, 2, 'nunca passou do teto em nenhum momento');
});

test('createSubagentLimiter devolve a vaga quando a tarefa lança de forma síncrona', async () => {
  const limitar = createSubagentLimiter(1);
  await assert.rejects(limitar(() => { throw new Error('estourou antes de virar promessa'); }), /estourou/);
  assert.equal(await limitar(() => Promise.resolve('a fila seguiu')), 'a fila seguiu');
});

// ---- Ordem: paralelizar só lote homogêneo (P0-06) ----

test('só paraleliza quando o lote é SÓ de delegações', () => {
  assert.equal(canLaunchDelegationsInParallel([SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAME]), true);
  // write_file criando o arquivo + delegação para revisá-lo: o filho não pode
  // partir antes da escrita acontecer.
  assert.equal(canLaunchDelegationsInParallel(['write_file', SUBAGENT_TOOL_NAME]), false);
  assert.equal(canLaunchDelegationsInParallel([SUBAGENT_TOOL_NAME, 'bash']), false);
  assert.equal(canLaunchDelegationsInParallel(['bash']), false);
  assert.equal(canLaunchDelegationsInParallel([]), false);
});

// ---- DelegationContext: a fronteira de autorização (P0-01, P0-02, P0-03) ----

test('o filho não pode ganhar ferramenta que o pai não tinha', () => {
  const contexto = buildDelegationContext({ toolNames: ['read_file', 'list_files'] });
  // O especialista escolhido é um assistente com poderes MAIORES; a interseção
  // com o pai é o que vale.
  const doEspecialista = ['read_file', 'list_files', 'bash', 'run_python', 'write_file'].map(toolDef);
  const efetivas = intersectToolDefinitions(doEspecialista, contexto.allowedToolNames)
    .map(tool => tool.function.name);
  assert.deepEqual(efetivas, ['read_file', 'list_files']);
});

test('a delegação não se propaga: a própria ferramenta sai da herança', () => {
  const contexto = buildDelegationContext({ toolNames: ['bash', SUBAGENT_TOOL_NAME, 'bash'] });
  assert.deepEqual(contexto.allowedToolNames, ['bash']);
});

test('sem lista herdada, a interseção não inventa restrição', () => {
  const tools = ['bash'].map(toolDef);
  assert.deepEqual(intersectToolDefinitions(tools, null), tools);
});

test('rede, escrita no PC e escrita no GitHub vêm do pai — e o contexto é imutável', () => {
  const contexto = buildDelegationContext({
    toolNames: ['bash'],
    networkEnabled: true,
    pcWriteAuthorized: true,
    sandboxOptions: { readOnlyPc: false, writablePcFolderId: 'pasta-1', networkEnabled: true, userId: 'u' }
  });
  assert.equal(contexto.networkEnabled, true);
  assert.equal(contexto.pcWriteAuthorized, true);
  assert.equal(contexto.gitWriteAuthorized, false, 'escrita no GitHub nunca se herda');
  // Congelado de propósito: nada no caminho da subtarefa pode reescrever isto.
  assert.equal(Object.isFrozen(contexto), true);
  assert.equal(Object.isFrozen(contexto.sandboxOptions), true);
  assert.throws(() => { 'use strict'; contexto.networkEnabled = false; }, TypeError);
});

test('a política de sandbox do filho é IDÊNTICA à do pai, mesmo com outro modelo', () => {
  // Era isto que reciclava o container no meio da execução: pai em
  // `write:<projeto>`, filho em `read-only`, cada um derrubando o do outro.
  const doPai = { readOnlyPc: false, writablePcFolderId: 'projeto-x', networkEnabled: true, userId: 'u', model: 'openai/gpt-4o' };
  const contexto = buildDelegationContext({ sandboxOptions: doPai });
  const doFilho = { ...contexto.sandboxOptions, model: 'deepseek::deepseek-chat' };
  assert.equal(sandboxPolicy(doFilho).key, sandboxPolicy(doPai).key);
  assert.equal(sandboxPolicy(doFilho).key, 'write:projeto-x|network:on');
});

test('runSubagent repassa o contexto de delegação e o perfil do pai ao filho', async () => {
  const contexto = buildDelegationContext({
    assistant: { id: 'a1', name: 'Perfil do pai', tools: ['read_file'] },
    toolNames: ['read_file']
  });
  let recebido = null;
  await runSubagent({
    userId: 'u', conversationId: 'c', args: { tarefa: 'conferir a nota' },
    depth: 0, onEvent: () => {}, delegation: contexto,
    runner: async (params) => { recebido = params; return { text: 'ok' }; }
  });
  assert.equal(recebido.delegation, contexto, 'o mesmo objeto congelado chega ao filho');
  // Sem especialista pedido, o filho herda o PERFIL do pai — não o assistente
  // padrão com o conjunto de ferramentas inteiro.
  assert.equal(recebido.assistant.name, 'Perfil do pai');
});

// ---- Especialistas: inventário real e nada de fallback silencioso (P1-01, P1-02) ----

test('a definição leva o inventário de especialistas como enum de ids', () => {
  const definicao = subagentToolDefinitionFor([
    { id: 'asst_1', name: 'Fiscal' },
    { id: 'asst_2', name: 'Contábil' }
  ]);
  const campo = definicao.function.parameters.properties.especialista_id;
  assert.deepEqual(campo.enum, ['asst_1', 'asst_2']);
  assert.match(campo.description, /asst_1 = Fiscal/);
  assert.match(campo.description, /asst_2 = Contábil/);
});

test('sem assistentes cadastrados, o campo de especialista nem é oferecido', () => {
  assert.equal('especialista_id' in subagentToolDefinitionFor([]).function.parameters.properties, false);
});

test('especialista inexistente RECUSA a delegação em vez de trocar em silêncio', async () => {
  let chamou = false;
  const { result } = await runSubagent({
    userId: 'u', conversationId: 'c',
    args: { tarefa: 'apurar o ICMS', especialista_id: 'Fiscal' },   // nome inventado pelo modelo
    depth: 0, onEvent: () => {},
    runner: async () => { chamou = true; return { text: 'ok' }; }
  });
  assert.equal(chamou, false, 'não podia ter rodado o assistente padrão no lugar');
  const payload = JSON.parse(result);
  assert.equal(payload.code, 'SUBAGENT_SPECIALIST_NOT_FOUND');
  assert.match(payload.error, /Fiscal/);
});

test('o resultado diz QUEM executou — especialista e modelo', () => {
  const payload = summarizeSubagentResult({ text: 'feito' }, { especialista: 'Fiscal', modelo: 'openai/gpt-4o' });
  assert.equal(payload.especialista, 'Fiscal');
  assert.equal(payload.modelo, 'openai/gpt-4o');
});

// ---- Truncamento da subtarefa: declarado, nunca silencioso (P2-01) ----

test('subtarefa longa é cortada COM aviso ao sub-agente', () => {
  const curta = buildSubagentTask({ tarefa: 'somar a coluna C' });
  assert.doesNotMatch(curta, /TAREFA TRUNCADA/);

  const longa = buildSubagentTask({ tarefa: `${'x'.repeat(6000)} NÃO ARREDONDE PARA CIMA` });
  assert.match(longa, /\[TAREFA TRUNCADA/);
  assert.doesNotMatch(longa, /NÃO ARREDONDE/, 'a regra final realmente se perdeu — por isso o aviso');
});

// ---- Acionamento: o gatilho positivo e o lembrete por etapas ----
//
// Os guard-rails acima só sabiam dizer NÃO. O que faltava — e é o que estes
// testes protegem — era o que faz a delegação de fato acontecer.

test('a descrição da ferramenta traz o gatilho de várias entregas independentes', () => {
  const description = subagentToolDefinitionFor([]).function.description;
  assert.match(description, /TRÊS OU MAIS entregas independentes/i);
  assert.match(description, /UMA chamada por entrega/i);
  // A contrapartida precisa continuar explícita: delegar não é para tudo.
  assert.match(description, /integração final/i);
});

test('o lembrete entra ao passar do limiar sem nenhuma delegação', () => {
  assert.equal(shouldNudgeSubagent({ step: 15, offered: true, threshold: 15 }), true);
  assert.equal(shouldNudgeSubagent({ step: 14, offered: true, threshold: 15 }), false);
});

test('o lembrete não se repete e não incomoda quem já delegou', () => {
  assert.equal(shouldNudgeSubagent({ step: 40, offered: true, threshold: 15, alreadyNudged: true }), false);
  assert.equal(shouldNudgeSubagent({ step: 40, offered: true, threshold: 15, delegations: 1 }), false);
});

test('sem a ferramenta na mesa (ou sem orçamento) o lembrete não entra', () => {
  // Pedir o que o modelo não pode fazer é pior que ficar calado.
  assert.equal(shouldNudgeSubagent({ step: 40, offered: false, threshold: 15 }), false);
  assert.equal(shouldNudgeSubagent({ step: 40, offered: true, threshold: 15, delegations: 0, budget: 0 }), false);
});

test('SUBAGENT_NUDGE_STEPS ajusta o limiar e 0 desliga só o lembrete', () => {
  const previous = process.env.SUBAGENT_NUDGE_STEPS;
  try {
    delete process.env.SUBAGENT_NUDGE_STEPS;
    assert.equal(subagentNudgeStep(), 15);
    process.env.SUBAGENT_NUDGE_STEPS = '25';
    assert.equal(subagentNudgeStep(), 25);
    process.env.SUBAGENT_NUDGE_STEPS = '0';
    assert.equal(subagentNudgeStep(), 0);
    // Limiar desligado: nem no passo 999 a nota entra — mas a ferramenta segue
    // oferecida (é o lembrete que some, não a delegação).
    assert.equal(shouldNudgeSubagent({ step: 999, offered: true }), false);
    assert.equal(shouldOfferSubagentTool({ depth: 0, hasTools: true }), true);
  } finally {
    if (previous === undefined) delete process.env.SUBAGENT_NUDGE_STEPS; else process.env.SUBAGENT_NUDGE_STEPS = previous;
  }
});

test('o lembrete oferece uma saída explícita para não forçar delegação ruim', () => {
  assert.match(SUBAGENT_NUDGE_NOTE, /delegar_subagente/);
  assert.match(SUBAGENT_NUDGE_NOTE, /ignore este lembrete/i);
});
