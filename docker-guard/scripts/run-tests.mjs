#!/usr/bin/env node
// Executa a suíte de testes de forma INDEPENDENTE DA VERSÃO DO NODE.
//
// Mesma razão do backend: a expansão de glob do `node --test` só existe no
// Node 22+, e a imagem de produção é Node 20. A descoberta é feita em JS.
//
// Uso:
//   node scripts/run-tests.mjs                 # tudo em src/
//   node scripts/run-tests.mjs src            # um subdiretório específico
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findTests(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...findTests(full)); continue; }
    if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map(p => path.resolve(packageRoot, p))
  : [path.join(packageRoot, 'src')];

const files = roots.flatMap(findTests).sort();

if (!files.length) {
  console.error(`[testes] nenhum arquivo *.test.js encontrado em: ${roots.join(', ')}`);
  process.exit(1);
}

const relative = files.map(f => path.relative(packageRoot, f));
const run = spawnSync(process.execPath, ['--test', ...relative], { cwd: packageRoot, stdio: 'inherit' });
process.exit(run.status ?? 1);
