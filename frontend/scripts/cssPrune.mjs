#!/usr/bin/env node
// Aplica a poda das regras REMOVE identificadas pelo cssInventory.mjs.
// Gera arquivos `.css` atualizados a partir dos originais, removendo regras
// cuja única classe é morta. Preserva KEEP_MIXED (mortas combinadas com
// vivas), KEEP (vivas) e KEEP_TAG (seletores sem classe).
//
// USO:
//   node scripts/cssPrune.mjs   # escreve nos arquivos
//   node scripts/cssPrune.mjs --dry   # só mostra o que faria
//
// Este script é parte da Frente 11 do backlog (F-21 — inventário e poda do
// CSS). É determinístico: o cssInventory.mjs garante que a catraca não
// regrida; este aqui garante que o que a catraca detecta é removido.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryCss, snapshotPath } from './cssInventory.mjs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(frontendRoot, 'src');
const dry = process.argv.includes('--dry');

// Reaproveita o parser via reuso indireto: reroda o mesmo algoritmo aqui,
// para ter acesso a selector/body individuais. (Copiar o parser é mais
// simples que exportar internals; o custo é mínimo.)

function parseCss(text) {
  const rules = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.slice(i, i + 2) === '/*') {
      const end = text.indexOf('*/', i);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (text[i] === '@') {
      const m = text.slice(i).match(/@([\w-]+)\s*([^{]*?)\{/);
      if (!m) { i++; continue; }
      const kw = m[1];
      const rest = m[2].trim();
      const start = i + m[0].length;
      let depth = 1, j = start;
      while (j < n && depth) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(start, j - 1);
      if (kw === 'keyframes' || kw.endsWith('keyframes')) {
        rules.push({ start: i, end: j, kind: 'keyframes', selector: rest, body, raw: text.slice(i, j) });
      } else if (kw === 'media' || kw === 'supports' || kw === 'container' || kw === 'layer') {
        // não removemos @-rules inteiras — processar recursivamente seria correto
        // mas mais arriscado. Em vez disso, manter @-rules por inteiro.
        rules.push({ start: i, end: j, kind: kw, raw: text.slice(i, j) });
      }
      i = j;
      continue;
    }
    if (/[.#a-zA-Z*:[]/.test(text[i])) {
      const m = text.slice(i).match(/([^{};@]+?)\{/);
      if (!m || m[1].length > 800) { i++; continue; }
      const sel = m[1].trim();
      const start = i + m[0].length;
      let depth = 1, j = start;
      while (j < n && depth) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(start, j - 1);
      rules.push({ start: i, end: j, kind: 'rule', selector: sel, body, raw: text.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return rules;
}

const extractClasses = (sel) => new Set(sel.match(/\.([\w-]+)/g)?.map(s => s.slice(1)) || []);

function isUsedInJs(className) {
  const pat = className.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  // mesmo conjunto de padrões do cssInventory.mjs
  // (a duplicação é proposital: este script é executado uma vez, não em catraca)
  // lê os arquivos JSX/JS/HTML do projeto
  const jsFiles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(jsx|js|mjs)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name)) jsFiles.push(full);
    }
  }
  walk(SRC);
  jsFiles.push(path.join(frontendRoot, 'index.html'));
  const text = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  if (new RegExp('`[^`]*' + pat + '[^`]*`').test(text)) return true;
  if (new RegExp('classNames?\\([^)]*' + pat).test(text)) return true;
  if (new RegExp('className=["\'][^"\']*' + pat).test(text)) return true;
  if (new RegExp('["\'][^"\']*' + pat).test(text)) return true;
  return false;
}

function classifyRules(cssContent) {
  const rules = parseCss(cssContent);
  const allClasses = new Set();
  for (const r of rules) {
    if (r.kind !== 'rule') continue;
    for (const c of extractClasses(r.selector)) allClasses.add(c);
  }
  const dead = new Set();
  for (const c of allClasses) if (!isUsedInJs(c)) dead.add(c);
  return { rules, dead };
}

function prune(cssContent) {
  const { rules, dead } = classifyRules(cssContent);
  // Constrói novo texto pulando as regras REMOVE
  let out = '';
  let cursor = 0;
  let removed = 0, kept = 0;
  for (const r of rules) {
    if (r.kind !== 'rule') {
      // mantém @-rules e keyframes como estão
      continue;
    }
    const cs = extractClasses(r.selector);
    const onlyDead = cs.size > 0 && [...cs].every(c => dead.has(c));
    if (onlyDead) {
      // pular regra: gravar até antes dela
      out += cssContent.slice(cursor, r.start);
      cursor = r.end;
      removed++;
    } else {
      kept++;
    }
  }
  out += cssContent.slice(cursor);
  // Colapsar múltiplas linhas em branco resultantes
  out = out.replace(/\n{3,}/g, '\n\n');
  return { text: out, removed, kept };
}

// Execução
const cssFiles = fs.readdirSync(SRC).filter(f => f.endsWith('.css')).sort();
let totalRemoved = 0, totalBytesBefore = 0, totalBytesAfter = 0;
for (const f of cssFiles) {
  const fp = path.join(SRC, f);
  const content = fs.readFileSync(fp, 'utf8');
  const { text, removed, kept } = prune(content);
  totalBytesBefore += content.length;
  totalBytesAfter += text.length;
  totalRemoved += removed;
  console.log(`[prune] ${f}: removidas=${removed} mantidas=${kept} ${content.length}→${text.length} bytes`);
  if (!dry && removed > 0) {
    fs.writeFileSync(fp, text);
  }
}
console.log(`\n[prune] TOTAL: removidas=${totalRemoved} bytes ${totalBytesBefore}→${totalBytesAfter} (-${totalBytesBefore - totalBytesAfter} B / -${Math.round((totalBytesBefore - totalBytesAfter) / 1024 * 10) / 10} KB)`);
console.log(`[prune] modo: ${dry ? 'dry (não escreveu)' : 'escrita ativa'}`);
