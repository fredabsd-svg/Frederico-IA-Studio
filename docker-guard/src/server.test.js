// Teste do PROXY de verdade: sobe o guarda contra um daemon Docker FALSO num
// socket unix e faz requisições HTTP reais.
//
// Sem isto, a política estaria testada mas o caminho por onde os bytes passam
// não — e é ali que mora o risco de uma requisição bloqueada vazar, ou de o
// exec (que usa upgrade/hijack) parar de funcionar e derrubar todas as
// ferramentas do app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-guard-'));
const socketPath = path.join(tmp, 'docker.sock');

process.env.DOCKER_SOCKET = socketPath;
process.env.SANDBOX_IMAGE = 'frederico-ai-sandbox:latest';
process.env.GUARD_WORKSPACE_ROOT = '/srv/frederico/workspaces';
process.env.GUARD_ALLOW_PC_FOLDERS = 'false';

// ---- Daemon Docker falso ---------------------------------------------------
// Registra tudo que CHEGA até ele. Se uma requisição proibida aparecer aqui, o
// guarda falhou — é essa a asserção mais importante do arquivo.
const recebidas = [];
const containers = {
  'sandbox-do-app': { Config: { Labels: { 'com.frederico.app': 'frederico-ai-studio' } } },
  'postgres-do-compose': { Config: { Labels: { 'org.opencontainers.image.title': 'postgres' } } }
};
const execs = { 'exec-do-app': { ContainerID: 'sandbox-do-app' }, 'exec-alheio': { ContainerID: 'postgres-do-compose' } };

const daemon = http.createServer((req, res) => {
  recebidas.push(`${req.method} ${req.url}`);
  // O daemon real recebe o caminho COM o prefixo de versão (/v1.41/...) e o
  // resolve sozinho; o falso precisa tirar antes de casar as rotas abaixo.
  req.url = req.url.replace(/^\/v\d+\.\d+/, '');
  const responde = (code, obj) => {
    const payload = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  const container = /^\/containers\/([^/]+)\/json$/.exec(req.url);
  if (container) {
    const info = containers[container[1]];
    return info ? responde(200, info) : responde(404, { message: 'no such container' });
  }
  const exec = /^\/exec\/([^/]+)\/json$/.exec(req.url);
  if (exec) {
    const info = execs[exec[1]];
    return info ? responde(200, { ...info, ExitCode: 0 }) : responde(404, { message: 'no such exec' });
  }
  if (req.url.startsWith('/containers/create')) return responde(201, { Id: 'novo-container' });
  if (req.url === '/_ping') { res.writeHead(200); return res.end('OK'); }
  responde(200, { ok: true, echo: req.url });
});
// O hijack do exec chega como upgrade: responde 101 e conversa em bytes crus.
daemon.on('upgrade', (req, socket) => {
  recebidas.push(`UPGRADE ${req.url}`);
  socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  socket.write('saida-do-comando');
  socket.end();
});

const { createGuardServer, guardMetrics } = await import('./server.js');
const guard = createGuardServer();

await new Promise(resolve => daemon.listen(socketPath, resolve));
await new Promise(resolve => guard.listen(0, '127.0.0.1', resolve));
const guardPort = guard.address().port;

test.after(() => {
  guard.close();
  daemon.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pedir(method, urlPath, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: guardPort, method, path: urlPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const criacaoLegitima = {
  Image: 'frederico-ai-sandbox:latest',
  Labels: { 'com.frederico.app': 'frederico-ai-studio' },
  HostConfig: {
    Binds: ['/srv/frederico/workspaces/users/a/conv:/workspace'],
    Memory: 1024 ** 3, NanoCpus: 1e9, PidsLimit: 256,
    SecurityOpt: ['no-new-privileges:true'], CapDrop: ['ALL']
  }
};

test('a criação legítima do sandbox chega ao daemon', async () => {
  recebidas.length = 0;
  const r = await pedir('POST', '/v1.41/containers/create?name=frederico-ai-x', criacaoLegitima);
  assert.equal(r.status, 201);
  assert.match(r.body, /novo-container/);
  assert.ok(recebidas.some(x => x.includes('/containers/create')), 'o daemon recebeu a criação');
});

test('BLOQUEIO REAL: container privilegiado nem chega ao daemon', async () => {
  recebidas.length = 0;
  const r = await pedir('POST', '/v1.41/containers/create', {
    ...criacaoLegitima,
    HostConfig: { ...criacaoLegitima.HostConfig, Privileged: true }
  });
  assert.equal(r.status, 403);
  assert.match(r.body, /Privileged/);
  assert.deepEqual(recebidas, [], 'NENHUMA requisição pode ter chegado ao daemon');
});

test('BLOQUEIO REAL: montar "/" ou o socket do Docker nem chega ao daemon', async () => {
  for (const bind of ['/:/host', '/var/run/docker.sock:/var/run/docker.sock']) {
    recebidas.length = 0;
    const r = await pedir('POST', '/v1.41/containers/create', {
      ...criacaoLegitima,
      HostConfig: { ...criacaoLegitima.HostConfig, Binds: [bind] }
    });
    assert.equal(r.status, 403, `deveria bloquear ${bind}`);
    assert.deepEqual(recebidas, [], `o daemon não pode ter visto ${bind}`);
  }
});

test('BLOQUEIO REAL: rotas perigosas não passam', async () => {
  for (const [method, rota] of [['POST', '/build'], ['POST', '/images/create?fromImage=alpine'], ['POST', '/volumes/create'], ['GET', '/containers/sandbox-do-app/archive?path=/etc']]) {
    recebidas.length = 0;
    const r = await pedir(method, rota, method === 'POST' ? {} : undefined);
    assert.equal(r.status, 403, `${method} ${rota} deveria ser bloqueado`);
    assert.deepEqual(recebidas, [], `${method} ${rota} não pode chegar ao daemon`);
  }
});

// ---- Posse por label --------------------------------------------------------

test('POSSE: operar um container do app é permitido', async () => {
  const r = await pedir('POST', '/containers/sandbox-do-app/kill', {});
  assert.equal(r.status, 200);
});

test('POSSE: um backend comprometido NÃO derruba o Postgres do compose', async () => {
  recebidas.length = 0;
  const r = await pedir('DELETE', '/containers/postgres-do-compose?force=true');
  assert.equal(r.status, 403);
  assert.match(r.body, /label/);
  // O guarda só consultou a posse; a remoção nunca foi encaminhada.
  assert.ok(!recebidas.some(x => x.startsWith('DELETE')), 'o DELETE não pode ter chegado ao daemon');
});

test('POSSE: container inexistente é recusado (fail-closed)', async () => {
  const r = await pedir('POST', '/containers/nao-existe/kill', {});
  assert.equal(r.status, 403);
});

test('POSSE: exec é resolvido até o container dono', async () => {
  assert.equal((await pedir('GET', '/exec/exec-do-app/json')).status, 200);
  const alheio = await pedir('GET', '/exec/exec-alheio/json');
  assert.equal(alheio.status, 403, 'exec dentro de container de terceiro é recusado');
});

// ---- Hijack do exec (o caminho por onde TODA ferramenta executa) -------------

function hijack(urlPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(guardPort, '127.0.0.1', () => {
      socket.write(`POST ${urlPath} HTTP/1.1\r\nHost: guard\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n`);
    });
    let recebido = '';
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timeout no hijack')); });
    socket.on('data', c => { recebido += c.toString('utf8'); });
    socket.on('close', () => resolve(recebido));
    socket.on('error', reject);
  });
}

test('HIJACK: o exec do container do app faz o túnel de bytes até o daemon', async () => {
  const resposta = await hijack('/v1.41/exec/exec-do-app/start');
  assert.match(resposta, /101 UPGRADED/, 'o upgrade foi repassado');
  assert.match(resposta, /saida-do-comando/, 'os bytes crus do daemon chegaram ao cliente');
});

test('HIJACK: exec em container de terceiro é recusado antes do túnel', async () => {
  const resposta = await hijack('/v1.41/exec/exec-alheio/start');
  assert.match(resposta, /403 Forbidden/);
  assert.doesNotMatch(resposta, /saida-do-comando/);
});

test('HIJACK: rota fora da allowlist não abre túnel', async () => {
  const resposta = await hijack('/v1.41/containers/sandbox-do-app/attach');
  assert.match(resposta, /403 Forbidden/);
});

test('as recusas ficam contabilizadas para o operador', () => {
  assert.ok(guardMetrics.recusadas > 0);
  assert.ok(guardMetrics.permitidas > 0);
  assert.ok(guardMetrics.ultimaRecusa?.reason);
});
