// Verificação offline do provedor falso: testa modelos ferramentas e travado
// sem precisar do backend completo. Serve de guarda contra regressão no formato
// do stream (especialmente do OpenAI tool_calls) sem exigir o Playwright.
import http from 'node:http';
import { criarProvedorFalso } from './fixtures/provedorFalso.mjs';

const base = await new Promise((resolve, reject) => {
  const servidor = criarProvedorFalso().listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${servidor.address().port}`);
  });
  servidor.on('error', reject);
});

async function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

async function post(url, headers, payload) {
  const dados = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados), ...headers }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
    req.write(dados);
    req.end();
  });
}

const cabecalho = { Authorization: 'Bearer teste', 'Content-Type': 'application/json' };

// 1) Catálogo restrito inclui o novo modelo `ferramentas`
const catalogo = await get(`${base}/apenas/ferramentas/v1/models`, cabecalho);
console.log('[catalogo]', catalogo.status, catalogo.body);
if (catalogo.status !== 200 || !catalogo.body.includes('"ferramentas"')) {
  console.error('FALHA: catálogo não inclui ferramentas');
  process.exit(1);
}

// 2) Stream com tool_calls: deve emitir role + tool_calls delta + finish_reason tool_calls + DONE
const stream1 = await post(`${base}/apenas/ferramentas/v1/chat/completions`, cabecalho, {
  model: 'ferramentas',
  stream: true,
  messages: [{ role: 'user', content: 'roda uma ferramenta' }]
});
console.log('[stream 1ª chamada]', stream1.status);
const eventos1 = stream1.body.split('\n\n').filter(Boolean).map((b) => b.replace(/^data:\s*/, ''));
console.log('  eventos:', eventos1.length, '— finish_reason tool_calls?', eventos1.some((e) => e.includes('"finish_reason":"tool_calls"')));
console.log('  contém "bash"?', eventos1.some((e) => e.includes('"name":"bash"')));
console.log('  contém "echo ok-e2e-tool"?', eventos1.some((e) => e.includes('echo ok-e2e-tool')));
console.log('  último [DONE]?', eventos1[eventos1.length - 1] === '[DONE]');

if (!eventos1.some((e) => e.includes('"finish_reason":"tool_calls"'))) {
  console.error('FALHA: stream não terminou com finish_reason=tool_calls');
  process.exit(1);
}
if (!eventos1.some((e) => e.includes('"name":"bash"'))) {
  console.error('FALHA: stream não contém tool_call com name=bash');
  process.exit(1);
}

// 3) Volta do tool: deve emitir texto e terminar com stop
const stream2 = await post(`${base}/apenas/ferramentas/v1/chat/completions`, cabecalho, {
  model: 'ferramentas',
  stream: true,
  messages: [
    { role: 'user', content: 'roda uma ferramenta' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_e2e_1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo ok-e2e-tool"}' } }] },
    { role: 'tool', tool_call_id: 'call_e2e_1', content: 'ok-e2e-tool\n' }
  ]
});
console.log('[stream 2ª chamada]', stream2.status);
const eventos2 = stream2.body.split('\n\n').filter(Boolean).map((b) => b.replace(/^data:\s*/, ''));
const temTextoFinal = eventos2.some((e) => e.includes('"content":"ok-e2e-tool recebido"'));
const temStopFinal = eventos2.some((e) => e.includes('"finish_reason":"stop"'));
console.log('  contém "ok-e2e-tool recebido"?', temTextoFinal);
console.log('  termina com stop?', temStopFinal);
if (!temTextoFinal || !temStopFinal) {
  console.error('FALHA: 2ª chamada não devolveu texto e stop');
  process.exit(1);
}

// 4) Travado: envia role inicial e nunca mais. Verifica com leitura parcial:
//    o primeiro delta chega (role), mas nada mais vem num intervalo razoável.
const uTravado = new URL(`${base}/apenas/travado/v1/chat/completions`);
const travadoPromise = new Promise((resolve, reject) => {
  const req = http.request({
    hostname: uTravado.hostname,
    port: uTravado.port,
    path: uTravado.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify({ model: 'travado', stream: true, messages: [{ role: 'user', content: 'oi' }] })), ...cabecalho }
  }, (res) => {
    let body = '';
    let primeiroDelta = null;
    const timer = setTimeout(() => {
      // 600ms é mais que o suficiente para o role chunk chegar (escrita
      // síncrona). Se não chegou nada, falha. Se chegou só o role e nunca
      // mais, sucesso.
      req.destroy();
      resolve({ status: res.statusCode, body, primeiroDelta, stallConfirmado: primeiroDelta && !body.includes('[DONE]') });
    }, 600);
    res.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (!primeiroDelta && body.includes('"role":"assistant"')) primeiroDelta = body;
    });
    res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body, primeiroDelta, stallConfirmado: false }); });
    res.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ model: 'travado', stream: true, messages: [{ role: 'user', content: 'oi' }] }));
  req.end();
});

const travado = await travadoPromise;
console.log('[stream travado]', travado.status, '— primeiro delta (role)?', Boolean(travado.primeiroDelta), '— stall confirmado?', travado.stallConfirmado);
if (!travado.primeiroDelta) {
  console.error('FALHA: travado não enviou o delta inicial (role)');
  process.exit(1);
}
if (!travado.stallConfirmado) {
  console.error('FALHA: travado deveria ficar em silêncio após o role chunk');
  process.exit(1);
}

console.log('\nOK: provedor falso passa nos três novos comportamentos.');
process.exit(0);
