// Code Intelligence LEVE do Developer Workspace 3.0 (Fase 9, escopo 6A).
//
// Duas capacidades estruturadas sobre o workspace da conversa, executadas no
// BACKEND (sem sandbox, sem rede): localizar arquivo por nome/glob
// (`find_file`) e buscar texto/regex no conteúdo (`search_text`). O objetivo é
// o agente parar de gastar etapas de `bash` com grep/find de saída bruta — o
// resultado volta compacto e estruturado (arquivo:linha:trecho), com limites
// explícitos em vez de truncamento silencioso.
//
// Deliberadamente SEM language server nesta fase (decisão 6A): previsível,
// barato e sem processos residentes. A arquitetura aceita um LSP depois.
import fs from 'fs';
import path from 'path';

// Diretórios que nunca valem busca (dependências, artefatos, escrituração).
const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.next', '.cache', '.thumbs', '.agent-env', '.multimodel', 'coverage'
]);
const MAX_SCANNED_FILES = 30_000;   // teto da varredura (workspace anômalo)
const MAX_FILE_BYTES = 1_500_000;   // arquivo maior que isto não é lido
const MAX_MATCHES_PER_FILE = 10;
const DEFAULT_FILE_LIMIT = 100;
const DEFAULT_MATCH_LIMIT = 80;
const SNIPPET_CHARS = 240;

// Glob simples → RegExp ancorada e case-insensitive sobre o caminho relativo:
// `**` cruza diretórios (e `**/` casa também com zero diretórios — o glob
// `src/**/*.js` inclui `src/app.js`, como no globstar do bash), `*` não cruza,
// `?` é um caractere. Placeholders de controle evitam que os substitutos se
// reprocessem entre si.
export function globToRegExp(glob) {
  const escaped = String(glob || '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:[\\s\\S]*/)?')
    .replace(/\u0001/g, '[\\s\\S]*');
  return new RegExp(`^${escaped}$`, 'i');
}

// Varre o workspace e devolve caminhos RELATIVOS (posix), pulando os diretórios
// excluídos e links simbólicos (contenção: nada fora da base entra na lista).
export function walkWorkspace(base, { maxFiles = MAX_SCANNED_FILES } = {}) {
  const files = [];
  let truncated = false;
  const visit = (dir) => {
    if (truncated) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) visit(full);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) { truncated = true; return; }
        files.push(path.relative(base, full).replaceAll('\\', '/'));
      }
    }
  };
  visit(base);
  return { files, truncated };
}

// find_file: glob quando o padrão tem metacaracteres; senão, trecho do nome
// (case-insensitive). Sempre informa quando a lista foi cortada.
export function findFiles(base, pattern, { limit = DEFAULT_FILE_LIMIT } = {}) {
  const clean = String(pattern || '').trim();
  if (!clean) return { error: 'Informe o padrão: um glob ("src/**/*.js") ou um trecho do nome ("useChat").' };
  const { files, truncated } = walkWorkspace(base);
  const isGlob = /[*?]/.test(clean);
  const regex = isGlob ? globToRegExp(clean.replaceAll('\\', '/')) : null;
  const needle = clean.toLowerCase();
  const matched = [];
  for (const file of files) {
    const ok = regex ? regex.test(file) : file.toLowerCase().includes(needle);
    if (!ok) continue;
    matched.push(file);
    if (matched.length > limit) break;
  }
  const cut = matched.length > limit;
  return {
    files: cut ? matched.slice(0, limit) : matched,
    total_scanned: files.length,
    ...(cut || truncated ? { truncated: true, note: 'Lista cortada no limite — refine o padrão.' } : {})
  };
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

// search_text: busca literal (padrão) ou regex (`regex: true`) no conteúdo dos
// arquivos, com filtro de glob opcional. Devolve arquivo + linha (1-based) +
// trecho, com tetos por arquivo e totais explícitos.
export function searchText(base, { pattern, regex = false, glob = null, limit = DEFAULT_MATCH_LIMIT } = {}) {
  const clean = String(pattern || '');
  if (!clean.trim()) return { error: 'Informe o texto (ou a regex, com regex=true) a procurar.' };
  let matcher;
  try {
    matcher = regex
      ? new RegExp(clean, 'i')
      : new RegExp(clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch (err) {
    return { error: `Expressão regular inválida: ${err.message}` };
  }
  const fileFilter = glob ? globToRegExp(String(glob).replaceAll('\\', '/')) : null;
  const { files, truncated: walkTruncated } = walkWorkspace(base);
  const matches = [];
  let scanned = 0;
  let truncated = walkTruncated;
  for (const file of files) {
    if (matches.length >= limit) { truncated = true; break; }
    if (fileFilter && !fileFilter.test(file)) continue;
    const full = path.join(base, file);
    let buffer;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      buffer = fs.readFileSync(full);
    } catch { continue; }
    if (looksBinary(buffer)) continue;
    scanned += 1;
    const lines = buffer.toString('utf8').split('\n');
    let inFile = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!matcher.test(lines[i])) continue;
      matches.push({ file, line: i + 1, text: lines[i].trim().slice(0, SNIPPET_CHARS) });
      inFile += 1;
      if (inFile >= MAX_MATCHES_PER_FILE) { truncated = true; break; }
      if (matches.length >= limit) { truncated = true; break; }
    }
  }
  return {
    matches,
    files_scanned: scanned,
    ...(truncated ? { truncated: true, note: 'Resultado cortado nos limites — refine o padrão ou use o filtro glob.' } : {})
  };
}
