// Testes do guarda de rede da miniatura de página (pageShot.js).
// Roda com: node --test src/agent/pageShot.test.js
//
// Não sobem navegador: `allowRequest` e `nextRedirect` são puros, e `guardRoute`
// só depende da INTERFACE do `route` do Playwright (request/fetch/abort/fulfill),
// então um duplo de teste exercita o caminho de verdade — inclusive a caminhada
// pelos redirecionamentos, que é onde mora o risco de SSRF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allowRequest, nextRedirect, guardRoute } from './pageShot.js';

// ── allowRequest ────────────────────────────────────────────────────────────

test('allowRequest libera http(s) para host público', () => {
  assert.equal(allowRequest('https://exemplo.com/pagina', 'document'), true);
  assert.equal(allowRequest('http://exemplo.com/img.png', 'image'), true);
});

test('allowRequest bloqueia loopback, rede interna e endereço de metadados', () => {
  for (const url of [
    'http://localhost:3001/api/me',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',   // credenciais de instância na nuvem
    'http://backend.internal/',
    'http://algo.local/'
  ]) {
    assert.equal(allowRequest(url, 'document'), false, `deveria bloquear ${url}`);
  }
});

test('allowRequest bloqueia esquemas que não são http(s)', () => {
  for (const url of ['file:///etc/passwd', 'ftp://exemplo.com/x', 'javascript:alert(1)', 'data:text/html,<h1>x']) {
    assert.equal(allowRequest(url, 'document'), false, `deveria bloquear ${url}`);
  }
});

test('allowRequest bloqueia mídia pesada que não agrega à miniatura', () => {
  assert.equal(allowRequest('https://exemplo.com/v.mp4', 'media'), false);
  assert.equal(allowRequest('https://exemplo.com/ws', 'websocket'), false);
  assert.equal(allowRequest('https://exemplo.com/sse', 'eventsource'), false);
  // ...mas o que compõe a página continua passando.
  assert.equal(allowRequest('https://exemplo.com/estilo.css', 'stylesheet'), true);
});

test('allowRequest NEGA quando a URL é ilegível (falha fechada)', () => {
  // O código antigo, em puppeteer, fazia `catch { req.continue() }` — ou seja,
  // uma URL que não parseia seguia SEM guarda. Aqui o padrão é negar.
  for (const url of ['', 'nao-e-url', null, undefined, '://quebrado']) {
    assert.equal(allowRequest(url, 'document'), false, `deveria bloquear ${JSON.stringify(url)}`);
  }
});

// ── nextRedirect ────────────────────────────────────────────────────────────

test('nextRedirect encerra quando não é redirecionamento', () => {
  assert.deepEqual(nextRedirect('https://exemplo.com/', 200, undefined), { done: true });
  assert.deepEqual(nextRedirect('https://exemplo.com/', 404, undefined), { done: true });
  // 3xx sem Location não tem para onde ir.
  assert.deepEqual(nextRedirect('https://exemplo.com/', 302, undefined), { done: true });
});

test('nextRedirect resolve destino relativo contra a URL atual', () => {
  assert.deepEqual(
    nextRedirect('https://exemplo.com/a/b', 302, '/final'),
    { url: 'https://exemplo.com/final' }
  );
});

test('nextRedirect BLOQUEIA salto para rede interna', () => {
  // O cenário de ataque: página pública responde 302 para o endereço de
  // metadados da nuvem. O `page.route()` do Playwright não é chamado de novo
  // nesse salto, então é AQUI que ele tem de morrer.
  assert.deepEqual(nextRedirect('https://exemplo.com/', 302, 'http://169.254.169.254/latest/meta-data/'), { blocked: true });
  assert.deepEqual(nextRedirect('https://exemplo.com/', 301, 'http://127.0.0.1:3001/api/me'), { blocked: true });
  assert.deepEqual(nextRedirect('https://exemplo.com/', 307, 'file:///etc/passwd'), { blocked: true });
});

// ── guardRoute (com duplo do `route` do Playwright) ──────────────────────────

// Duplo do `route`: registra o que foi pedido e responde conforme o roteiro.
function fakeRoute(url, { resourceType = 'document', respostas = [] } = {}) {
  const registro = { fetched: [], aborted: false, fulfilled: null };
  let i = 0;
  return {
    registro,
    request: () => ({ url: () => url, resourceType: () => resourceType }),
    fetch: async ({ url: alvo, maxRedirects }) => {
      registro.fetched.push({ url: alvo, maxRedirects });
      const passo = respostas[i++];
      if (!passo) throw new Error('roteiro acabou');
      if (passo.erro) throw new Error(passo.erro);
      return { status: () => passo.status, headers: () => passo.headers || {} };
    },
    abort: async () => { registro.aborted = true; },
    fulfill: async ({ response }) => { registro.fulfilled = response; }
  };
}

test('guardRoute entrega resposta simples sem redirecionamento', async () => {
  const route = fakeRoute('https://exemplo.com/', { respostas: [{ status: 200 }] });
  await guardRoute(route);
  assert.equal(route.registro.aborted, false);
  assert.ok(route.registro.fulfilled, 'deveria ter entregue a resposta à página');
  assert.equal(route.registro.fetched.length, 1);
  // maxRedirects: 0 é o que obriga o guarda a ver cada salto.
  assert.equal(route.registro.fetched[0].maxRedirects, 0);
});

test('guardRoute nem busca quando o host já é proibido', async () => {
  const route = fakeRoute('http://169.254.169.254/latest/meta-data/');
  await guardRoute(route);
  assert.equal(route.registro.aborted, true);
  assert.equal(route.registro.fetched.length, 0, 'não pode nem chegar a fazer a requisição');
  assert.equal(route.registro.fulfilled, null);
});

test('guardRoute segue redirecionamento para host público', async () => {
  const route = fakeRoute('https://exemplo.com/a', {
    respostas: [
      { status: 302, headers: { location: 'https://exemplo.com/b' } },
      { status: 200 }
    ]
  });
  await guardRoute(route);
  assert.equal(route.registro.aborted, false);
  assert.ok(route.registro.fulfilled);
  assert.deepEqual(route.registro.fetched.map(f => f.url), [
    'https://exemplo.com/a',
    'https://exemplo.com/b'
  ]);
});

test('guardRoute ABORTA redirecionamento de página pública para rede interna', async () => {
  // A regressão que a troca do puppeteer para o Playwright poderia introduzir.
  const route = fakeRoute('https://exemplo.com/inocente', {
    respostas: [{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }]
  });
  await guardRoute(route);
  assert.equal(route.registro.aborted, true);
  assert.equal(route.registro.fulfilled, null, 'a página NÃO pode receber nada da rede interna');
  assert.equal(route.registro.fetched.length, 1, 'o salto proibido não chega a ser buscado');
});

test('guardRoute aborta no salto interno mesmo depois de saltos públicos', async () => {
  // Cadeia com disfarce: dois saltos legítimos e só então o desvio interno.
  const route = fakeRoute('https://exemplo.com/1', {
    respostas: [
      { status: 302, headers: { location: 'https://exemplo.com/2' } },
      { status: 302, headers: { location: 'https://outro.com/3' } },
      { status: 302, headers: { location: 'http://10.0.0.7/admin' } }
    ]
  });
  await guardRoute(route);
  assert.equal(route.registro.aborted, true);
  assert.equal(route.registro.fulfilled, null);
});

test('guardRoute não fica preso em laço de redirecionamento', async () => {
  const respostas = Array.from({ length: 20 }, (_, i) => ({
    status: 302, headers: { location: `https://exemplo.com/${i + 1}` }
  }));
  const route = fakeRoute('https://exemplo.com/0', { respostas });
  await guardRoute(route);
  // Para de seguir no teto e entrega o que tem — o que importa é terminar.
  assert.ok(route.registro.fetched.length <= 6, `seguiu ${route.registro.fetched.length} saltos`);
});

test('guardRoute aborta quando a busca falha (não deixa seguir sem guarda)', async () => {
  const route = fakeRoute('https://exemplo.com/', { respostas: [{ erro: 'ECONNRESET' }] });
  await guardRoute(route);
  assert.equal(route.registro.aborted, true);
  assert.equal(route.registro.fulfilled, null);
});
