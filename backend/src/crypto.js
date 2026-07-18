// Criptografia AES-256-GCM para segredos por usuário (BYOK): a chave de API de
// cada usuário fica guardada CIFRADA no banco, nunca em texto claro. Usa a
// ENCRYPTION_KEY do .env (64 caracteres hex = 32 bytes, de `openssl rand -hex 32`).
import crypto from 'node:crypto';

function key() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY ausente ou inválida (esperado 64 caracteres hex — gere com `openssl rand -hex 32`).');
  }
  return Buffer.from(hex, 'hex');
}

// Cifra um texto -> "iv:tag:cifra" (cada parte em base64). null para entrada vazia.
export function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

// Decifra "iv:tag:cifra" -> texto. Retorna null se vazio ou inválido/adulterado.
export function decryptSecret(stored) {
  if (!stored) return null;
  const parts = String(stored).split(':');
  if (parts.length !== 3) return null;
  try {
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch { return null; }
}

// Mascara uma chave para exibição segura (a UI nunca recebe a chave inteira).
export function maskSecret(plain) {
  const s = String(plain || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
