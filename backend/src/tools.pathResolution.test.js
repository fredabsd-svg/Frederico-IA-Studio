import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-tool-path-tests';

const { isBlockedHost, resolveMountedPcPath, runTool, workspaceRelativePath } = await import('./tools.js');

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
