import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Regressão: o App tinha `useState`/`useEffect` DEPOIS dos retornos antecipados
// (sessão expirada / erro de conexão). Quando um deles disparava, o React via
// menos hooks que no render anterior e derrubava a árvore inteira — o usuário
// recebia a tela de erro genérica em vez de "Sua sessão expirou".
test('App.jsx não declara hooks depois dos retornos antecipados', () => {
  const src = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
  const early = src.indexOf('\n  if (needLogin) {');
  assert.ok(early > 0, 'retorno antecipado de login não encontrado');
  const tail = src.slice(early);
  const hook = tail.match(/\buse(State|Effect|Memo|Ref|Callback|LayoutEffect)\(/);
  assert.equal(hook, null, `hook depois do retorno antecipado: ${hook?.[0]}`);
});

// O wiring do Modo Desenvolvedor vivia num plugin do Vite que reescrevia o
// App.jsx por substituição de texto; se a âncora mudasse, a correção sumia em
// silêncio. Agora está na fonte — este teste garante que continue lá.
test('App.jsx semeia a sessão dev ao entrar no workspace Desenvolvedor', () => {
  const src = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
  assert.match(src, /function seedDeveloperSessionFromActive\(/);
  assert.match(src, /next === 'developer' && !seedDeveloperSessionFromActive\(\)/);
  assert.equal(/appDevNinoPatchPlugin/.test(fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8')), false);
});
