#!/usr/bin/env node
// Conferência de sintaxe de todos os módulos do guarda (`node --check`).
// Não é um ESLint — o projeto não tem linter instalado e adicionar um agora
// abriria um diff enorme de estilo. O que este script garante é o essencial que
// o CI não checava: nenhum arquivo do guarda entra na main com erro de parse,
// mesmo que nenhum teste o importe.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...jsFiles(full)); continue; }
    if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...jsFiles(path.join(guardRoot, 'src')), ...jsFiles(path.join(guardRoot, 'scripts'))];
const failures = [];
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (e) { failures.push(`${path.relative(guardRoot, file)}\n${String(e.stderr || e.message).trim()}`); }
}

if (failures.length) {
  console.error(`[lint] ${failures.length} arquivo(s) com erro de sintaxe:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`[lint] ${files.length} arquivo(s) do guarda sem erro de sintaxe.`);
