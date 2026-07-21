import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-agent-control-tests';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
const {
  ConversationBusyError,
  acquireConversationControl,
  beginProviderRequest,
  beginToolRequest,
  classifyToolOutcome,
  controlInterruptReason,
  isConversationActive,
  normalizeWebFetchUrl,
  planToolCallBatch,
  releaseConversationControl,
  releaseProviderRequest,
  releaseToolRequest,
  setControl,
  webResearchStopReason
} = await import('./agent.js');

test('prevents overlapping executions in the same conversation', () => {
  const id = 'control-test-conversation';
  const control = acquireConversationControl(id);
  try {
    assert.equal(isConversationActive(id), true);
    assert.throws(() => acquireConversationControl(id), ConversationBusyError);
  } finally {
    releaseConversationControl(id, control);
  }
  assert.equal(isConversationActive(id), false);
});

test('does not clear a newer control when an older execution finishes', () => {
  const id = 'control-release-safety';
  const first = acquireConversationControl(id);
  // This simulates a stale cleanup from an old execution without replacing the
  // active slot through the public API.
  releaseConversationControl(id, { paused: false, stopped: false });
  assert.equal(isConversationActive(id), true);
  setControl(id, 'stop');
  assert.equal(first.stopped, true);
  releaseConversationControl(id, first);
  assert.equal(isConversationActive(id), false);
});

test('aborts the active provider request for pause and stop', () => {
  const id = 'control-abort-provider-request';
  const control = acquireConversationControl(id);
  try {
    const pausedRequest = beginProviderRequest(control);
    setControl(id, 'pause');
    assert.equal(pausedRequest.signal.aborted, true);
    assert.equal(controlInterruptReason(control, pausedRequest), 'pause');

    setControl(id, 'resume');
    const activeRequest = beginProviderRequest(control);
    releaseProviderRequest(control, pausedRequest);
    // activeRequests é um Set (suporta várias requisições em paralelo no Modo
    // Equipe): após liberar a antiga, só a nova permanece rastreada.
    assert.ok(control.activeRequests.has(activeRequest));
    assert.ok(!control.activeRequests.has(pausedRequest));

    setControl(id, 'stop');
    assert.equal(activeRequest.signal.aborted, true);
    assert.equal(controlInterruptReason(control, activeRequest), 'stop');
  } finally {
    releaseConversationControl(id, control);
  }
});

test('keeps a running tool alive on pause and interrupts it on stop', () => {
  const id = 'control-tool-interruption';
  const control = acquireConversationControl(id);
  try {
    const toolRequest = beginToolRequest(control);
    setControl(id, 'pause');
    assert.equal(toolRequest.signal.aborted, false);

    setControl(id, 'resume');
    setControl(id, 'stop');
    assert.equal(toolRequest.signal.aborted, true);
    assert.equal(controlInterruptReason(control, toolRequest), 'stop');

    releaseToolRequest(control, toolRequest);
    assert.equal(control.activeTool, null);
  } finally {
    releaseConversationControl(id, control);
  }
});

test('recognizes unusable web results and stops repeated research', () => {
  const unavailable = classifyToolOutcome('web_fetch', JSON.stringify({
    status: 404,
    content: 'pagina nao encontrada'
  }));
  assert.equal(unavailable.failed, true);
  assert.equal(unavailable.webUnavailable, true);
  assert.equal(normalizeWebFetchUrl('HTTPS://Example.com:443/consulta#trecho'), 'https://example.com/consulta');
  assert.match(webResearchStopReason({ repeatedFetch: true }), /mesma fonte/i);
  assert.match(webResearchStopReason({ unavailableSources: 3, failureLimit: 3 }), /3 fontes/i);
  assert.match(webResearchStopReason({ fetchAttempts: 8, fetchLimit: 8 }), /8 p.ginas/i);
});

test('does not execute a huge repeated web-fetch batch from one model turn', () => {
  const call = (id, url) => ({ id, type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url }) } });
  const batch = planToolCallBatch([
    call('one', 'https://example.com/empresa'),
    call('two', 'https://example.org/empresa'),
    call('three', 'https://example.com/empresa'),
    call('four', 'https://example.net/empresa')
  ]);

  assert.equal(batch.calls.length, 2);
  assert.match(batch.webStopReason, /mesma fonte/i);

  const capped = planToolCallBatch([
    call('one', 'https://one.example/'),
    call('two', 'https://two.example/')
  ], new Set(), 1);
  assert.equal(capped.calls.length, 1);
  assert.equal(capped.truncated, true);

  const fetchLimited = planToolCallBatch([
    call('one', 'https://one.example/'),
    call('two', 'https://two.example/')
  ], new Set(), 12, 1);
  assert.equal(fetchLimited.calls.length, 1);
  assert.match(fetchLimited.webStopReason, /limite/i);
});

test('multiconversa: conta execuções ativas POR usuário e permite conversas paralelas', async () => {
  const { countActiveRunsForUser } = await import('./agent.js');
  const a1 = acquireConversationControl('multi-conv-a1', 'user-a');
  const a2 = acquireConversationControl('multi-conv-a2', 'user-a');
  const b1 = acquireConversationControl('multi-conv-b1', 'user-b');
  const anon = acquireConversationControl('multi-conv-anon'); // sem userId (legado)
  try {
    // Duas conversas do MESMO usuário rodando ao mesmo tempo: permitido.
    assert.equal(isConversationActive('multi-conv-a1'), true);
    assert.equal(isConversationActive('multi-conv-a2'), true);
    assert.equal(countActiveRunsForUser('user-a'), 2);
    assert.equal(countActiveRunsForUser('user-b'), 1);
    assert.equal(countActiveRunsForUser('user-sem-nada'), 0);
    assert.equal(countActiveRunsForUser(null), 0); // sem userId nunca conta
  } finally {
    releaseConversationControl('multi-conv-a1', a1);
    releaseConversationControl('multi-conv-a2', a2);
    releaseConversationControl('multi-conv-b1', b1);
    releaseConversationControl('multi-conv-anon', anon);
  }
  assert.equal(countActiveRunsForUser('user-a'), 0);
});

test('multiconversa: parar UMA conversa não afeta a outra do mesmo usuário', () => {
  const c1 = acquireConversationControl('multi-stop-1', 'user-x');
  const c2 = acquireConversationControl('multi-stop-2', 'user-x');
  try {
    setControl('multi-stop-1', 'stop');
    assert.equal(c1.stopped, true);
    assert.equal(c2.stopped, false); // a outra conversa segue intacta
    setControl('multi-stop-2', 'pause');
    assert.equal(c2.paused, true);
    assert.equal(c1.paused, false);
  } finally {
    releaseConversationControl('multi-stop-1', c1);
    releaseConversationControl('multi-stop-2', c2);
  }
});
