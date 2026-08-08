// Servidor de pré-visualização (Fase 38): contenção de caminho e resposta HTTP
// de verdade. Não precisa de navegador — o servidor é exercitado com fetch.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mimeFor, resolveWithinRoot, startPreviewServer } from './pagePreviewServer.js';

function montarRaiz() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-preview-'));
  fs.mkdirSync(path.join(root, 'site', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site', 'index.html'), '<!doctype html><title>Oi</title><h1>Olá</h1>');
  fs.writeFileSync(path.join(root, 'site', 'assets', 'app.css'), 'h1{color:red}');
  fs.writeFileSync(path.join(root, 'site', 'com espaço.html'), '<p>espaço</p>');
  return root;
}

test('mimeFor conhece os tipos de uma página real e nunca inventa HTML', () => {
  assert.match(mimeFor('a/b/index.html'), /^text\/html/);
  assert.match(mimeFor('app.CSS'), /^text\/css/);
  assert.equal(mimeFor('bundle.wasm'), 'application/wasm');
  // Extensão desconhecida NÃO pode virar text/html: o navegador executaria.
  assert.equal(mimeFor('estranho.qualquer'), 'application/octet-stream');
  assert.equal(mimeFor(''), 'application/octet-stream');
});

test('resolveWithinRoot aceita o que está dentro e recusa travessia', () => {
  const root = montarRaiz();
  assert.ok(resolveWithinRoot(root, '/site/index.html'));
  assert.ok(resolveWithinRoot(root, '/site/assets/app.css'));
  assert.equal(resolveWithinRoot(root, '/../../etc/passwd'), null);
  assert.equal(resolveWithinRoot(root, '/site/../../fora.txt'), null);
  assert.equal(resolveWithinRoot(root, '/'), null);
  assert.equal(resolveWithinRoot(root, '/site'), null, 'diretório não é arquivo');
  assert.equal(resolveWithinRoot(root, '/nao-existe.html'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveWithinRoot recusa travessia mesmo percent-encoded', () => {
  const root = montarRaiz();
  // %2e%2e%2f = "../" — sem decodificar antes de conferir, isto passaria.
  assert.equal(resolveWithinRoot(root, '/%2e%2e%2f%2e%2e%2fetc%2fpasswd'), null);
  // Percent-encoding inválido é recusado em vez de tratado como literal.
  assert.equal(resolveWithinRoot(root, '/site/%zz.html'), null);
  // Já um espaço codificado é legítimo e precisa funcionar.
  assert.ok(resolveWithinRoot(root, '/site/com%20espa%C3%A7o.html'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('link simbólico apontando para fora da raiz é recusado', () => {
  const root = montarRaiz();
  const alvoFora = path.join(os.tmpdir(), `fred-preview-fora-${process.pid}.txt`);
  fs.writeFileSync(alvoFora, 'segredo do host');
  fs.symlinkSync(alvoFora, path.join(root, 'site', 'escapa.txt'));
  // O arquivo EXISTE e é legível — o que o recusa é o destino real cair fora.
  assert.equal(fs.readFileSync(path.join(root, 'site', 'escapa.txt'), 'utf8'), 'segredo do host');
  assert.equal(resolveWithinRoot(root, '/site/escapa.txt'), null);
  fs.rmSync(alvoFora, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('o servidor entrega a página e o asset, e responde 404 fora da raiz', async () => {
  const root = montarRaiz();
  const srv = await startPreviewServer(root);
  try {
    assert.match(srv.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    const pagina = await fetch(`${srv.origin}/site/index.html`);
    assert.equal(pagina.status, 200);
    assert.match(pagina.headers.get('content-type'), /text\/html/);
    assert.equal(pagina.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await pagina.text(), /Olá/);

    const css = await fetch(`${srv.origin}/site/assets/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    assert.equal((await fetch(`${srv.origin}/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${srv.origin}/site/`)).status, 404);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('o servidor é somente leitura: POST/PUT/DELETE recebem 405', async () => {
  const root = montarRaiz();
  const srv = await startPreviewServer(root);
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${srv.origin}/site/index.html`, { method });
      assert.equal(res.status, 405, `${method} deveria ser recusado`);
    }
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('close() derruba o servidor — a validação não deixa porta aberta', async () => {
  const root = montarRaiz();
  const srv = await startPreviewServer(root);
  const { origin } = srv;
  await srv.close();
  await assert.rejects(() => fetch(`${origin}/site/index.html`));
  fs.rmSync(root, { recursive: true, force: true });
});
