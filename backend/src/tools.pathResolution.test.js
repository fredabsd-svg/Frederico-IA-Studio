import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-tool-path-tests';

const { isBlockedHost, resolveMountedPcPath, runTool, webFetch, workspaceRelativePath } = await import('./tools.js');

test('normalizes the virtual workspace paths shown to the model', () => {
  assert.equal(workspaceRelativePath('/workspace/outputs/relatorio.docx'), 'outputs/relatorio.docx');
  assert.equal(workspaceRelativePath('/mnt/user-data/uploads/dados.csv'), 'uploads/dados.csv');
  assert.equal(workspaceRelativePath('outputs/relatorio.docx'), 'outputs/relatorio.docx');
});

test('accepts only files inside an explicitly mounted PC folder', () => {
  const mounts = [{ target: '/mnt/pc/frederico_ai_studio' }];

  assert.equal(
    resolveMountedPcPath('/mnt/pc/frederico_ai_studio/frontend/package.json', mounts),
    '/mnt/pc/frederico_ai_studio/frontend/package.json'
  );
  assert.equal(resolveMountedPcPath('/mnt/pc/frederico_ai_studio/../../etc/passwd', mounts), null);
});

test('reads and writes virtual workspace paths without creating a fake workspace folder', async () => {
  const conversationId = `tool-path-${Date.now()}`;
  const write = JSON.parse(await runTool(conversationId, 'write_file', {
    path: '/workspace/outputs/relatorio.txt',
    content: 'conteudo do relatorio'
  }));
  const read = JSON.parse(await runTool(conversationId, 'read_file', {
    path: '/workspace/outputs/relatorio.txt'
  }));
  const missing = JSON.parse(await runTool(conversationId, 'read_file', {
    path: '/workspace/nao-existe.txt'
  }));

  assert.equal(write.ok, true);
  assert.equal(read.content, 'conteudo do relatorio');
  assert.equal(missing.recoverable, true);
  assert.equal(missing.code, 'ENOENT');
  assert.ok(missing.availableFiles.includes('outputs/relatorio.txt'));
});

test('blocks private and loopback hosts before a web fetch can reach them', () => {
  assert.equal(isBlockedHost('localhost'), true);
  assert.equal(isBlockedHost('127.0.0.1'), true);
  assert.equal(isBlockedHost('10.0.0.25'), true);
  assert.equal(isBlockedHost('169.254.169.254'), true);
  assert.equal(isBlockedHost('example.com'), false);
});

test('returns structured failures for HTTP errors and empty web pages', async () => {
  const originalFetch = globalThis.fetch;
  const response = (status, text) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => key === 'content-type' ? 'text/html' : null },
    body: null,
    text: async () => text
  });
  try {
    globalThis.fetch = async () => response(404, 'not found');
    const missing = await webFetch('https://example.com/empresa');
    assert.equal(missing.code, 'WEB_FETCH_HTTP_ERROR');
    assert.equal(missing.status, 404);

    globalThis.fetch = async () => response(200, '');
    const empty = await webFetch('https://example.com/vazio');
    assert.equal(empty.code, 'WEB_FETCH_EMPTY_CONTENT');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards cancellation to a web request', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal;
  try {
    globalThis.fetch = async (_url, options = {}) => {
      receivedSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('request canceled')), { once: true });
      });
    };
    const pending = webFetch('https://example.com/demorada', { signal: controller.signal });
    await Promise.resolve();
    controller.abort('stop');
    await assert.rejects(pending, /request canceled/);
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
