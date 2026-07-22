// Testes do mecanismo de checkpoint / retomada real (parte PURA, sem DB nem LLM).
// Roda com: node --test src/agent/checkpoint.test.js
//
// Provam as propriedades estruturais que garantem que a retomada CONTINUA de
// onde parou em vez de recomeçar:
//  - o estado (objetivo, tool_calls, resultados, texto parcial) é preservado;
//  - o array aparado nunca quebra o pareamento tool_call/tool_result;
//  - a semeadura da retomada acrescenta a orientação de "continuar, não repetir";
//  - watchdog e limite de ciclos usam o MESMO mecanismo (isResumableReason).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trimCheckpointMessages,
  buildResumeMessages,
  isResumableReason,
  leadingSystemCount,
  RESUME_CONTINUE_NOTE
} from './checkpoint.js';

// Um array de mensagens de agente realista: preâmbulo + objetivo + turnos com
// ferramentas (assistant.tool_calls seguido do resultado role:'tool') + texto
// parcial final. É o "estado" que o checkpoint precisa preservar.
function sampleMessages() {
  return [
    { role: 'system', content: 'prompt base' },
    { role: 'system', content: 'notas de ferramentas' },
    { role: 'user', content: 'OBJETIVO: gere o relatório trimestral em Excel' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_python', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'planilha_base.xlsx criada' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'outputs/relatorio.xlsx (parcial)' },
    { role: 'assistant', content: 'Já montei a estrutura e as duas primeiras abas. Falta a aba de' }
  ];
}

test('objetivo, ferramentas usadas, resultados e texto parcial são preservados quando cabe no teto', () => {
  const msgs = sampleMessages();
  const out = trimCheckpointMessages(msgs, 1_000_000);
  assert.deepEqual(out, msgs, 'sem exceder o teto, nada é aparado');
  // Objetivo preservado
  assert.ok(out.some(m => m.role === 'user' && /OBJETIVO/.test(m.content)));
  // Ferramentas já executadas e seus resultados preservados (não serão repetidas)
  assert.ok(out.some(m => m.role === 'tool' && /planilha_base/.test(m.content)));
  assert.ok(out.some(m => m.role === 'tool' && /relatorio\.xlsx/.test(m.content)));
  // Texto parcial preservado
  assert.equal(out[out.length - 1].content, 'Já montei a estrutura e as duas primeiras abas. Falta a aba de');
});

test('aparar por tamanho mantício preâmbulo e a cauda recente, sem tool órfã no início', () => {
  // Monta um array grande: preâmbulo + muitos pares assistant/tool volumosos.
  const big = [
    { role: 'system', content: 'prompt base' },
    { role: 'user', content: 'OBJETIVO grande' }
  ];
  for (let i = 0; i < 200; i++) {
    big.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] });
    big.push({ role: 'tool', tool_call_id: `c${i}`, content: 'X'.repeat(5000) });
  }
  const out = trimCheckpointMessages(big, 120_000);
  // Coube no teto
  assert.ok(Buffer.byteLength(JSON.stringify(out), 'utf8') <= 120_000);
  // Preâmbulo de sistema preservado
  assert.equal(out[0].role, 'system');
  // Há uma nota de continuidade sinalizando o trecho omitido
  assert.ok(out.some(m => m.role === 'system' && /omitida por tamanho/.test(m.content)));
  // A cauda NÃO começa por uma mensagem 'tool' órfã (o que a API rejeitaria)
  const firstTail = out.findIndex((m, i) => i > 0 && m.role !== 'system');
  assert.notEqual(out[firstTail].role, 'tool', 'nenhum resultado de ferramenta órfão abre a cauda');
  // Os resultados mais RECENTES sobrevivem (continuidade real)
  assert.ok(out.some(m => m.role === 'tool'));
});

test('nenhuma mensagem tool fica sem o assistant que a originou, após aparo', () => {
  const big = [{ role: 'system', content: 'base' }, { role: 'user', content: 'obj' }];
  for (let i = 0; i < 100; i++) {
    big.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    big.push({ role: 'tool', tool_call_id: `t${i}`, content: 'Y'.repeat(4000) });
  }
  const out = trimCheckpointMessages(big, 80_000);
  // Toda mensagem 'tool' deve ter, em algum ponto ANTES dela, um assistant com
  // tool_calls (não necessariamente adjacente, mas presente na sequência mantida).
  let sawAssistantToolCalls = false;
  for (const m of out) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) sawAssistantToolCalls = true;
    if (m.role === 'tool') assert.ok(sawAssistantToolCalls, 'toda tool tem um assistant.tool_calls antes dela');
  }
});

test('buildResumeMessages adiciona a orientação de CONTINUAR (não recomeçar)', () => {
  const msgs = sampleMessages(); // termina em texto parcial do assistente
  const seeded = buildResumeMessages(msgs, { streamResumeNote: 'CONTINUE DO PONTO EXATO' });
  // Como o último é texto do assistente, entra a nota de "continue de onde parou"
  assert.ok(seeded.some(m => m.role === 'system' && m.content === 'CONTINUE DO PONTO EXATO'));
  // E sempre a nota geral de retomada
  assert.equal(seeded[seeded.length - 1].content, RESUME_CONTINUE_NOTE);
  // O estado original permanece intacto ANTES das notas
  assert.deepEqual(seeded.slice(0, msgs.length), msgs);
});

test('buildResumeMessages: parou após um resultado de ferramenta → sem nota de "continuar texto"', () => {
  const msgs = sampleMessages().slice(0, 7); // termina em role:'tool'
  assert.equal(msgs[msgs.length - 1].role, 'tool');
  const seeded = buildResumeMessages(msgs, { streamResumeNote: 'CONTINUE DO PONTO EXATO' });
  // Não adiciona a nota de continuar-texto (o próximo turno já é natural)
  assert.ok(!seeded.some(m => m.content === 'CONTINUE DO PONTO EXATO'));
  // Mas adiciona a orientação geral de retomada
  assert.equal(seeded[seeded.length - 1].content, RESUME_CONTINUE_NOTE);
});

test('watchdog e limite de ciclos usam o MESMO mecanismo de checkpoint (requisito 8)', () => {
  // Limite de ciclos e falha/stall do provedor (o watchdog cai em provider_failure)
  // e parada do usuário → resumíveis.
  assert.equal(isResumableReason('step_limit'), true);
  assert.equal(isResumableReason('provider_failure'), true);
  assert.equal(isResumableReason('stalled'), true);
  assert.equal(isResumableReason('stopped'), true);
  // Falhas de QUALIDADE NÃO viram checkpoint (reenviar do zero é o certo)
  assert.equal(isResumableReason('degenerate'), false);
  assert.equal(isResumableReason('protocol'), false);
  assert.equal(isResumableReason(null), false);
  assert.equal(isResumableReason(''), false);
});

test('leadingSystemCount localiza o fim do preâmbulo de sistema', () => {
  assert.equal(leadingSystemCount(sampleMessages()), 2);
  assert.equal(leadingSystemCount([{ role: 'user', content: 'x' }]), 0);
  assert.equal(leadingSystemCount([]), 0);
});

test('checkpoint aparado preserva explicitamente o objetivo original', () => {
  const messages = [{ role: 'system', content: 'base' }, { role: 'user', content: 'objetivo que seria removido' }];
  for (let i = 0; i < 80; i++) messages.push({ role: 'assistant', content: `passo ${i} ${'x'.repeat(2500)}` });
  const objective = 'Corrigir o projeto sem publicar no GitHub';
  const trimmed = trimCheckpointMessages(messages, 70_000, objective);
  assert.ok(trimmed.some(message => message.role === 'user' && message.content.includes(objective)));
});

test('retomada reinsere o objetivo quando um checkpoint antigo não tem mensagem de usuário', () => {
  const seeded = buildResumeMessages([{ role: 'system', content: 'base' }], { objective: 'Objetivo preservado' });
  assert.ok(seeded.some(message => message.role === 'user' && message.content === 'Objetivo preservado'));
});
