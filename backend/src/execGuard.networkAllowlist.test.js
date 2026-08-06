// F-05b: allowlist de egress no sandbox. Cobre as primitivas puras:
// - compileNetworkAllowlist/parseAllowlistEntry — formato e tipos
// - hostMatchesAllowlist — matching (domínio/sufixo/IP/CIDR/porta)
// - extractHostCandidates — extração de hosts em comandos reais (inclui git e IPv6)
// - guardNetworkEgress — bloqueio real (integração com guardCommand)
// - IPv6 literal bloqueado (fail-closed)
// - git clone/push/pull/fetch/remote extraídos e conferidos contra allowlist
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

// ---- F-05b: IPv6 literal (fail-closed) ----
// IPv6 em colchetes ([::1], [2001:db8::1]) é sempre bloqueado quando há
// allowlist ativa — a sintaxe é diferente e não casa com as regras IPv4.

test('guardNetworkEgress: IPv6 literal [::1] é bloqueado (fail-closed)', () => {
  assert.throws(
    () => guardNetworkEgress('curl http://[::1]:8080/status', { allowlist: ['api.exemplo.com'] }),
    /endereço IPv6 literal/
  );
});

test('guardNetworkEgress: IPv6 literal [2001:db8::1] é bloqueado', () => {
  assert.throws(
    () => guardNetworkEgress('wget https://[2001:db8::1]/file', { allowlist: ['api.exemplo.com'] }),
    /endereço IPv6 literal/
  );
});

test('extractHostCandidates: IPv6 literal é extraído e marcado como v6', () => {
  const hosts = extractHostCandidates('curl http://[::1]:8080/status');
  const v6host = hosts.find(h => h.v6);
  assert.ok(v6host, 'deve ter um host IPv6 marcado');
  assert.ok(v6host.host.includes('::1'), 'host deve conter o endereço IPv6');
  assert.equal(v6host.port, 8080);
});

// ---- F-05b: git na extração de hosts ----
// git clone/push/pull/fetch com URLs HTTPS ou SSH geram tráfego de rede
// arbitrário — devem ser varridos pela allowlist como qualquer outro comando.

test('extractHostCandidates: git clone HTTPS extrai o host', () => {
  const hosts = extractHostCandidates('git clone https://github.com/user/repo.git');
  assert.ok(hosts.some(h => h.host === 'github.com'), 'deve extrair github.com do git clone HTTPS');
});

test('extractHostCandidates: git clone SSH extrai o host', () => {
  const hosts = extractHostCandidates('git clone git@github.com:user/repo.git');
  assert.ok(hosts.some(h => h.host === 'github.com'), 'deve extrair github.com do git clone SSH');
});

test('extractHostCandidates: git push extrai o host', () => {
  const hosts = extractHostCandidates('git push origin main');
  // git push sem URL explícita não contém host — usa o remote já configurado.
  // Mas git push COM URL explícita deve ser extraído.
  const hosts2 = extractHostCandidates('git push https://github.com/user/repo.git main');
  assert.ok(hosts2.some(h => h.host === 'github.com'), 'deve extrair github.com do git push com URL');
});

test('extractHostCandidates: git remote add extrai o host', () => {
  const hosts = extractHostCandidates('git remote add origin https://gitlab.com/user/repo.git');
  assert.ok(hosts.some(h => h.host === 'gitlab.com'), 'deve extrair gitlab.com do git remote add');
});

test('extractHostCandidates: git fetch extrai o host', () => {
  const hosts = extractHostCandidates('git fetch https://github.com/user/repo.git');
  assert.ok(hosts.some(h => h.host === 'github.com'), 'deve extrair github.com do git fetch');
});

test('guardNetworkEgress: git clone para host não autorizado é bloqueado', () => {
  assert.throws(
    () => guardNetworkEgress('git clone https://github.com/user/repo.git', { allowlist: ['gitlab.com'] }),
    /destino 'github\.com'/
  );
});

test('guardNetworkEgress: git clone para host autorizado passa', () => {
  guardNetworkEgress('git clone https://github.com/user/repo.git', { allowlist: ['github.com'] });
});

test('extractHostCandidates: comando git sem URL não extrai hosts fantasmas', () => {
  // git status, git log, git diff não têm URL — não devem gerar hosts.
  assert.deepEqual(extractHostCandidates('git status'), []);
  assert.deepEqual(extractHostCandidates('git log --oneline'), []);
  assert.deepEqual(extractHostCandidates('git diff HEAD~1'), []);
});

// ---- Falsos positivos: o que a varredura NÃO pode confundir com destino ----
//
// A primeira versão desta frente varria qualquer coisa parecida com domínio
// depois de `git`, e qualquer `[hex:hex]` como IPv6. Isso serve para o `curl`
// (que só recebe URL) e é desastroso para os dois casos abaixo — nenhum deles
// abre conexão, e os dois são uso diário do app.

test('git com texto livre não vira destino de rede', () => {
  // Estes três derrubariam o conector GitHub, que faz exatamente essas chamadas.
  assert.deepEqual(extractHostCandidates('git config user.email joao@exemplo.com'), [],
    'e-mail tem a mesma forma que remoto SSH até o host — o que separa os dois é o ":caminho"');
  assert.deepEqual(extractHostCandidates('git commit -m "corrige o bug do site.com"'), [],
    'mensagem de commit é texto livre, não destino');
  assert.deepEqual(extractHostCandidates('git log --grep=api.exemplo.com'), [],
    'padrão de busca é texto livre, não destino');
});

test('fatiamento de Python não vira endereço IPv6', () => {
  // `[0:5]` e `[0:10:2]` casavam com `[0-9a-f:]+` e viravam "IPv6 bloqueado".
  // O run_python usa fatiamento o tempo todo.
  assert.deepEqual(extractHostCandidates('python -c "print(lista[0:5])"'), []);
  assert.deepEqual(extractHostCandidates('python3 -c "print(x[0:10:2])"'), [],
    'fatiamento com passo tem DOIS ":" — não basta contar dois-pontos, precisa do contexto de rede');
  assert.deepEqual(extractHostCandidates('echo ${arr[0:2]}'), []);
});

test('IPv6 de verdade continua bloqueado, em URL e como argumento', () => {
  assert.throws(() => guardNetworkEgress('curl http://[::1]:8080/', { allowlist: ['exemplo.com'] }), /IPv6/);
  assert.throws(() => guardNetworkEgress('ping [2001:db8::1]', { allowlist: ['exemplo.com'] }), /IPv6/);
});

test('remoto SSH do git continua sendo conferido', () => {
  assert.throws(() => guardNetworkEgress('git clone git@gitlab.com:user/repo.git', { allowlist: ['github.com'] }),
    /destino 'gitlab\.com'/);
  guardNetworkEgress('git clone git@github.com:user/repo.git', { allowlist: ['github.com'] });
});
