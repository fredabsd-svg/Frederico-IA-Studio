// Detecta a armadilha que derrubou o app inteiro: `export { X } from './m.js'`.
//
// Um re-export cria a ENTRADA DE EXPORTAÇÃO do módulo, mas NÃO uma variável
// local. Usar `X` dentro do mesmo arquivo é, portanto, referenciar um global que
// não existe — `ReferenceError` na primeira renderização. Num componente React
// isso não degrada nada: o ErrorBoundary da raiz captura e a aplicação inteira
// vira a tela "Algo deu errado por aqui".
//
// Nada mais no projeto pega isso: `node --check` não pega (a sintaxe é válida),
// o build não pega (o bundler resolve exportações, não escopo) e os testes não
// pegam (nenhum importa o componente). Por isso a conferência é textual e vive
// aqui, sem depender de um linter novo — a mesma decisão já registrada em
// `lint.mjs`.

// Troca o conteúdo de comentários e literais por espaços, preservando as quebras
// de linha (para o número da linha continuar certo) e as ASPAS/CRASES (para o
// formato `from '...'` continuar reconhecível). Sem isto, um nome citado num
// comentário contaria como uso real.
export function stripCommentsAndLiterals(source) {
  const out = Array.from(source);
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  // Heurística padrão para diferenciar divisão de literal de expressão regular:
  // depois destes caracteres, uma `/` só pode iniciar uma regex.
  const regexAllowedAfter = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^']);
  const prevMeaningful = (at) => {
    for (let k = at - 1; k >= 0; k--) {
      if (!/\s/.test(source[k]) || source[k] === '\n') return source[k];
    }
    return '\n';
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && next === '*') {
      blank(i++); blank(i++);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      blank(i++); blank(i++);
      continue;
    }
    if (c === '"' || c === "'") {
      i++; // mantém a aspa de abertura
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') blank(i++);
        if (i < source.length) blank(i++);
      }
      i++; // mantém a aspa de fechamento
      continue;
    }
    if (c === '`') {
      i++;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') { blank(i++); if (i < source.length) blank(i++); continue; }
        // `${...}` é código de verdade: preserva o miolo. (Uma string com crase
        // DENTRO da interpolação não é tratada — some do escopo desta conferência.)
        if (source[i] === '$' && source[i + 1] === '{') {
          i++; // passa o `$`; a contagem começa na chave, senão fecha na hora
          let depth = 0;
          do {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            i++;
          } while (i < source.length && depth > 0);
          continue;
        }
        blank(i++);
      }
      i++;
      continue;
    }
    if (c === '/' && regexAllowedAfter.has(prevMeaningful(i))) {
      i++; // mantém a barra de abertura
      let inClass = false;
      while (i < source.length && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') { blank(i++); if (i < source.length) blank(i++); continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '\n') break; // regex não atravessa linha: era divisão
        blank(i++);
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

const IDENT = '[A-Za-z_$][\\w$]*';

// Nomes que o arquivo realmente declara: imports, const/let/var, function e class.
// `export { X } from` de propósito NÃO entra aqui — é justamente o que não cria
// binding. Um `import { X } from 'm'` junto do re-export, sim, torna o uso legítimo.
function locallyBoundNames(code) {
  const names = new Set();
  const add = (n) => { if (n && n !== 'default') names.add(n); };

  for (const m of code.matchAll(new RegExp(`import\\s+([^;]*?)\\s+from\\s*['"]`, 'g'))) {
    const clause = m[1];
    for (const named of clause.matchAll(new RegExp(`\\{([^}]*)\\}`, 'g'))) {
      for (const part of named[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        add((bits[1] || bits[0] || '').trim());
      }
    }
    for (const ns of clause.matchAll(new RegExp(`\\*\\s*as\\s+(${IDENT})`, 'g'))) add(ns[1]);
    const def = clause.replace(new RegExp(`\\{[^}]*\\}`, 'g'), '').replace(new RegExp(`\\*\\s*as\\s+${IDENT}`, 'g'), '');
    for (const d of def.split(',')) add(d.trim());
  }
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})`, 'g'))) add(m[1]);
  for (const m of code.matchAll(new RegExp(`\\b(?:function|class)\\s*\\*?\\s*(${IDENT})`, 'g'))) add(m[1]);
  // Desestruturação: `const { a, b: c } = ...` e `const [a, b] = ...`.
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s*[{[]([^}\\]]*)[}\\]]`, 'g'))) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(':');
      add((bits[1] || bits[0] || '').trim().replace(/^\.\.\./, ''));
    }
  }
  return names;
}

// Devolve os nomes re-exportados que o próprio arquivo usa como valor — ou seja,
// os que vão estourar ReferenceError. Lista vazia = arquivo saudável.
export function findReexportBindingBugs(source) {
  const code = stripCommentsAndLiterals(source);
  const bound = locallyBoundNames(code);

  const reexports = []; // { name, index }
  // `export { A, B as C } from '...'`
  const braceForm = new RegExp(`export\\s*\\{([^}]*)\\}\\s*from\\s*['"]`, 'g');
  // `export * as ns from '...'`
  const starForm = new RegExp(`export\\s*\\*\\s*as\\s+(${IDENT})\\s+from\\s*['"]`, 'g');

  // O trecho do próprio re-export não conta como uso: some com ele na cópia.
  let usable = code;
  const erase = (start, end) => {
    usable = usable.slice(0, start) + usable.slice(start, end).replace(/[^\n]/g, ' ') + usable.slice(end);
  };

  for (const m of code.matchAll(braceForm)) {
    for (const part of m[1].split(',')) {
      for (const bit of part.trim().split(/\s+as\s+/)) {
        const name = bit.trim();
        if (name && name !== 'default') reexports.push({ name, index: m.index });
      }
    }
    erase(m.index, m.index + m[0].length);
  }
  for (const m of code.matchAll(starForm)) {
    reexports.push({ name: m[1], index: m.index });
    erase(m.index, m.index + m[0].length);
  }

  const problems = [];
  const seen = new Set();
  for (const { name, index } of reexports) {
    if (bound.has(name) || seen.has(name)) continue;
    if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(usable)) continue;
    seen.add(name);
    problems.push({ name, line: code.slice(0, index).split('\n').length });
  }
  return problems;
}
