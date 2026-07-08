import crypto from 'crypto';

// Autenticação simples por senha única (APP_PASSWORD no .env).
// - Sem APP_PASSWORD definida: autenticação DESLIGADA (uso local).
// - Com APP_PASSWORD: todas as rotas /api exigem o cookie de sessão.
// O token é stateless (HMAC com validade), então sobrevive a reinícios.

const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET
  ? Buffer.from(process.env.SESSION_SECRET)
  : crypto.createHash('sha256').update('frederico-ai:' + PASSWORD).digest();

export const authEnabled = () => PASSWORD.length > 0;

function sign(exp) {
  return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
}

export function makeToken(days = 30) {
  const exp = Date.now() + days * 86400000;
  return `${exp}.${sign(exp)}`;
}

export function verifyToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

export function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function passwordMatches(attempt) {
  const a = Buffer.from(String(attempt || ''));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}

// Proteção básica contra força bruta no login: 10 tentativas / 15 min por IP
const attempts = new Map();
export function loginRateLimited(ip) {
  const nowMs = Date.now();
  const e = attempts.get(ip);
  if (!e || nowMs > e.reset) { attempts.set(ip, { count: 1, reset: nowMs + 15 * 60 * 1000 }); return false; }
  e.count++;
  return e.count > 10;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of attempts) if (t > v.reset) attempts.delete(k); }, 60_000).unref();
