// Detecta o `React.lazy` apontado para um módulo SEM `export default`.
//
// `lazy(() => import('./X.jsx'))` exige que o módulo resolva para um objeto com
// `default` sendo o componente. Todos os componentes deste projeto são exports
// NOMEADOS (`export function X`), então esse import resolve `default` como
// `undefined` e o React derruba a árvore inteira no error boundary — o mesmo
// sintoma do `reexportBindings.mjs`: a tela "Algo deu errado por aqui".
//
// A forma correta é remapear: `import('./X.jsx').then(m => ({ default: m.X }))`.
//
// Por que a conferência vive aqui, e não num linter novo: nada mais pega isto.
// `node --check` não pega (a sintaxe é válida), o build não pega (o bundler
// resolve exportações, não o formato que o `lazy` espera) e os testes de módulo
// não pegam (nenhum importa o componente). Foi assim que os oito `lazy()` de uma
// vez entraram quebrados e só o teste de navegador acusou.
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsAndLiterals } from './reexportBindings.mjs';

// `lazy(` ... `import('<caminho>')` até o fecha-parênteses da chamada. O
// caminho é capturado do source ORIGINAL (o texto sanitizado esvazia literais),
// usando os índices que o casamento devolve.
const LAZY_RE = /\blazy\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*(['"`])/g;

// Um módulo tem default se declara `export default` ou o reexporta.
function hasDefaultExport(source) {
  const clean = stripCommentsAndLiterals(source);
  if (/\bexport\s+default\b/.test(clean)) return true;
  if (/\bexport\s*\{[^}]*\bdefault\b[^}]*\}/.test(clean)) return true;
  return false;
}

// Devolve `{ line, spec, resolved }` para cada `lazy(() => import(...))` que
// aponta para um módulo local sem `default` e sem o remapeamento `.then(...)`.
// Imports de pacote (sem `./` ou `../`) são ignorados: não são nossos.
export function findLazyDefaultBugs(source, fromFile, { readFile = f => fs.readFileSync(f, 'utf8'), exists = f => fs.existsSync(f) } = {}) {
  const clean = stripCommentsAndLiterals(source);
  const bugs = [];
  let m;
  LAZY_RE.lastIndex = 0;
  while ((m = LAZY_RE.exec(clean))) {
    const quote = m[1];
    const start = m.index + m[0].length;
    const end = source.indexOf(quote, start);
    if (end < 0) continue;
    const spec = source.slice(start, end);
    LAZY_RE.lastIndex = end;
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;

    // O remapeamento `.then(m => ({ default: ... }))` tem de vir COLADO ao
    // `import(...)` deste lazy. A conferência é ancorada logo após a aspa de
    // fechamento do caminho de propósito: uma janela solta enxergaria o `.then`
    // do `lazy` da linha SEGUINTE e daria o quebrado como bom.
    const cauda = clean.slice(end + quote.length, end + quote.length + 40);
    if (/^\s*\)\s*\.\s*then\s*\(/.test(cauda)) continue;

    const resolved = path.resolve(path.dirname(fromFile), spec);
    if (!exists(resolved)) continue;         // caminho quebrado é outro problema
    if (hasDefaultExport(readFile(resolved))) continue;

    bugs.push({
      line: source.slice(0, m.index).split('\n').length,
      spec,
      resolved
    });
  }
  return bugs;
}
