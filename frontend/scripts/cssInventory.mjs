#!/usr/bin/env node
// Inventário do CSS do frontend — F-21 (Frente 11 do backlog).
//
// O que este script faz:
//   1. Para cada arquivo `frontend/src/*.css`, conta regras e mede bytes.
//   2. Para cada classe CSS mencionada, verifica se ela é REFERENCIADA em algum
//      arquivo `.jsx`/`.js`/`.mjs`/`.html` do frontend. A detecção cobre
//      quatro formas de uso:
//        a) literal: `className="minha-classe"` ou `<div class="minha-classe">`
//        b) template string: `` className={`cmp${variant}`} ``
//        c) classNames(): `classNames({ "minha-classe": cond })`
//        d) concatenação de strings: `"minha-classe" + ...`
//   3. Para cada classe morta, procura ANCESTRAL que combine classe morta com
//      classe viva (ex.: `.morta .viva` ou `.morta.viva`) — se houver, a regra
//      inteira fica como KEEP_MIXED (a remoção da classe morta quebraria a
//      descendente viva).
//   4. Emite:
//        - frontend/dist/cssInventory.json (artefato gerado, fonte da verdade)
//        - resumo no stdout
//   5. Falha se o NÚMERO de regras mortas removíveis AUMENTAR em relação ao
//      snapshot (frontend/scripts/cssInventory.snapshot.json). É a catraca:
//      toda PR de CSS que introduzir regra morta nova quebra o check.
//
// Limitações documentadas (NÃO confie cegamente no resultado):
//   - Classes montadas por `split(' ')` ou geradas a partir de um JSON de tema
//     escapam à detecção. O detector cobre os padrões observados no projeto.
//   - Seletores que dependem só de estado/tag (`.foo p`, `.foo > div`) ficam
//     como REMOVE mesmo que `p` ou `div` sejam "vivos" — porque a árvore CSS é
//     do `.foo`. Isso é conservador: a regra só morre se `.foo` é realmente
//     morta.
//   - Keyframes são detectados pelo nome — se um keyframe é referenciado em
//     string de animação (`animation: myKey 1s`) sem o nome por extenso, pode
//     passar como morto. O detector cobre `animation:` e `animation-name:`
//     na varredura.
//
// Por que isto existe: até 2026-08-06 o CSS do frontend vivia como 12
// arquivos importados por `main.jsx` sem nenhum inventário. A primeira varredura
// encontrou ~10 KB de regras cuja única existência era em CSS — nunca
// aplicadas pelo app. Sem detector, esse passivo cresce a cada PR que
// adiciona/remover componente sem cuidar do CSS junto. O snapshot fixa a
// linha de base; a catraca impede regredir.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(frontendRoot, 'src');
const DIST = path.join(frontendRoot, 'dist');
const SNAPSHOT = path.join(frontendRoot, 'scripts', 'cssInventory.snapshot.json');

// ---------- 1. Coletar texto de todos os arquivos relevantes ----------

function walk(dir, match) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walk(full, match)); continue; }
    if (match.test(entry.name)) out.push(full);
  }
  return out;
}

const cssFiles = walk(SRC, /\.css$/).sort();

const jsFiles = [
  ...walk(SRC, /\.(jsx|js|mjs)$/),
  path.join(frontendRoot, 'index.html'),
].filter(f => !/\.test\.(js|jsx)$/.test(f));

let jsText = '';
for (const f of jsFiles) {
  jsText += `\n// FILE: ${path.relative(frontendRoot, f)}\n` + fs.readFileSync(f, 'utf8');
}

// ---------- 2. Parser CSS mínimo ----------

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
        rules.push({ selector: rest, kind: 'keyframes', body });
      } else if (kw === 'media' || kw === 'supports' || kw === 'container' || kw === 'layer') {
        for (const r of parseCss(body)) rules.push(r);
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
      rules.push({ selector: sel, kind: 'rule', body });
      i = j;
      continue;
    }
    i++;
  }
  return rules;
}

const extractClasses = (sel) => new Set(sel.match(/\.([\w-]+)/g)?.map(s => s.slice(1)) || []);

// ---------- 3. Detecção de uso ----------

function isUsedInJs(className) {
  // Escape especial para regex; className já passou pelo extrator que garante [\w-]+
  const pat = className.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  // template string (cobre qualquer string JSX/JS entre crases)
  if (new RegExp('`[^`]*' + pat + '[^`]*`').test(jsText)) return true;
  // classNames({...}) / clsx
  if (new RegExp('classNames?\\([^)]*' + pat).test(jsText)) return true;
  // className="..."
  if (new RegExp('className=["\'][^"\']*' + pat).test(jsText)) return true;
  // string concatenation genérica
  if (new RegExp('["\'][^"\']*' + pat).test(jsText)) return true;
  // uso em CSS animation: myKey
  if (new RegExp('animation(-name)?\\s*:\\s*[^;}]*\\b' + pat + '\\b').test(jsText)) return true;
  return false;
}

// ---------- 4. Para cada arquivo CSS, classificar regras ----------

function classify(cssContent) {
  const rules = parseCss(cssContent);
  const allClasses = new Set();
  for (const r of rules) {
    if (r.kind !== 'rule') continue;
    for (const c of extractClasses(r.selector)) allClasses.add(c);
  }
  const deadClasses = new Set();
  for (const c of allClasses) {
    if (!isUsedInJs(c)) deadClasses.add(c);
  }
  // keyframes
  const keyframes = [];
  for (const r of rules) {
    if (r.kind === 'keyframes') {
      const name = r.selector.trim();
      const used = isUsedInJs(name);
      keyframes.push({ name, used });
    }
  }

  const classifications = [];
  let remove = 0, keepMixed = 0, kept = 0;
  for (const r of rules) {
    if (r.kind !== 'rule') continue;
    const cs = extractClasses(r.selector);
    if (cs.size === 0) {
      // seletor sem classe (tag, *, :root) — sempre mantido
      classifications.push({ selector: r.selector.slice(0, 200), verdict: 'KEEP_TAG' });
      kept++;
      continue;
    }
    const onlyDead = [...cs].every(c => deadClasses.has(c));
    const hasMixed = [...cs].some(c => deadClasses.has(c)) && [...cs].some(c => !deadClasses.has(c));
    if (onlyDead) {
      classifications.push({ selector: r.selector.slice(0, 200), verdict: 'REMOVE' });
      remove++;
    } else if (hasMixed) {
      classifications.push({ selector: r.selector.slice(0, 200), verdict: 'KEEP_MIXED' });
      keepMixed++;
    } else {
      classifications.push({ selector: r.selector.slice(0, 200), verdict: 'KEEP' });
      kept++;
    }
  }
  return {
    rules: classifications,
    summary: {
      totalRules: rules.length,
      removeCount: remove,
      keepMixedCount: keepMixed,
      keptCount: kept,
      deadClassCount: deadClasses.size,
      keyframeCount: keyframes.length,
      keyframeUnusedCount: keyframes.filter(k => !k.used).length,
    },
    deadClasses: [...deadClasses].sort(),
    keyframes,
  };
}

// ---------- 5. Execução ----------

function report() {
  const out = {
    generatedAt: new Date().toISOString(),
    files: {},
  };
  for (const f of cssFiles) {
    const rel = path.relative(frontendRoot, f);
    const content = fs.readFileSync(f, 'utf8');
    const c = classify(content);
    out.files[rel] = {
      sizeBytes: content.length,
      ...c.summary,
    };
  }
  return out;
}

function totalRemove(inv) {
  let n = 0;
  for (const v of Object.values(inv.files)) n += v.removeCount;
  return n;
}

// Execução principal: gera inventário, compara com snapshot, sai com código
// apropriado. Pode ser importada por testes.
export function inventoryCss() { return report(); }
export function snapshotPath() { return SNAPSHOT; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const inv = report();

  // Garante dist/ para escrever o json
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'cssInventory.json'), JSON.stringify(inv, null, 2));

  // Resumo no stdout
  let totalRules = 0, totalRemoveCount = 0, totalKeepMixed = 0, totalKept = 0, totalBytes = 0;
  for (const v of Object.values(inv.files)) {
    totalRules += v.totalRules;
    totalRemoveCount += v.removeCount;
    totalKeepMixed += v.keepMixedCount;
    totalKept += v.keptCount;
    totalBytes += v.sizeBytes;
  }
  console.log(`[css] ${Object.keys(inv.files).length} arquivo(s) — ${totalRules} regras, ${totalBytes} bytes brutos`);
  console.log(`[css]   removíveis (mortas sem combinação): ${totalRemoveCount}`);
  console.log(`[css]   mistas (mortas combinadas com vivas): ${totalKeepMixed}`);
  console.log(`[css]   vivas: ${totalKept}`);
  console.log(`[css] inventário gravado em dist/cssInventory.json`);

  // Catraca: número de removíveis NÃO pode subir
  let snapshot = null;
  if (fs.existsSync(SNAPSHOT)) {
    try { snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); }
    catch (e) {
      console.error(`[css] snapshot inválido em ${path.relative(frontendRoot, SNAPSHOT)}: ${e.message}`);
      process.exit(2);
    }
  }
  const baseline = snapshot?.baselineRemoveCount;
  const atual = totalRemoveCount;
  if (typeof baseline === 'number') {
    if (atual > baseline) {
      console.error(`[css] catraca: regras mortas removíveis SUBIRAM de ${baseline} para ${atual}. ` +
        'Remova as regras mortas novas antes de abrir PR (veja dist/cssInventory.json).');
      process.exit(1);
    }
    console.log(`[css] catraca ok: ${atual} <= ${baseline} (snapshot).`);
  } else {
    console.log('[css] sem snapshot prévio — esta é a primeira execução.');
  }
}
