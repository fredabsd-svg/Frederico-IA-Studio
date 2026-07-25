import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { workspaceFor, realInside } from '../sandbox.js';
import { listOutputs } from './outputs.js';

const safePart = value => String(value || 'run').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function snapshotArtifactVersion(userId, conversationId, { runId, stage, model, role, valid = true, checks = {} } = {}) {
  const ws = workspaceFor(conversationId, userId);
  const versionId = `v${String(Number(stage) + 1).padStart(2, '0')}`;
  const root = path.join(ws.base, '.multimodel', safePart(runId), versionId);
  fs.mkdirSync(root, { recursive: true });
  const files = [];
  for (const file of listOutputs(userId, conversationId)) {
    const source = path.resolve(ws.base, file.path);
    if (!realInside(ws.base, source)) continue;
    const relativeOutput = path.relative(ws.outputs, source);
    const target = path.resolve(root, relativeOutput);
    if (!realInside(root, target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    const stat = fs.statSync(target);
    files.push({
      name: file.name,
      sourcePath: file.path,
      versionPath: path.relative(ws.base, target).replaceAll('\\', '/'),
      size: stat.size,
      sha256: sha256File(target),
      check: checks[file.path] || null
    });
  }
  return {
    id: versionId,
    stage: Number(stage) + 1,
    model: model || null,
    role: role || null,
    valid: Boolean(valid),
    createdAt: new Date().toISOString(),
    files
  };
}
