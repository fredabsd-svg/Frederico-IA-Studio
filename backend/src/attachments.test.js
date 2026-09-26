import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frederico-attachments-'));
process.env.WORKSPACE_ROOT = root;

const { listWorkspaceUploads, validateAttachmentManifest } = await import('./attachments.js');
const { uploadsNote } = await import('./agent/prompts.js');
const conversationId = 'attachment-test-conversation';
const userId = 'user-anexos-1';
const uploads = path.join(root, 'users', userId, conversationId, 'uploads');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('manifesto confirma vários PDFs reais no workspace da conversa', () => {
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'a.pdf'), '%PDF-a');
  fs.writeFileSync(path.join(uploads, 'b.pdf'), '%PDF-b');

  const files = listWorkspaceUploads(userId, conversationId);
  assert.deepEqual(files.map(file => file.path), ['uploads/a.pdf', 'uploads/b.pdf']);
  const checked = validateAttachmentManifest(userId, conversationId, files);
  assert.equal(checked.valid.length, 2);
  assert.equal(checked.missing.length, 0);
  assert.match(uploadsNote(userId, conversationId), /\/workspace\/uploads\/a\.pdf/);
  assert.match(uploadsNote(userId, conversationId), /\/workspace\/uploads\/b\.pdf/);
});

test('manifesto rejeita arquivo ausente e travessia sem esconder o problema', () => {
  const checked = validateAttachmentManifest(userId, conversationId, [
    { path: 'uploads/nao-existe.pdf', name: 'não existe.pdf' },
    { path: '../segredo.pdf', name: 'segredo.pdf' }
  ]);
  assert.equal(checked.valid.length, 0);
  assert.deepEqual(checked.missing.map(file => file.name), ['não existe.pdf', 'segredo.pdf']);
});

test('ADVERSARIAL: arquivo em uploads/.quarantine NÃO é aceito como anexo (ainda não verificado)', () => {
  const quarentena = path.join(uploads, '.quarantine');
  fs.mkdirSync(quarentena, { recursive: true });
  fs.writeFileSync(path.join(quarentena, '1717_abc_suspeito.pdf'), '%PDF-nao-verificado');
  fs.writeFileSync(path.join(uploads, 'limpo.pdf'), '%PDF-ok');
  const checked = validateAttachmentManifest(userId, conversationId, [
    { path: 'uploads/.quarantine/1717_abc_suspeito.pdf', name: 'suspeito.pdf' },
    // Variações que resolvem para o mesmo lugar também são recusadas.
    { path: 'uploads/./.quarantine/1717_abc_suspeito.pdf', name: 'ponto.pdf' },
    { path: 'uploads/x/../.quarantine/1717_abc_suspeito.pdf', name: 'volta.pdf' },
    { path: '/uploads/.quarantine/1717_abc_suspeito.pdf', name: 'barra.pdf' },
    { path: 'uploads\\.quarantine\\1717_abc_suspeito.pdf', name: 'contrabarra.pdf' },
    { path: 'uploads/limpo.pdf', name: 'limpo.pdf' }
  ]);
  assert.deepEqual(checked.valid.map(file => file.name), ['limpo.pdf']);
  assert.deepEqual(checked.missing.map(file => file.name), ['suspeito.pdf', 'ponto.pdf', 'volta.pdf', 'barra.pdf', 'contrabarra.pdf']);
  // A listagem que alimenta o prompt também não inclui a quarentena.
  assert.ok(!listWorkspaceUploads(userId, conversationId).some(file => file.path.includes('.quarantine')));
});
