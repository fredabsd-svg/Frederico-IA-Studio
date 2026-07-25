import fs from 'fs';
import path from 'path';
import { insideBase, realInside, workspaceFor } from './sandbox.js';

export function listWorkspaceUploads(userId, conversationId) {
  const ws = workspaceFor(conversationId, userId);
  let entries = [];
  try { entries = fs.readdirSync(ws.uploads, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isFile())
    .map(entry => {
      const full = path.join(ws.uploads, entry.name);
      try {
        const stat = fs.statSync(full);
        return { path: `uploads/${entry.name}`, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function validateAttachmentManifest(userId, conversationId, manifest = []) {
  const ws = workspaceFor(conversationId, userId);
  const valid = [];
  const missing = [];
  for (const item of Array.isArray(manifest) ? manifest : []) {
    const relative = String(item?.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
    const full = path.resolve(ws.base, relative);
    const safe = relative.startsWith('uploads/')
      && insideBase(ws.uploads, full)
      && realInside(ws.uploads, full);
    let stat = null;
    try { if (safe) stat = fs.statSync(full); } catch {}
    if (!stat?.isFile()) {
      missing.push({ ...item, path: relative });
      continue;
    }
    valid.push({ ...item, path: relative, size: stat.size });
  }
  return { valid, missing };
}
