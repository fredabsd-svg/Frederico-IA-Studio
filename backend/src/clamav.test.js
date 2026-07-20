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
