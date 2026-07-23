// Configuração administrativa do Docling (seção "Configurações administrativas").
// Guarda OVERRIDES globais (uma linha JSON na tabela settings) que têm
// precedência sobre os padrões vindos do ambiente (config.js). Assim o admin
// ajusta OCR, idioma, tabelas, fórmulas, limite de páginas e tamanho de chunk
// sem reiniciar/reconfigurar o container.
//
// Trocar qualquer opção muda o configVersion → o cache é naturalmente
// invalidado e os documentos são reprocessados sob demanda.
import { db, now } from '../db.js';
import { doclingOptions } from './config.js';

const KEY = 'docling_config';

const OCR_MODES = ['auto', 'always', 'never'];
const clampInt = (v, min, max, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fb; };
const pick = (v, allowed, fb) => (allowed.includes(v) ? v : fb);

// Mantém APENAS as chaves editáveis pelo admin, já validadas. Campos ausentes
// ficam de fora (para não sobrescrever o padrão do ambiente sem intenção).
export function sanitizeOverrides(input = {}) {
  const out = {};
  if (input.ocr !== undefined) out.ocr = pick(String(input.ocr), OCR_MODES, 'auto');
  if (input.lang !== undefined) out.lang = String(input.lang).slice(0, 40).replace(/[^a-zA-Z+_-]/g, '') || 'por';
  if (input.tables !== undefined) out.tables = Boolean(input.tables);
  if (input.formulas !== undefined) out.formulas = Boolean(input.formulas);
  if (input.maxPages !== undefined) out.maxPages = clampInt(input.maxPages, 0, 5000, 0);
  if (input.maxChunkTokens !== undefined) out.maxChunkTokens = clampInt(input.maxChunkTokens, 200, 8000, 1200);
  return out;
}

export async function readOverrides() {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);
    return row?.value ? sanitizeOverrides(JSON.parse(row.value)) : {};
  } catch { return {}; }
}

export async function writeOverrides(input = {}) {
  const clean = sanitizeOverrides(input);
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY, JSON.stringify(clean));
  return clean;
}

// Opções efetivas = padrões do ambiente + overrides do admin (mesclados).
export async function resolvedOptions() {
  return { ...doclingOptions(), ...(await readOverrides()) };
}

// Só as opções que o admin controla, para exibir na interface.
export function adminEditable(opts) {
  return {
    ocr: opts.ocr, lang: opts.lang, tables: opts.tables,
    formulas: opts.formulas, maxPages: opts.maxPages, maxChunkTokens: opts.maxChunkTokens,
  };
}
