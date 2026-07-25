import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import net from 'net';
import { scanBuffer, scanUploadBatch } from './clamav.js';

// clamd de mentira: implementa o INSTREAM o suficiente para os testes.
// Responde FOUND quando o conteúdo contém "EICAR", OK caso contrário.
function fakeClamd() {
  const server = net.createServer((socket) => {
    const parts = [];
    socket.on('data', (d) => {
      parts.push(d);
      const all = Buffer.concat(parts);
      // fim do stream = bloco de tamanho zero (4 bytes 0) no final
      if (all.length >= 4 && all.readUInt32BE(all.length - 4) === 0) {
        const infected = all.includes('EICAR');
        socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const { server, port } = await fakeClamd();
after(() => server.close());
const opts = { host: '127.0.0.1', port, timeoutMs: 5000 };

test('arquivo limpo passa na varredura', async () => {
  const r = await scanBuffer(Buffer.from('planilha inofensiva'), opts);
  assert.equal(r.clean, true);
});

test('arquivo infectado é detectado com o nome do vírus', async () => {
  const r = await scanBuffer(Buffer.from('conteudo com EICAR dentro'), opts);
  assert.equal(r.clean, false);
  assert.equal(r.virus, 'Eicar-Test-Signature');
});

test('arquivo maior que um bloco (64 KB) é enviado em pedaços e escaneado', async () => {
  const big = Buffer.alloc(200 * 1024, 'a');
  const r = await scanBuffer(big, opts);
  assert.equal(r.clean, true);
});

test('daemon inacessível rejeita a Promise em vez de aprovar em silêncio', async () => {
  await assert.rejects(scanBuffer(Buffer.from('x'), { host: '127.0.0.1', port: 1, timeoutMs: 2000 }));
});

test('lote separa aprovados de recusados', async () => {
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(port);
  try {
    const files = [
      { originalname: 'bom.txt', buffer: Buffer.from('ok') },
      { originalname: 'mau.txt', buffer: Buffer.from('EICAR') },
    ];
    const r = await scanUploadBatch(files);
    assert.equal(r.scanned, true);
    assert.deepEqual(r.clean.map(f => f.originalname), ['bom.txt']);
    assert.deepEqual(r.rejected.map(x => x.file.originalname), ['mau.txt']);
  } finally {
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
  }
});

test('sem CLAMAV_HOST a varredura fica desligada e nada é recusado', async () => {
  delete process.env.CLAMAV_HOST;
  const r = await scanUploadBatch([{ originalname: 'a.txt', buffer: Buffer.from('EICAR') }]);
  assert.equal(r.scanned, false);
  assert.equal(r.clean.length, 1);
  assert.equal(r.rejected.length, 0);
});

test('clamd fora do ar + CLAMAV_REQUIRED=true recusa o envio com 503', async () => {
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = '1'; // porta fechada
  process.env.CLAMAV_REQUIRED = 'true';
  process.env.CLAMAV_TIMEOUT_MS = '2000';
  try {
    await assert.rejects(
      scanUploadBatch([{ originalname: 'a.txt', buffer: Buffer.from('x') }]),
      (err) => err.status === 503,
    );
  } finally {
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
    delete process.env.CLAMAV_REQUIRED;
    delete process.env.CLAMAV_TIMEOUT_MS;
  }
});

// ---- Política explícita e honestidade do selo "verificado" (auditoria 2026-07)

test('scanPolicy descreve o modo vigente (desligado / obrigatório / degradável)', async () => {
  const { scanPolicy } = await import('./clamav.js');
  delete process.env.CLAMAV_HOST;
  assert.equal(scanPolicy().mode, 'desligado');
  assert.equal(scanPolicy().enabled, false);

  process.env.CLAMAV_HOST = '127.0.0.1';
  delete process.env.CLAMAV_REQUIRED;
  assert.equal(scanPolicy().mode, 'degradavel');
  assert.match(scanPolicy().descricao, /NÃO VERIFICADO/);

  process.env.CLAMAV_REQUIRED = 'true';
  assert.equal(scanPolicy().mode, 'obrigatorio');
  assert.match(scanPolicy().descricao, /fail-closed/);

  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_REQUIRED;
});

test('o lote NUNCA se declara "verificado" quando o antivírus não analisou', async () => {
  // Desligado: status 'sem-antivirus' — não é "verificado".
  delete process.env.CLAMAV_HOST;
  const desligado = await scanUploadBatch([{ originalname: 'a.txt', buffer: Buffer.from('x') }]);
  assert.equal(desligado.status, 'sem-antivirus');
  assert.equal(desligado.scanned, false);

  // Fora do ar em modo degradável: status 'degradado' — o arquivo passa, mas a
  // interface tem de dizer que ele NÃO foi verificado.
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = '1';
  process.env.CLAMAV_TIMEOUT_MS = '1000';
  try {
    const degradado = await scanUploadBatch([{ originalname: 'a.txt', buffer: Buffer.from('x') }]);
    assert.equal(degradado.status, 'degradado');
    assert.equal(degradado.scanned, false);
    assert.equal(degradado.clean.length, 1);
  } finally {
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
    delete process.env.CLAMAV_TIMEOUT_MS;
  }

  // Analisado de verdade: aí sim, 'verificado'.
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(port);
  try {
    const ok = await scanUploadBatch([{ originalname: 'a.txt', buffer: Buffer.from('inofensivo') }]);
    assert.equal(ok.status, 'verificado');
    assert.equal(ok.scanned, true);
  } finally {
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
  }
});

test('arquivo em DISCO é escaneado por streaming (sem carregar na RAM)', async () => {
  const { scanFilePath } = await import('./clamav.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-clamav-'));
  const limpo = path.join(dir, 'limpo.bin');
  const sujo = path.join(dir, 'sujo.bin');
  fs.writeFileSync(limpo, Buffer.alloc(300 * 1024, 'a')); // > 1 bloco de 64 KB
  fs.writeFileSync(sujo, Buffer.concat([Buffer.alloc(100 * 1024, 'b'), Buffer.from('EICAR')]));
  try {
    assert.equal((await scanFilePath(limpo, opts)).clean, true);
    const infectado = await scanFilePath(sujo, opts);
    assert.equal(infectado.clean, false);
    assert.equal(infectado.virus, 'Eicar-Test-Signature');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
