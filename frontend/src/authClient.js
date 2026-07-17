// Cliente da Better Auth (React). Mesma origem do app (o Vite repassa /api ao
// backend), então o cookie de sessão vai automaticamente em todas as chamadas.
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : undefined,
});

export const { signIn, signUp, signOut, useSession } = authClient;

// Traduz as mensagens de erro da Better Auth para PT-BR amigável.
export function traduzErroAuth(error) {
  const code = String(error?.code || '').toUpperCase();
  const msg = String(error?.message || '');
  const map = {
    INVALID_EMAIL_OR_PASSWORD: 'E-mail ou senha incorretos.',
    USER_ALREADY_EXISTS: 'Já existe uma conta com esse e-mail. Tente entrar.',
    INVALID_EMAIL: 'E-mail inválido.',
    PASSWORD_TOO_SHORT: 'A senha é muito curta (mínimo de 8 caracteres).',
    PASSWORD_TOO_LONG: 'A senha é muito longa.',
    EMAIL_NOT_VERIFIED: 'Confirme seu e-mail antes de entrar.',
    CREDENTIAL_ACCOUNT_NOT_FOUND: 'Conta não encontrada. Crie uma conta.',
  };
  if (map[code]) return map[code];
  if (/already exists/i.test(msg)) return 'Já existe uma conta com esse e-mail. Tente entrar.';
  if (/invalid.*(email|password)/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/password/i.test(msg) && /short|least|8/i.test(msg)) return 'A senha precisa ter pelo menos 8 caracteres.';
  return msg || 'Não foi possível completar. Tente novamente.';
}
