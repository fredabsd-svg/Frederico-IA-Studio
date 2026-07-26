#!/usr/bin/env node
// Conferência de sintaxe de todos os módulos do frontend (`node --check`).
// Não é um ESLint — o projeto não tem linter instalado e adicionar um agora
// abriria um diff enorme de estilo. O que este script garante é o essencial que
// o CI não checava: nenhum arquivo .js/.mjs do frontend entra na main com erro
// de parse, mesmo que nenhum teste o importe. Os .jsx ficam de fora porque o
// `node --check` não conhece JSX — eles são cobertos pelo `npm run build`
// (o esbuild do Vite falha em qualquer erro de sintaxe), que o script `check`
// executa logo em seguida.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findReexportBindingBugs } from './reexportBindings.mjs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir, match) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(full, match)); continue; }
    if (match.test(entry.name)) out.push(full);
  }
  return out;
}

const roots = [path.join(frontendRoot, 'src'), path.join(frontendRoot, 'scripts')];
const rel = (f) => path.relative(frontendRoot, f);

const files = roots.flatMap(d => sourceFiles(d, /\.(js|mjs)$/));
const failures = [];
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (e) { failures.push(`${rel(file)}\n${String(e.stderr || e.message).trim()}`); }
}

if (failures.length) {
  console.error(`[lint] ${failures.length} arquivo(s) com erro de sintaxe:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}

// Conferência de escopo dos re-exports. Vale também para os .jsx — que o
// `node --check` não consegue ler e que, até aqui, não tinham conferência
// nenhuma. Foi exatamente num .jsx que um `export { X } from '...'` usado como
// se fosse variável local derrubou o app inteiro (ver `reexportBindings.mjs`).
const scoped = roots.flatMap(d => sourceFiles(d, /\.(js|mjs|jsx)$/));
const scopeErrors = [];
for (const file of scoped) {
  for (const bug of findReexportBindingBugs(fs.readFileSync(file, 'utf8'))) {
    scopeErrors.push(
      `${rel(file)}:${bug.line} — "${bug.name}" vem de um re-export (\`export { ${bug.name} } from ...\`), ` +
      `que NÃO cria variável local, mas é usado neste arquivo: vira ReferenceError em tempo de execução. ` +
      `Importe o nome (\`import { ${bug.name} } from ...\`) e, se precisar, reexporte-o depois.`
    );
  }
}

if (scopeErrors.length) {
  console.error(`[lint] ${scopeErrors.length} uso(s) de re-export sem binding local:\n\n${scopeErrors.join('\n\n')}`);
  process.exit(1);
}

console.log(`[lint] ${files.length} arquivo(s) sem erro de sintaxe; ${scoped.length} arquivo(s) com re-exports conferidos.`);
