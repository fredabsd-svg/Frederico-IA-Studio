// Hash de conteúdo — a identidade do documento para cache/dedup/rastreabilidade.
// O mesmo arquivo (byte a byte) sempre gera o mesmo hash, então nunca é
// processado duas vezes, mesmo em conversas ou modelos diferentes.
import crypto from 'node:crypto';
import fs from 'node:fs';

export function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
