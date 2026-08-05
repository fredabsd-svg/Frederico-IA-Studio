// F-05b: allowlist de egress no sandbox. Cobre as primitivas puras:
// - compileNetworkAllowlist/parseAllowlistEntry — formato e tipos
// - hostMatchesAllowlist — matching (domínio/sufixo/IP/CIDR/porta)
// - extractHostCandidates — extração de hosts em comandos reais
// - guardNetworkEgress — bloqueio real (integração com guardCommand)
//
// A defesa real continua sendo a rede do Docker; esta camada é o que o
// usuário vê quando tenta falar com um destino proibido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileNetworkAllowlist,
  parseAllowlistEntry,
  hostMatchesAllowlist,
  extractHostCandidates,
  guardNetworkEgress,
  guardCommand
} from './execGuard.js';

test('parseAllowlistEntry: domínio exato', () => {
  assert.deepEqual(parseAllowlistEntry('api.exemplo.com'), [{ kind: 'domain', value: 'api.exemplo.com', port: null }]);
});

test('parseAllowlistEntry: domínio com porta', () => {
  assert.deepEqual(parseAllowlistEntry('api.exemplo.com:443'), [{ kind: 'domain', value: 'api.exemplo.com', port: 443 }]);
});

test('parseAllowlistEntry: sufixo (subdomínios aceitos)', () => {
  assert.deepEqual(parseAllowlistEntry('.exemplo.com'), [{ kind: 'suffix', value: 'exemplo.com' }]);
});

test('parseAllowlistEntry: IP literal', () => {
  assert.deepEqual(parseAllowlistEntry('192.168.1.5'), [{ kind: 'ip', value: '192.168.1.5', port: null }]);
  assert.deepEqual(parseAllowlistEntry('8.8.8.8:53'), [{ kind: 'ip', value: '8.8.8.8', port: 53 }]);
});

test('parseAllowlistEntry: CIDR', () => {
  assert.deepEqual(parseAllowlistEntry('10.0.0.0/8'), [{ kind: 'cidr', value: '10.0.0.0/8' }]);
});

test('parseAllowlistEntry: strip de scheme e path', () => {
  assert.deepEqual(parseAllowlistEntry('https://api.exemplo.com/v1/users'), [{ kind: 'domain', value: 'api.exemplo.com', port: null }]);
});

test('compileNetworkAllowlist aceita string, array e objeto', () => {
  const fromString = compileNetworkAllowlist('a.com,b.com');
  assert.equal(fromString.length, 2);
  const fromArray = compileNetworkAllowlist(['a.com', '.b.com']);
  assert.equal(fromArray.length, 2);
  const fromObject = compileNetworkAllowlist([{ kind: 'cidr', value: '10.0.0.0/8' }]);
  assert.equal(fromObject[0].kind, 'cidr');
});

test('hostMatchesAllowlist: domínio exato (case-insensitive)', () => {
  const compiled = compileNetworkAllowlist('api.exemplo.com');
  assert.equal(hostMatchesAllowlist('api.exemplo.com', null, compiled), true);
  assert.equal(hostMatchesAllowlist('API.EXEMPLO.COM', null, compiled), true);
  assert.equal(hostMatchesAllowlist('outro.com', null, compiled), false);
});

test('hostMatchesAllowlist: sufixo casa subdomínios', () => {
  const compiled = compileNetworkAllowlist('.exemplo.com');
  assert.equal(hostMatchesAllowlist('a.exemplo.com', null, compiled), true);
  assert.equal(hostMatchesAllowlist('b.c.exemplo.com', null, compiled), true);
  assert.equal(hostMatchesAllowlist('exemplo.com', null, compiled), true, 'o apex domain também casa');
  assert.equal(hostMatchesAllowlist('outro.com', null, compiled), false);
});

test('hostMatchesAllowlist: porta na allowlist vs porta na chamada', () => {
  const compiled = compileNetworkAllowlist('api.exemplo.com:443');
  assert.equal(hostMatchesAllowlist('api.exemplo.com', 443, compiled), true);
  assert.equal(hostMatchesAllowlist('api.exemplo.com', 80, compiled), false);
  assert.equal(hostMatchesAllowlist('api.exemplo.com', null, compiled), false, 'sem porta não casa com regra com porta');
});

test('hostMatchesAllowlist: IP e CIDR', () => {
  const compiled = compileNetworkAllowlist(['192.168.1.5', '10.0.0.0/8']);
  assert.equal(hostMatchesAllowlist('192.168.1.5', null, compiled), true);
  assert.equal(hostMatchesAllowlist('10.5.6.7', null, compiled), true, 'dentro do CIDR');
  assert.equal(hostMatchesAllowlist('11.0.0.1', null, compiled), false, 'fora do CIDR');
});

test('extractHostCandidates: curl com URL', () => {
  const hosts = extractHostCandidates('curl https://api.exemplo.com/v1/users');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host, 'api.exemplo.com');
});

test('extractHostCandidates: curl com IP e porta', () => {
  const hosts = extractHostCandidates('curl 192.168.1.10:8080/api');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host, '192.168.1.10');
  assert.equal(hosts[0].port, 8080);
});

test('extractHostCandidates: ping', () => {
  const hosts = extractHostCandidates('ping -c 3 api.exemplo.com');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host, 'api.exemplo.com');
});

test('extractHostCandidates: wget com redirecionamento', () => {
  const hosts = extractHostCandidates('wget -O - https://files.exemplo.com/data.tar.gz');
  assert.ok(hosts.some(h => h.host === 'files.exemplo.com'));
});

test('extractHostCandidates: comando sem rede → lista vazia', () => {
  assert.deepEqual(extractHostCandidates('ls -la /workspace'), []);
  assert.deepEqual(extractHostCandidates('python script.py'), []);
});

test('guardNetworkEgress: allowlist vazia (fail-closed) bloqueia QUALQUER acesso', () => {
  // Sem allowlist configurada, mesmo um curl para o IP do Google é bloqueado.
  // É o default seguro: o operador precisa OPT-IN pelos destinos que quiser
  // expor (via SANDBOX_NETWORK_ALLOWLIST).
  assert.throws(
    () => guardNetworkEgress('curl https://api.openai.com/v1', { allowlist: [] }),
    /destino 'api\.openai\.com' não está na allowlist/
  );
});

test('guardNetworkEgress: allowlist com o destino exato passa', () => {
  guardNetworkEgress('curl https://api.openai.com/v1', { allowlist: ['api.openai.com'] });
});

test('guardNetworkEgress: IP bloqueado quando não está na allowlist', () => {
  // Defesa contra metadados de nuvem (169.254.169.254) e IPs internos do host.
  assert.throws(
    () => guardNetworkEgress('curl http://169.254.169.254/latest/meta-data', { allowlist: ['api.openai.com'] }),
    /destino '169\.254\.169\.254'/
  );
});

test('guardNetworkEgress: comando sem rede não é afetado pela allowlist', () => {
  // Allowlist vazia não bloqueia comandos que não tentam falar com a rede.
  guardNetworkEgress('ls -la /workspace', { allowlist: [] });
  guardNetworkEgress('cat foo.txt | head', { allowlist: [] });
});

test('guardNetworkEgress: sufixo casa subdomínio em comando real', () => {
  guardNetworkEgress('wget https://files.openai.com/model.bin', { allowlist: ['.openai.com'] });
});

test('guardNetworkEgress: extrai múltiplos hosts e bloqueia se ALGUM não casa', () => {
  // Cenário comum: o agente usa pipe para encadear downloads. Se um dos
  // destinos não está na allowlist, o comando INTEIRO é bloqueado.
  assert.throws(
    () => guardNetworkEgress('curl https://api.permitido.com | curl https://api.proibido.com', {
      allowlist: ['api.permitido.com']
    }),
    /destino 'api\.proibido\.com'/
  );
});

test('guardCommand com networkAllowlist aplicado via guardContext', () => {
  // Integração: o guardCommand chama guardNetworkEgress quando recebe
  // networkAllowlist. Aqui passamos a allowlist via context.
  assert.throws(
    () => guardCommand('curl https://api.proibido.com', {
      pcWriteAuthorized: false,
      networkAllowlist: ['api.permitido.com']
    }),
    /acesso à rede bloqueado/
  );
  guardCommand('curl https://api.permitido.com', {
    pcWriteAuthorized: false,
    networkAllowlist: ['api.permitido.com']
  });
});
