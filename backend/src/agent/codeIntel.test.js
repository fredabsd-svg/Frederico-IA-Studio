import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findFiles, globToRegExp, searchText, walkWorkspace } from './codeIntel.js';

function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-codeintel-'));
  fs.mkdirSync(path.join(base, 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(base, 'node_modules', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(base, '.git'), { recursive: true });
  fs.writeFileSync(path.join(base, 'src', 'app.js'), 'const total = soma(1, 2);\nexport function soma(a, b) { return a + b; }\n');
  fs.writeFileSync(path.join(base, 'src', 'hooks', 'useChat.js'), '// consome o stream\nfunction consumeChatStream() {}\n');
  fs.writeFileSync(path.join(base, 'node_modules', 'lib', 'index.js'), 'function soma() {}\n');
  fs.writeFileSync(path.join(base, '.git', 'config'), 'soma\n');
  fs.writeFileSync(path.join(base, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  return base;
}

test('globToRegExp: ** cruza diretórios, * não cruza', () => {
  assert.equal(globToRegExp('src/**/*.js').test('src/hooks/useChat.js'), true);
  assert.equal(globToRegExp('src/*.js').test('src/hooks/useChat.js'), false);
  assert.equal(globToRegExp('src/*.js').test('src/app.js'), true);
  assert.equal(globToRegExp('*.PNG').test('logo.png'), true, 'case-insensitive');
});

test('walkWorkspace exclui dependências/escrituração e devolve caminhos relativos', () => {
  const base = makeWorkspace();
  const { files } = walkWorkspace(base);
  assert.ok(files.includes('src/app.js'));
  assert.ok(!files.some(f => f.startsWith('node_modules/')), 'node_modules fora');
  assert.ok(!files.some(f => f.startsWith('.git/')), '.git fora');
});

test('findFiles: glob e trecho do nome, com aviso de corte', () => {
  const base = makeWorkspace();
  assert.deepEqual(findFiles(base, 'src/**/*.js').files.sort(), ['src/app.js', 'src/hooks/useChat.js']);
  assert.deepEqual(findFiles(base, 'usechat').files, ['src/hooks/useChat.js'], 'trecho case-insensitive');
  const cut = findFiles(base, '**', { limit: 1 });
  assert.equal(cut.files.length, 1);
  assert.equal(cut.truncated, true);
  assert.match(findFiles(base, '  ').error, /padrão/);
});

test('searchText: literal, regex, filtro glob e binário ignorado', () => {
  const base = makeWorkspace();
  const literal = searchText(base, { pattern: 'soma(1, 2)' });
  assert.equal(literal.matches.length, 1);
  assert.equal(literal.matches[0].file, 'src/app.js');
  assert.equal(literal.matches[0].line, 1);

  const rx = searchText(base, { pattern: 'function \\w+Stream', regex: true });
  assert.equal(rx.matches.length, 1);
  assert.equal(rx.matches[0].file, 'src/hooks/useChat.js');

  const filtered = searchText(base, { pattern: 'soma', glob: 'src/hooks/**' });
  assert.equal(filtered.matches.length, 0, 'o filtro glob restringe os arquivos');

  // node_modules/.git nunca entram; o PNG binário não é lido como texto.
  const all = searchText(base, { pattern: 'soma' });
  assert.ok(all.matches.every(m => m.file.startsWith('src/')));
});

test('searchText: regex inválida devolve erro claro (vai ao modelo, não explode)', () => {
  const base = makeWorkspace();
  assert.match(searchText(base, { pattern: '([', regex: true }).error, /inválida/);
  assert.match(searchText(base, { pattern: '' }).error, /Informe/);
});

test('searchText: limite total corta com aviso explícito', () => {
  const base = makeWorkspace();
  fs.writeFileSync(path.join(base, 'muitos.txt'), Array.from({ length: 50 }, (_, i) => `alvo ${i}`).join('\n'));
  const r = searchText(base, { pattern: 'alvo', limit: 5 });
  assert.equal(r.matches.length, 5);
  assert.equal(r.truncated, true);
});
