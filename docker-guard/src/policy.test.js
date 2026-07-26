// Política do guarda: cada teste é uma FUGA concreta que precisa ser barrada.
//
// O F-04 dizia: "quem controla o socket controla o host". Estes casos são as
// formas conhecidas de transformar acesso ao daemon em root na máquina.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateRequest, validateCreate, stripApiVersion,
  normalizeHostPath, isInsideRoot, isForbiddenSource, bindSource,
  APP_LABEL, APP_LABEL_VALUE
} from './policy.js';

const limits = {
  allowedImage: 'frederico-ai-sandbox:latest',
  workspaceRoot: '/srv/frederico/workspaces',
  allowPcFolders: false,
  extraBindRoots: [],
  maxPids: 1024,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxNanoCpus: 4e9
};

// O corpo que o backend legítimo envia (espelha createContainer em sandbox.js).
function corpoLegitimo(extra = {}, hostExtra = {}) {
  return {
    Image: 'frederico-ai-sandbox:latest',
    WorkingDir: '/workspace',
    Cmd: ['sleep', 'infinity'],
    NetworkDisabled: true,
    Labels: {
      [APP_LABEL]: APP_LABEL_VALUE,
      'com.frederico.user': 'usuario-a',
      'com.frederico.conversation': 'conversa-1'
    },
    HostConfig: {
      Binds: ['/srv/frederico/workspaces/users/usuario-a/conversa-1:/workspace'],
      Mounts: [],
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 1e9,
      PidsLimit: 256,
      AutoRemove: true,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
      ...hostExtra
    },
    ...extra
  };
}

test('o pedido legítimo do backend passa', () => {
  const v = validateCreate(corpoLegitimo(), limits);
  assert.equal(v.allow, true, v.reason);
});

// ---- As fugas ---------------------------------------------------------------

test('FUGA BARRADA: container privilegiado', () => {
  const v = validateCreate(corpoLegitimo({}, { Privileged: true }), limits);
  assert.equal(v.allow, false);
  assert.match(v.reason, /Privileged/);
});

test('FUGA BARRADA: montar a raiz do host', () => {
  const v = validateCreate(corpoLegitimo({}, { Binds: ['/:/host'] }), limits);
  assert.equal(v.allow, false);
  assert.match(v.reason, /caminho proibido/);
});

test('FUGA BARRADA: montar o próprio socket do Docker no sandbox', () => {
  // Seria o F-04 se reabrindo por dentro: com o socket no sandbox, o código
  // gerado pelo modelo criaria um container privilegiado sozinho.
  for (const bind of ['/var/run/docker.sock:/var/run/docker.sock', '/var/run:/hostrun']) {
    const v = validateCreate(corpoLegitimo({}, { Binds: [bind] }), limits);
    assert.equal(v.allow, false, `deveria barrar ${bind}`);
    assert.match(v.reason, /caminho proibido/);
  }
});

test('FUGA BARRADA: /etc, /proc, /sys, /root e a árvore do Docker', () => {
  for (const alvo of ['/etc/shadow', '/proc', '/sys/fs/cgroup', '/root/.ssh', '/var/lib/docker']) {
    const v = validateCreate(corpoLegitimo({}, { Binds: [`${alvo}:/x`] }), limits);
    assert.equal(v.allow, false, `deveria barrar ${alvo}`);
  }
});

test('FUGA BARRADA: travessia com ".." para sair do workspace', () => {
  const v = validateCreate(corpoLegitimo({}, {
    Binds: ['/srv/frederico/workspaces/../../../etc:/x']
  }), limits);
  assert.equal(v.allow, false);
});

test('FUGA BARRADA: prefixo parecido não é "dentro" do workspace', () => {
  // /srv/frederico/workspaces-outro NÃO está dentro de /srv/frederico/workspaces.
  const v = validateCreate(corpoLegitimo({}, {
    Binds: ['/srv/frederico/workspaces-outro/x:/workspace']
  }), limits);
  assert.equal(v.allow, false);
  assert.match(v.reason, /fora de/);
});

test('FUGA BARRADA: CapAdd, Devices, GPU, PidMode e UsernsMode do host', () => {
  const casos = [
    { CapAdd: ['SYS_ADMIN'] },
    { Devices: [{ PathOnHost: '/dev/sda' }] },
    { DeviceRequests: [{ Count: -1 }] },
    { PidMode: 'host' },
    { UsernsMode: 'host' },
    { UTSMode: 'host' },
    { IpcMode: 'host' },
    { CgroupParent: '/' },
    { Sysctls: { 'kernel.shmmax': '1' } }
  ];
  for (const hostExtra of casos) {
    const v = validateCreate(corpoLegitimo({}, hostExtra), limits);
    assert.equal(v.allow, false, `deveria barrar ${JSON.stringify(hostExtra)}`);
  }
});

test('FUGA BARRADA: rede do host ou de outro container', () => {
  for (const NetworkMode of ['host', 'container:postgres']) {
    const v = validateCreate(corpoLegitimo({}, { NetworkMode }), limits);
    assert.equal(v.allow, false, `deveria barrar ${NetworkMode}`);
  }
  // bridge normal segue permitida (o sandbox com rede autorizada usa isso).
  assert.equal(validateCreate(corpoLegitimo({}, { NetworkMode: 'bridge' }), limits).allow, true);
});

test('FUGA BARRADA: outra imagem qualquer do registry', () => {
  const v = validateCreate(corpoLegitimo({ Image: 'alpine:latest' }), limits);
  assert.equal(v.allow, false);
  assert.match(v.reason, /imagem não permitida/);
});

test('FUGA BARRADA: volume nomeado em vez de caminho', () => {
  const v = validateCreate(corpoLegitimo({}, { Binds: ['pgdata:/workspace'] }), limits);
  assert.equal(v.allow, false);
  assert.match(v.reason, /volume nomeado/);
});

test('FUGA BARRADA: Mounts do tipo volume/tmpfs contornando os Binds', () => {
  const v = validateCreate(corpoLegitimo({}, {
    Binds: [], Mounts: [{ Type: 'volume', Source: 'pgdata', Target: '/workspace' }]
  }), limits);
  assert.equal(v.allow, false);
  assert.match(v.reason, /só bind/);
});

test('FUGA BARRADA: Mounts (não só Binds) também são validados', () => {
  const v = validateCreate(corpoLegitimo({}, {
    Binds: [], Mounts: [{ Type: 'bind', Source: '/etc', Target: '/x' }]
  }), limits);
  assert.equal(v.allow, false);
});

// ---- Endurecimento obrigatório (fail-closed) --------------------------------

test('o endurecimento é OBRIGATÓRIO: sem CapDrop ALL ou no-new-privileges, recusa', () => {
  assert.equal(validateCreate(corpoLegitimo({}, { CapDrop: [] }), limits).allow, false);
  assert.equal(validateCreate(corpoLegitimo({}, { SecurityOpt: [] }), limits).allow, false);
  const unconfined = validateCreate(corpoLegitimo({}, { SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] }), limits);
  assert.equal(unconfined.allow, false);
  assert.match(unconfined.reason, /unconfined/);
});

test('as cotas de recurso são obrigatórias e têm teto', () => {
  assert.equal(validateCreate(corpoLegitimo({}, { PidsLimit: 0 }), limits).allow, false);
  assert.equal(validateCreate(corpoLegitimo({}, { PidsLimit: 99999 }), limits).allow, false);
  assert.equal(validateCreate(corpoLegitimo({}, { Memory: 0 }), limits).allow, false);
  assert.equal(validateCreate(corpoLegitimo({}, { Memory: 64 * 1024 ** 3 }), limits).allow, false);
  assert.equal(validateCreate(corpoLegitimo({}, { NanoCpus: 0 }), limits).allow, false);
  assert.equal(validateCreate(corpoLegitimo({}, { NanoCpus: 32e9 }), limits).allow, false);
});

test('sem a label do app o container é recusado (ficaria invisível à reconciliação)', () => {
  const v = validateCreate(corpoLegitimo({ Labels: { outra: 'coisa' } }), limits);
  assert.equal(v.allow, false);
  assert.match(v.reason, /label/);
});

// ---- Pastas do PC (instalação pessoal) --------------------------------------

test('pastas do PC só passam com o guarda configurado para isso — e nunca as de sistema', () => {
  const pessoal = { ...limits, allowPcFolders: true };
  assert.equal(validateCreate(corpoLegitimo({}, {
    Binds: ['/home/fred/Documentos/Clientes:/mnt/pc/clientes']
  }), pessoal).allow, true);
  // Mesmo liberado, a blocklist continua valendo.
  assert.equal(validateCreate(corpoLegitimo({}, { Binds: ['/etc:/mnt/pc/etc'] }), pessoal).allow, false);
  assert.equal(validateCreate(corpoLegitimo({}, { Binds: ['/var/run/docker.sock:/x'] }), pessoal).allow, false);
});

test('GUARD_EXTRA_BIND_ROOTS restringe as pastas do PC a raízes declaradas', () => {
  const restrito = { ...limits, allowPcFolders: true, extraBindRoots: ['/home/fred/Documentos'] };
  assert.equal(validateCreate(corpoLegitimo({}, { Binds: ['/home/fred/Documentos/a:/mnt/pc/a'] }), restrito).allow, true);
  assert.equal(validateCreate(corpoLegitimo({}, { Binds: ['/home/outro/b:/mnt/pc/b'] }), restrito).allow, false);
});

// ---- Allowlist de rotas -----------------------------------------------------

test('só as rotas que o sandbox usa passam', () => {
  const ok = [
    ['GET', '/_ping'], ['GET', '/v1.41/version'],
    ['GET', '/v1.41/images/frederico-ai-sandbox:latest/json'],
    ['GET', '/containers/json?all=1'],
    ['POST', '/v1.41/containers/abc123/start'],
    ['POST', '/containers/abc123/kill'],
    ['DELETE', '/containers/abc123?force=true'],
    ['POST', '/containers/abc123/exec'],
    ['POST', '/exec/def456/start'],
    ['GET', '/exec/def456/json'],
    ['GET', '/containers/abc123/stats?stream=false']
  ];
  for (const [method, path] of ok) {
    const v = evaluateRequest({ method, path, body: method === 'POST' && path.endsWith('/exec') ? {} : null }, limits);
    assert.equal(v.allow, true, `${method} ${path} deveria passar: ${v.reason}`);
  }
});

test('ROTAS PERIGOSAS são recusadas mesmo com corpo inofensivo', () => {
  const negadas = [
    ['POST', '/build'],                        // construir imagem no host
    ['POST', '/images/create?fromImage=alpine'], // baixar imagem arbitrária
    ['POST', '/volumes/create'],
    ['POST', '/networks/create'],
    ['DELETE', '/volumes/pgdata'],
    ['POST', '/containers/abc/attach'],
    ['GET', '/containers/abc/archive?path=/etc/shadow'], // ler arquivo de container
    ['PUT', '/containers/abc/archive?path=/'],           // escrever em container
    ['POST', '/swarm/init'],
    ['POST', '/commit'],
    ['GET', '/events'],
    ['POST', '/containers/abc/update'],        // afrouxar limites depois de criado
    ['POST', '/plugins/pull']
  ];
  for (const [method, path] of negadas) {
    const v = evaluateRequest({ method, path, body: {} }, limits);
    assert.equal(v.allow, false, `${method} ${path} deveria ser recusado`);
  }
});

test('operações sobre recurso específico pedem checagem de posse', () => {
  assert.equal(evaluateRequest({ method: 'DELETE', path: '/containers/abc' }, limits).ownership, 'container');
  assert.equal(evaluateRequest({ method: 'DELETE', path: '/containers/abc' }, limits).targetId, 'abc');
  assert.equal(evaluateRequest({ method: 'POST', path: '/exec/xyz/start' }, limits).ownership, 'exec');
  assert.equal(evaluateRequest({ method: 'GET', path: '/containers/json' }, limits).ownership, null);
  // /stats é leitura de métricas, mas de um container ESPECÍFICO: sem a posse,
  // o backend leria o consumo do Postgres ou de qualquer outro vizinho.
  assert.equal(evaluateRequest({ method: 'GET', path: '/containers/abc/stats' }, limits).ownership, 'container');
  assert.equal(evaluateRequest({ method: 'GET', path: '/containers/abc/stats' }, limits).targetId, 'abc');
});

test('exec privilegiado ou como root é recusado', () => {
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { Privileged: true } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: 'root' } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: 'sandbox' } }, limits).allow, true);
});

test('create sem corpo JSON é recusado (não passa em branco)', () => {
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/create', body: null }, limits).allow, false);
});

// ---- Utilitários de caminho -------------------------------------------------

test('normalização de caminho resolve "." e ".." sem tocar no disco', () => {
  assert.equal(normalizeHostPath('/a/b/../c/./d'), '/a/c/d');
  assert.equal(normalizeHostPath('/a/../../../etc'), '/etc');
  assert.equal(normalizeHostPath('relativo'), null);
});

test('isInsideRoot não confunde prefixo com diretório', () => {
  assert.equal(isInsideRoot('/ws/user/conv', '/ws'), true);
  assert.equal(isInsideRoot('/ws', '/ws'), true);
  assert.equal(isInsideRoot('/ws-outro/x', '/ws'), false);
});

test('bindSource extrai a origem de "src:dst:mode"', () => {
  assert.equal(bindSource('/a/b:/workspace:ro'), '/a/b');
  assert.equal(bindSource('/a/b'), '/a/b');
});

test('stripApiVersion tira o prefixo de versão da API', () => {
  assert.equal(stripApiVersion('/v1.41/containers/create'), '/containers/create');
  assert.equal(stripApiVersion('/containers/create'), '/containers/create');
});

test('isForbiddenSource cobre socket, raiz e diretórios de sistema', () => {
  for (const p of ['/', '/var/run/docker.sock', '/run/docker.sock', '/etc', '/proc/1', '/usr/bin', '/dev/sda']) {
    assert.equal(isForbiddenSource(p), true, `${p} deveria ser proibido`);
  }
  assert.equal(isForbiddenSource('/srv/frederico/workspaces/users/a/b'), false);
  assert.equal(isForbiddenSource('/home/fred/Documentos'), false);
});

// ── Regressões de 2026-07: o sandbox ficou inutilizável nos DOIS ambientes ────
//
// Sintoma idêntico nos dois: TODO POST /containers/create recusado, então
// nenhuma ferramenta rodava. As causas eram diferentes.

test('Windows: o dois-pontos da unidade não faz a origem virar "C"', () => {
  // Era isto que aparecia no log: "bind por volume nomeado não é permitido:
  // C:\Users\...\workspaces\...:/workspace" — bindSource cortava em "C".
  assert.equal(bindSource('C:\\Users\\conta\\Studio/workspaces/u/c:/workspace'), 'C:\\Users\\conta\\Studio/workspaces/u/c');
  assert.equal(bindSource('C:/dados/ws:/workspace:ro'), 'C:/dados/ws');
  assert.equal(bindSource('/a/b:/workspace:ro'), '/a/b', 'POSIX continua igual');
});

test('Windows: caminho com letra de unidade é aceito e normalizado', () => {
  assert.equal(normalizeHostPath('C:\\Users\\conta\\Studio/workspaces'), 'C:/Users/conta/Studio/workspaces');
  assert.equal(normalizeHostPath('c:/dados/../dados/ws'), 'C:/dados/ws');
  assert.equal(normalizeHostPath('\\\\servidor\\share'), null, 'UNC continua fora do escopo');
  assert.equal(normalizeHostPath('meu-volume'), null, 'volume nomeado continua sendo null');
});

test('Windows: a comparação com a raiz ignora maiúsculas/minúsculas', () => {
  assert.equal(isInsideRoot('c:/studio/workspaces/u/c', 'C:\\Studio\\workspaces'), true);
  assert.equal(isInsideRoot('D:/studio/workspaces/u/c', 'C:/studio/workspaces'), false, 'outra unidade, outro lugar');
  assert.equal(isInsideRoot('/ws/u', '/WS'), false, 'em POSIX a caixa continua importando');
});

test('Windows: container do Docker Desktop é aceito ponta a ponta', () => {
  const raizWindows = { ...limits, workspaceRoot: 'C:\\Users\\conta\\Downloads\\Studio/workspaces' };
  const corpo = corpoLegitimo({}, {
    Binds: ['C:\\Users\\conta\\Downloads\\Studio/workspaces/users/QpK/SurtIL:/workspace']
  });
  assert.deepEqual(validateCreate(corpo, raizWindows), { allow: true });
});

test('Windows: fora do workspace continua recusado', () => {
  const raizWindows = { ...limits, workspaceRoot: 'C:/Studio/workspaces' };
  const corpo = corpoLegitimo({}, { Binds: ['C:\\Windows\\System32:/workspace'] });
  assert.equal(validateCreate(corpo, raizWindows).allow, false);
});

test('Windows: com Pastas do PC ligadas, os diretórios de sistema seguem barrados', () => {
  const pc = { ...limits, workspaceRoot: 'C:/Studio/workspaces', allowPcFolders: true };
  for (const p of ['C:\\Windows\\System32', 'C:/Program Files/algo', 'C:/', 'C:/Users/conta/AppData/Roaming']) {
    const corpo = corpoLegitimo({}, { Binds: [`${p}:/workspace`] });
    assert.equal(validateCreate(corpo, pc).allow, false, `${p} deveria ser barrado`);
  }
});

test('VPS: workspace sob /root é aceito — a blocklist não pode vencer a raiz', () => {
  // `git clone` logado como root (é o que o VPS-DEPLOY.md manda) põe o projeto
  // em /root/Frederico-IA-Studio, e GUARD_WORKSPACE_ROOT vira .../workspaces.
  // A regra /^\/root/ recusava todo container do app.
  const vps = { ...limits, workspaceRoot: '/root/Frederico-IA-Studio/workspaces' };
  const corpo = corpoLegitimo({}, {
    Binds: ['/root/Frederico-IA-Studio/workspaces/users/usuario-a/conversa-1:/workspace']
  });
  assert.deepEqual(validateCreate(corpo, vps), { allow: true });
});

test('VPS: a precedência vale só DENTRO da raiz — /root fora dela segue barrado', () => {
  const vps = { ...limits, workspaceRoot: '/root/Frederico-IA-Studio/workspaces' };
  for (const p of ['/root/.ssh', '/root', '/etc/shadow', '/var/run/docker.sock']) {
    const corpo = corpoLegitimo({}, { Binds: [`${p}:/workspace`] });
    assert.equal(validateCreate(corpo, vps).allow, false, `${p} deveria ser barrado`);
  }
});

test('o socket do Docker é barrado mesmo se a raiz o contiver', () => {
  // Cinto e suspensório: nem uma raiz mal configurada libera o socket.
  const raizAbsurda = { ...limits, workspaceRoot: '/var/run' };
  const corpo = corpoLegitimo({}, { Binds: ['/var/run/docker.sock:/workspace'] });
  assert.equal(validateCreate(corpo, raizAbsurda).allow, false);
});
