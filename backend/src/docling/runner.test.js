// Cliente do docling-service: submissão, acompanhamento, progresso, timeout,
// cancelamento e falhas. Antes não havia teste nenhum aqui — todo o contrato
// com o serviço Python (o ponto onde o PDF vira Markdown) dependia de teste
// manual. O `fetch` global é substituído por um duplo controlado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDocling, doclingHealth, cancelJob } from './runner.js';

const realFetch = globalThis.fetch;
const tmpFile = () => {
  const p = path.join(os.tmpdir(), `docling-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(p, '%PDF-1.4 conteudo de teste');
  return p;
};

// Servidor falso: `plan` descreve as respostas em ordem para GET /jobs/:id.
function stubFetch({ submit, polls = [], onCall } = {}) {
  const calls = [];
  let pollIndex = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    calls.push({ url: u, method });
    onCall?.({ url: u, method });
    if (u.endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', models_loaded: true }) };
    }
    if (u.endsWith('/jobs') && method === 'POST') {
      if (submit instanceof Error) throw submit;
      return { ok: submit.ok !== false, status: submit.status || 200, json: async () => submit };
    }
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    const body = polls[Math.min(pollIndex++, polls.length - 1)];
    if (body instanceof Error) throw body;
    return { ok: body.httpOk !== false, status: body.status || 200, json: async () => body };
  };
  return calls;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('runDocling: envia o arquivo, acompanha o job e devolve o resultado', async () => {
  process.env.DOCLING_POLL_MS = '10';
  const calls = stubFetch({
    submit: { job_id: 'j1', status: 'queued' },
    polls: [
      { status: 'processing', stage: 'analisando', progress: 0.1 },
      { status: 'processing', stage: 'convertendo', progress: 0.3 },
      { status: 'done', stage: 'concluído', progress: 1, result: { markdown: '<!-- page: 1 -->\nOlá', page_count: 1, table_count: 0 } },
    ],
  });
  const stages = [];
  const out = await runDocling(tmpFile(), { hash: 'h1', filename: 'x.pdf', onProgress: p => stages.push(p.stage) });

  assert.equal(out.status, 'done');
  assert.equal(out.page_count, 1);
  assert.match(out.markdown, /Olá/);
  assert.deepEqual(stages, ['analisando', 'convertendo', 'concluído']);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'o arquivo é enviado uma única vez');
});

test('runDocling: resultado já em cache no serviço volta na própria submissão', async () => {
  process.env.DOCLING_POLL_MS = '10';
  const calls = stubFetch({
    submit: { job_id: 'j2', status: 'done', result: { markdown: 'em cache', page_count: 3 }, cached: true },
  });
  const out = await runDocling(tmpFile(), { hash: 'h2', filename: 'x.pdf' });

  assert.equal(out.markdown, 'em cache');
  assert.equal(calls.filter(c => c.method === 'GET').length, 0, 'sem polling quando já veio pronto');
});

test('runDocling: falha do serviço vira erro com a mensagem do serviço', async () => {
  process.env.DOCLING_POLL_MS = '10';
  stubFetch({
    submit: { job_id: 'j3', status: 'queued' },
    polls: [{ status: 'failed', error: 'documento protegido por senha (password/encrypted)' }],
  });
  await assert.rejects(
    () => runDocling(tmpFile(), { hash: 'h3', filename: 'x.pdf' }),
    /protegido por senha/,
  );
});

test('runDocling: serviço fora do ar na submissão propaga o erro (o chamador cai no fallback)', async () => {
  stubFetch({ submit: { ok: false, status: 503 } });
  await assert.rejects(() => runDocling(tmpFile(), { hash: 'h4', filename: 'x.pdf' }), /HTTP 503/);
});

test('runDocling: submissão sem job_id é recusada em vez de fazer polling eterno', async () => {
  stubFetch({ submit: { status: 'queued' } });
  await assert.rejects(() => runDocling(tmpFile(), { hash: 'h5', filename: 'x.pdf' }), /job_id/);
});

test('runDocling: timeout cancela o job no serviço e interrompe', async () => {
  process.env.DOCLING_POLL_MS = '10';
  let deleted = false;
  stubFetch({
    submit: { job_id: 'j6', status: 'queued' },
    polls: [{ status: 'processing', stage: 'convertendo', progress: 0.5 }],
    onCall: ({ method }) => { if (method === 'DELETE') deleted = true; },
  });
  await assert.rejects(
    () => runDocling(tmpFile(), { hash: 'h6', filename: 'grande.pdf', timeoutMs: 40 }),
    /Timeout/,
  );
  assert.equal(deleted, true, 'o job precisa ser cancelado no serviço, não apenas abandonado');
});

test('runDocling: AbortSignal do usuário cancela o job no serviço', async () => {
  process.env.DOCLING_POLL_MS = '10';
  let deleted = false;
  stubFetch({
    submit: { job_id: 'j7', status: 'queued' },
    polls: [{ status: 'processing', stage: 'convertendo', progress: 0.4 }],
    onCall: ({ method }) => { if (method === 'DELETE') deleted = true; },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(
    () => runDocling(tmpFile(), { hash: 'h7', filename: 'x.pdf', signal: controller.signal }),
    /cancelad/i,
  );
  assert.equal(deleted, true);
});

test('runDocling: erro transitório no polling não derruba o processamento', async () => {
  process.env.DOCLING_POLL_MS = '10';
  stubFetch({
    submit: { job_id: 'j8', status: 'queued' },
    polls: [
      new Error('ECONNRESET'),                       // queda momentânea da rede interna
      { status: 'done', result: { markdown: 'ok', page_count: 1 } },
    ],
  });
  const out = await runDocling(tmpFile(), { hash: 'h8', filename: 'x.pdf' });
  assert.equal(out.markdown, 'ok');
});

test('doclingHealth: serviço no ar responde ok; fora do ar não lança', async () => {
  stubFetch({ submit: {} });
  assert.equal((await doclingHealth()).ok, true);

  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND docling-service'); };
  const down = await doclingHealth();
  assert.equal(down.ok, false);
  assert.match(down.error, /ENOTFOUND/);
});

test('cancelJob: nunca lança, mesmo com o serviço inacessível', async () => {
  globalThis.fetch = async () => { throw new Error('sem rede'); };
  assert.equal(await cancelJob('qualquer'), false);
});
