// Criptografia AES-256-GCM para segredos por usuário (BYOK): a chave de API de
// cada usuário fica guardada CIFRADA no banco, nunca em texto claro.
//
// De onde vem a chave mestra (ENCRYPTION_KEY, 32 bytes = 64 hex), por ordem de
// prioridade:
//   1) variável de ambiente ENCRYPTION_KEY — quem quer controlar (SaaS/secret
//      manager) define e ela MANDA;
//   2) arquivo persistente em DATA_DIR/encryption.key — para instalações self-
//      hosted: na PRIMEIRA subida, se não houver env nem arquivo, geramos uma
//      chave e a salvamos ali (no MESMO volume do banco). Assim o usuário comum
//      não precisa rodar `openssl` nem mexer em terminal, e a chave fica ESTÁVEL
//      entre reinícios/deploys (o arquivo é lido sempre; nunca regenerado à toa).
//
// Apagar esse arquivo (ou trocar a env) torna ilegíveis os segredos já cifrados
// — mas se o volume de dados some, o banco some junto, então não sobra segredo
// órfão sem chave.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HEX64 = /^[0-9a-fA-F]{64}$/;
export function isValidKeyHex(v) { return HEX64.test(String(v || '').trim()); }

// PURA (testável): decide qual hex usar dadas as duas fontes (env e arquivo).
// Lança em valor inválido (erro de configuração, melhor do que cifrar com chave
// silenciosamente errada). Devolve { hex, source }; source 'generate' sinaliza
// ao chamador que não havia chave e uma nova deve ser criada e persistida.
export function chooseKeyHex(envValue, fileHex) {
  const env = String(envValue || '').trim();
  if (env) {
    if (!isValidKeyHex(env)) {
      throw new Error('ENCRYPTION_KEY inválida (esperado 64 caracteres hex — gere com `openssl rand -hex 32`).');
    }
    return { hex: env, source: 'env' };
  }
  const file = String(fileHex || '').trim();
  if (file) {
    if (!isValidKeyHex(file)) {
      throw new Error('O arquivo de chave (encryption.key) está corrompido (esperado 64 caracteres hex). Restaure o backup dele ou defina ENCRYPTION_KEY no ambiente.');
    }
    return { hex: file, source: 'file' };
  }
  return { hex: null, source: 'generate' };
}

function keyFilePath() {
  return path.join(path.resolve(process.env.DATA_DIR || './data'), 'encryption.key');
}

// Persiste a chave recém-gerada com permissão restrita (0600). Se não conseguir
// escrever, FALHA explicitamente: sem persistência, os segredos ficariam
// irrecuperáveis no próximo reinício — melhor parar do que corromper dados.
function persistKeyFile(file, hex) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${hex}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* sistemas sem chmod (Windows) ignoram */ }
    console.warn(`[crypto] ENCRYPTION_KEY não definida — gerei uma chave mestra e salvei em ${file}. NÃO apague este arquivo (ele descriptografa os tokens e chaves salvas). Faça backup dele.`);
  } catch (e) {
    throw new Error(`Não consegui criar o arquivo de chave em ${file}: ${e.message}. Defina ENCRYPTION_KEY no ambiente (openssl rand -hex 32) ou dê permissão de escrita ao diretório de dados.`);
  }
}

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  const envValue = process.env.ENCRYPTION_KEY;
  // Só lê o arquivo quando não há env (env tem prioridade e evita I/O à toa).
  let fileHex = null;
  if (!String(envValue || '').trim()) {
    try { fileHex = fs.readFileSync(keyFilePath(), 'utf8'); } catch { /* ainda não existe */ }
  }
  let { hex, source } = chooseKeyHex(envValue, fileHex);
  if (source === 'generate') {
    hex = crypto.randomBytes(32).toString('hex');
    persistKeyFile(keyFilePath(), hex);
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
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
