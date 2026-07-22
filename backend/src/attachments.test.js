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
const uploads = path.join(root, conversationId, 'uploads');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('manifesto confirma vários PDFs reais no workspace da conversa', () => {
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'a.pdf'), '%PDF-a');
  fs.writeFileSync(path.join(uploads, 'b.pdf'), '%PDF-b');

  const files = listWorkspaceUploads(conversationId);
  assert.deepEqual(files.map(file => file.path), ['uploads/a.pdf', 'uploads/b.pdf']);
  const checked = validateAttachmentManifest(conversationId, files);
  assert.equal(checked.valid.length, 2);
  assert.equal(checked.missing.length, 0);
  assert.match(uploadsNote(conversationId), /\/workspace\/uploads\/a\.pdf/);
  assert.match(uploadsNote(conversationId), /\/workspace\/uploads\/b\.pdf/);
});

test('manifesto rejeita arquivo ausente e travessia sem esconder o problema', () => {
  const checked = validateAttachmentManifest(conversationId, [
    { path: 'uploads/nao-existe.pdf', name: 'não existe.pdf' },
    { path: '../segredo.pdf', name: 'segredo.pdf' }
  ]);
  assert.equal(checked.valid.length, 0);
  assert.deepEqual(checked.missing.map(file => file.name), ['não existe.pdf', 'segredo.pdf']);
});
