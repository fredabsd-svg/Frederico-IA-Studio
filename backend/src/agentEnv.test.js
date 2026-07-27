// Estabilidade do ambiente de execução (plano de estabilização).
//
// O que estes testes provam:
//   1) uma falha de AMBIENTE não é confundida com bug do projeto — e vice-versa;
//   2) um comando interrompido nunca é classificado como sucesso;
//   3) o reinício do sandbox gera UM aviso estruturado, com o que sobreviveu e
//      o que se perdeu, entregue uma única vez;
//   4) o checkpoint copia o workspace, IGNORA segredos e restaura por hash;
//   5) o manifesto de dependências de runtime sobrevive à morte do container.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ERROR_CATEGORIES,
  EXEC_STATUS,
  TERMINATION_REASONS,
  classifyExecOutcome,
  fingerprintWorkspace,
  fingerprintChanged,
  noteSandboxCreated,
  noteSandboxTerminated,
  takeRestartNotice,
  peekSandboxLifecycle,
  formatRestartNotice,
  isSecretPath,
  isCheckpointSkipped,
  collectCheckpointFiles,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  pruneCheckpoints,
  detectPackageInstall,
  recordRuntimeInstall,
  listRuntimeInstalls,
  directoryUsage,
  environmentManifest,
  createProgressReporter,
  openExecLog,
  readExecLog,
  detectServiceStart,
  extractPort,
  parseListeningPorts,
  reconcileServices,
  recordServiceStart,
  listRecordedServices,
  readTransaction,
  writeTransaction,
  clearTransaction,
  formatOpenTransactionNotice,
  _lifecycleForTests
} from './agentEnv.js';

const tmpdirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frederico-agentenv-'));
  tmpdirs.push(dir);
  return dir;
}
test.after(() => { for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- 1) Classificação -------------------------------------------------------
test('dependência ausente é falha de AMBIENTE, não bug do projeto', () => {
  const r = classifyExecOutcome({ exitCode: 1, output: 'Traceback...\nModuleNotFoundError: No module named "pandas"' });
  assert.equal(r.categoria, ERROR_CATEGORIES.DEPENDENCY);
  assert.equal(r.falha_do_projeto, false);
});

test('sem rede, um pip install falho é erro de REDE (a rede vence a dependência)', () => {
  const saida = [
    'WARNING: Retrying after connection broken by NewConnectionError',
    'Could not fetch URL https://pypi.org/simple/requests/',
    'ERROR: No matching distribution found for requests'
  ].join('\n');
  const r = classifyExecOutcome({ exitCode: 1, output: saida });
  assert.equal(r.categoria, ERROR_CATEGORIES.NETWORK);
  assert.equal(r.falha_do_projeto, false);
});

test('teste que roda e falha é falha DO PROJETO', () => {
  const r = classifyExecOutcome({ exitCode: 1, output: '=== 3 failed, 12 passed in 4.2s ===\nAssertionError: esperado 7, obtido 5' });
  assert.equal(r.categoria, ERROR_CATEGORIES.TEST);
  assert.equal(r.falha_do_projeto, true);
});

test('OOM e disco cheio são limite de RECURSO', () => {
  assert.equal(classifyExecOutcome({ exitCode: 137, output: 'Killed' }).categoria, ERROR_CATEGORIES.RESOURCE);
  assert.equal(classifyExecOutcome({ exitCode: 1, output: 'OSError: [Errno 28] No space left on device' }).categoria, ERROR_CATEGORIES.RESOURCE);
});

test('permissão negada não é bug do projeto', () => {
  const r = classifyExecOutcome({ exitCode: 1, output: "PermissionError: [Errno 13] Permission denied: '/etc/hosts'" });
  assert.equal(r.categoria, ERROR_CATEGORIES.PERMISSION);
  assert.equal(r.falha_do_projeto, false);
});

test('erro comum do programa continua sendo do projeto', () => {
  const r = classifyExecOutcome({ exitCode: 2, output: 'ValueError: could not convert string to float' });
  assert.equal(r.categoria, ERROR_CATEGORIES.APPLICATION);
  assert.equal(r.falha_do_projeto, true);
});

test('timeout e cancelamento NUNCA viram culpa do projeto nem sucesso', () => {
  const timeout = classifyExecOutcome({ exitCode: 124, output: 'rodando...', status: EXEC_STATUS.TIMEOUT });
  assert.equal(timeout.categoria, ERROR_CATEGORIES.RESOURCE);
  assert.equal(timeout.falha_do_projeto, 'indeterminado');

  const cancelado = classifyExecOutcome({ exitCode: 130, output: '', status: EXEC_STATUS.CANCELED });
  assert.equal(cancelado.falha_do_projeto, false);
  assert.match(cancelado.acao_recomendada, /não trate o resultado como sucesso/i);
});

test('exit 0 é OK', () => {
  assert.equal(classifyExecOutcome({ exitCode: 0, output: 'pronto' }).categoria, ERROR_CATEGORIES.OK);
});

// ---- 2) Impressão digital ---------------------------------------------------
test('a impressão digital detecta arquivo criado e ignora o script da ferramenta', () => {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'dados.csv'), 'a,b\n1,2\n');
  const antes = fingerprintWorkspace(base);
  assert.equal(antes.arquivos, 1);

  fs.writeFileSync(path.join(base, '.tmp_123_abc.py'), 'print(1)');
  const comScript = fingerprintWorkspace(base);
  assert.equal(comScript.arquivos, 1, 'o .tmp_*.py da própria ferramenta não conta como alteração do usuário');

  fs.writeFileSync(path.join(base, 'relatorio.xlsx'), 'x');
  assert.equal(fingerprintChanged(antes, fingerprintWorkspace(base)), true);
});

test('sem base de comparação, arquivos_alterados é indeterminado (null), nunca "false"', () => {
  assert.equal(fingerprintChanged(null, { arquivos: 1 }), null);
});

// ---- 3) Ciclo de vida e aviso de reinício -----------------------------------
test('o primeiro sandbox não é reinício; o segundo é — e o aviso sai UMA vez', () => {
  const key = `teste/${crypto.randomBytes(4).toString('hex')}`;
  const primeiro = noteSandboxCreated(key, 'container-1');
  assert.equal(primeiro.generation, 1);
  assert.equal(primeiro.restarted, false);
  assert.equal(takeRestartNotice(key), null);

  noteSandboxTerminated(key, TERMINATION_REASONS.TIMEOUT);
  const segundo = noteSandboxCreated(key, 'container-2');
  assert.equal(segundo.generation, 2);
  assert.equal(segundo.restarted, true);

  const aviso = takeRestartNotice(key);
  assert.equal(aviso.evento, 'ambiente_reiniciado');
  assert.equal(aviso.motivo, TERMINATION_REASONS.TIMEOUT);
  assert.equal(aviso.sandbox_anterior, 'container-1');
  assert.equal(aviso.sandbox_atual, 'container-2');
  assert.ok(aviso.preservado.length && aviso.perdido.length);
  assert.equal(takeRestartNotice(key), null, 'o aviso é consumido: não repete a cada execução');

  const texto = formatRestartNotice(aviso);
  assert.match(texto, /AMBIENTE REINICIADO/);
  assert.match(texto, /PRESERVADO/);
  assert.match(texto, /PERDIDO/);
  _lifecycleForTests.delete(key);
});

test('o ciclo de vida registra o motivo do último encerramento', () => {
  const key = `teste/${crypto.randomBytes(4).toString('hex')}`;
  noteSandboxCreated(key, 'c1');
  noteSandboxTerminated(key, TERMINATION_REASONS.IDLE);
  const ciclo = peekSandboxLifecycle(key);
  assert.equal(ciclo.ultimo_encerramento.motivo, TERMINATION_REASONS.IDLE);
  assert.equal(ciclo.sandbox_atual, null);
  _lifecycleForTests.delete(key);
});

// ---- 4) Checkpoints ---------------------------------------------------------
test('segredos e diretórios pesados ficam FORA do checkpoint', () => {
  for (const rel of ['.env', '.env.local', 'app/credentials.json', 'secrets/token.txt', 'chaves/servidor.pem', '.git/config']) {
    assert.ok(isSecretPath(rel), `${rel} deveria ser tratado como segredo`);
  }
  assert.ok(!isSecretPath('src/environment.py'));
  assert.ok(isCheckpointSkipped('node_modules/left-pad/index.js'));
  assert.ok(isCheckpointSkipped('.venv/lib/python3.12/site-packages/x.py'));
  assert.ok(!isCheckpointSkipped('src/app.py'));
});

test('checkpoint copia o workspace, pula o segredo e restaura o estado anterior', () => {
  const base = tmp();
  const checkpoints = tmp();
  fs.mkdirSync(path.join(base, 'src'), { recursive: true });
  fs.writeFileSync(path.join(base, 'src', 'app.py'), 'versao = 1\n');
  fs.writeFileSync(path.join(base, '.env'), 'OPENAI_API_KEY=segredo-real\n');
  fs.mkdirSync(path.join(base, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(base, 'node_modules', 'x', 'index.js'), 'modulo pesado');

  const criado = createCheckpoint(base, checkpoints, { label: 'antes da refatoração' });
  assert.equal(criado.arquivos, 1, 'só src/app.py entra: .env é segredo e node_modules é pesado');

  // Nenhuma cópia do segredo pode existir dentro do checkpoint.
  const copiados = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else copiados.push(full);
    }
  };
  walk(checkpoints);
  assert.ok(!copiados.some(f => f.endsWith('.env')), 'o .env NUNCA pode ser copiado para o checkpoint');
  assert.ok(!copiados.some(f => fs.readFileSync(f, 'utf8').includes('segredo-real')));

  // Estraga o trabalho: altera um arquivo e cria outro.
  fs.writeFileSync(path.join(base, 'src', 'app.py'), 'versao = 2 (quebrada)\n');
  fs.writeFileSync(path.join(base, 'src', 'lixo.py'), 'sobra da tentativa\n');

  const r = restoreCheckpoint(base, checkpoints, criado.id);
  assert.equal(r.restaurados, 1);
  assert.equal(r.removidos, 1, 'o arquivo criado depois do checkpoint é removido');
  assert.equal(r.divergentes, 0, 'os hashes conferem depois de restaurar');
  assert.equal(fs.readFileSync(path.join(base, 'src', 'app.py'), 'utf8'), 'versao = 1\n');
  assert.ok(!fs.existsSync(path.join(base, 'src', 'lixo.py')));
  // O que o checkpoint não guarda também não é destruído por ele.
  assert.ok(fs.existsSync(path.join(base, '.env')), 'restaurar não pode apagar o .env do usuário');
  assert.ok(fs.existsSync(path.join(base, 'node_modules', 'x', 'index.js')));
});

test('checkpoint inexistente falha com código próprio, sem mexer no workspace', () => {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'a.txt'), 'intacto');
  assert.throws(() => restoreCheckpoint(base, tmp(), 'nao-existe'), { code: 'CHECKPOINT_NOT_FOUND' });
  assert.equal(fs.readFileSync(path.join(base, 'a.txt'), 'utf8'), 'intacto');
});

test('workspace grande demais é recusado ANTES de gravar qualquer coisa', () => {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'grande.bin'), Buffer.alloc(4096));
  assert.throws(() => collectCheckpointFiles(base, { maxBytes: 1024 }), { code: 'CHECKPOINT_TOO_LARGE' });
});

test('a poda mantém apenas os checkpoints mais recentes', () => {
  const base = tmp();
  const checkpoints = tmp();
  fs.writeFileSync(path.join(base, 'a.txt'), 'x');
  for (let i = 0; i < 4; i++) createCheckpoint(base, checkpoints, { label: `n${i}`, keep: 10 });
  assert.equal(listCheckpoints(checkpoints).length, 4);
  pruneCheckpoints(checkpoints, 2);
  assert.equal(listCheckpoints(checkpoints).length, 2);
});

// ---- 5) Dependências de runtime ---------------------------------------------
test('reconhece os comandos de instalação que os modelos realmente escrevem', () => {
  assert.equal(detectPackageInstall('pip install requests').gerenciador, 'pip');
  assert.equal(detectPackageInstall('python -m pip install "pandas>=2"').gerenciador, 'pip');
  assert.equal(detectPackageInstall('cd app && npm install').gerenciador, 'npm');
  assert.equal(detectPackageInstall('pnpm add vitest').gerenciador, 'pnpm');
  assert.equal(detectPackageInstall('poetry add httpx').gerenciador, 'poetry');
  assert.equal(detectPackageInstall('python analise.py'), null);
  assert.equal(detectPackageInstall('grep -r "pip install" .'), null, 'buscar pelo texto não é instalar');
});

test('o manifesto de dependências vive no workspace e não duplica o mesmo comando', () => {
  const dir = path.join(tmp(), '.agent-env');
  recordRuntimeInstall(dir, 'pip install requests');
  recordRuntimeInstall(dir, 'pip install requests');
  recordRuntimeInstall(dir, 'npm install axios');
  recordRuntimeInstall(dir, 'ls -la');
  const itens = listRuntimeInstalls(dir);
  assert.equal(itens.length, 2);
  assert.deepEqual(itens.map(i => i.gerenciador), ['pip', 'npm']);
});

// ---- 5b) Progresso ao vivo e log da execução --------------------------------
test('o repórter de progresso agrega a saída e respeita o intervalo', () => {
  const eventos = [];
  let agora = 0;
  const rep = createProgressReporter(e => eventos.push(e), { intervalMs: 1000, stallMs: 5000, now: () => agora });
  rep.push('linha 1\nlinha 2\n');
  // Sem o timer (que o teste não roda), nada foi transmitido ainda.
  assert.equal(eventos.length, 0);
  agora = 1200;
  rep.stop(); // o stop faz o flush do que ficou pendente
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].trecho, 'linha 1\nlinha 2\n');
  assert.equal(eventos[0].linhas, 2);
  assert.equal(eventos[0].bytes, Buffer.byteLength('linha 1\nlinha 2\n'));
});

test('o repórter conta linhas e o silêncio mesmo sem ninguém ouvindo', () => {
  let agora = 0;
  const rep = createProgressReporter(undefined, { now: () => agora });
  rep.push('a\nb\nc\n');
  agora = 30_000;
  const s = rep.snapshot();
  assert.equal(s.linhas, 3);
  assert.equal(s.sem_saida_ha_ms, 30_000);
  assert.equal(s.decorrido_ms, 30_000);
});

test('o trecho transmitido é limitado, mas o contador continua íntegro', () => {
  const eventos = [];
  const rep = createProgressReporter(e => eventos.push(e), { chunkChars: 50 });
  rep.push('x'.repeat(500));
  rep.stop();
  assert.ok(eventos[0].trecho.length <= 51, 'o pedaço enviado ao navegador é aparado');
  assert.match(eventos[0].trecho, /^…/, 'o corte é explícito');
  assert.equal(eventos[0].bytes, 500, 'o total transmitido continua verdadeiro');
});

test('o log em disco guarda a saída INTEIRA e é lido pelas duas pontas', () => {
  const dir = path.join(tmp(), '.agent-env');
  const log = openExecLog(dir);
  log.write(`COMEÇO: aqui está o erro\n${'meio\n'.repeat(2000)}`);
  log.write('FIM: resumo\n');
  log.close({ comando: 'pytest', status: 'timeout', exit_code: 124 });

  const lido = readExecLog(dir, { headChars: 100, tailChars: 100 });
  assert.equal(lido.existe, true);
  assert.equal(lido.comando, 'pytest');
  assert.equal(lido.status, 'timeout');
  assert.match(lido.trecho_inicial, /COMEÇO: aqui está o erro/, 'o começo, onde o erro costuma estar, é preservado');
  assert.match(lido.trecho_final, /FIM: resumo/);
  assert.match(lido.observacao, /read_file/);
});

test('o log respeita o teto e marca o corte, sem derrubar a execução', () => {
  const dir = path.join(tmp(), '.agent-env');
  const log = openExecLog(dir, { maxBytes: 100 });
  log.write('a'.repeat(500));
  log.write('depois do corte');
  log.close({ comando: 'yes' });
  const lido = readExecLog(dir);
  assert.match(lido.trecho_inicial, /LOG CORTADO/);
  assert.ok(!lido.trecho_inicial.includes('depois do corte'));
});

test('sem execução registrada, o log responde que não existe', () => {
  assert.deepEqual(readExecLog(path.join(tmp(), '.agent-env')), { existe: false });
});

// ---- 5c) Serviços e portas --------------------------------------------------
test('reconhece comandos que sobem serviço — e não confunde com build', () => {
  assert.equal(detectServiceStart('uvicorn app:api --port 8000').nome, 'uvicorn');
  assert.equal(detectServiceStart('uvicorn app:api --port 8000').porta, 8000);
  assert.equal(detectServiceStart('python -m http.server 8080').porta, 8080);
  assert.equal(detectServiceStart('php -S localhost:9000 -t public').porta, 9000);
  assert.equal(detectServiceStart('nohup npm run dev &').segundo_plano, true);
  assert.equal(detectServiceStart('npm run build'), null, 'build não sobe serviço');
  assert.equal(detectServiceStart('vite build'), null, 'vite build também não');
  assert.equal(detectServiceStart('python analise.py'), null);
});

test('a porta só é aceita num intervalo plausível', () => {
  assert.equal(extractPort('uvicorn app:api'), null);
  assert.equal(extractPort('cmd -p 3'), null, 'um -p 3 solto não é porta de serviço');
  assert.equal(extractPort('serve --port=5173'), 5173);
});

test('o parser aceita a saída do ss E a do netstat', () => {
  const ss = [
    'LISTEN 0      2048   127.0.0.1:8000       0.0.0.0:*    users:(("python3",pid=1452,fd=3))',
    'LISTEN 0      511          *:5173             *:*      users:(("node",pid=1600,fd=20))'
  ].join('\n');
  const doSs = parseListeningPorts(ss);
  assert.deepEqual(doSs.map(p => p.porta), [5173, 8000]);
  assert.equal(doSs.find(p => p.porta === 8000).pid, 1452);
  assert.equal(doSs.find(p => p.porta === 8000).processo, 'python3');

  const netstat = [
    'Active Internet connections (only servers)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
    'tcp        0      0 127.0.0.1:8000          0.0.0.0:*               LISTEN      1452/python3',
    'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      -'
  ].join('\n');
  const doNetstat = parseListeningPorts(netstat);
  assert.deepEqual(doNetstat.map(p => p.porta), [22, 8000]);
  assert.equal(doNetstat.find(p => p.porta === 8000).processo, 'python3');
  // O cabeçalho não é linha de socket: não pode virar porta.
  assert.ok(!doNetstat.some(p => Number.isNaN(p.porta)));
});

test('o cruzamento separa serviço vivo, serviço morto no reinício e porta sem registro', () => {
  const registrados = [
    { nome: 'uvicorn', porta: 8000, geracao: 2 },
    { nome: 'vite', porta: 5173, geracao: 1 } // subiu num container anterior
  ];
  const escutando = [
    { porta: 8000, pid: 1452, processo: 'python3' },
    { porta: 9999, pid: 1700, processo: 'node' }  // ninguém registrou
  ];
  const r = reconcileServices(registrados, escutando, { generation: 2 });
  assert.equal(r.servicos.find(s => s.porta === 8000).estado, 'escutando');
  assert.equal(r.servicos.find(s => s.porta === 8000).pid, 1452);
  assert.equal(r.servicos.find(s => s.porta === 5173).estado, 'perdido_no_reinicio');
  assert.deepEqual(r.portas_sem_registro.map(p => p.porta), [9999]);
});

test('o registro de serviços guarda a geração do sandbox', () => {
  const dir = path.join(tmp(), '.agent-env');
  recordServiceStart(dir, 'uvicorn app:api --port 8000 &', { generation: 3 });
  recordServiceStart(dir, 'ls -la', { generation: 3 });
  const itens = listRecordedServices(dir);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].geracao, 3);
  assert.equal(itens[0].porta, 8000);
});

// ---- 5d) Transação de workspace ---------------------------------------------
test('a transação aberta é lida, avisada e limpa', () => {
  const dir = path.join(tmp(), '.agent-env');
  assert.equal(readTransaction(dir), null);

  writeTransaction(dir, { checkpoint: 'cp-1', rotulo: 'refatorar auth', aberta_em: '2026-07-26T12:00:00Z' });
  const aberta = readTransaction(dir);
  assert.equal(aberta.checkpoint, 'cp-1');

  const aviso = formatOpenTransactionNotice(aberta);
  assert.match(aviso, /TRANSAÇÃO DE WORKSPACE ABERTA/);
  assert.match(aviso, /refatorar auth/);
  assert.match(aviso, /transacao_confirmar/);
  assert.match(aviso, /transacao_desfazer/);

  clearTransaction(dir);
  assert.equal(readTransaction(dir), null);
  assert.equal(formatOpenTransactionNotice(null), null);
});

// ---- 6) Disco e manifesto ---------------------------------------------------
test('o uso de disco aponta os maiores diretórios', () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, 'pesada'), { recursive: true });
  fs.mkdirSync(path.join(base, 'leve'), { recursive: true });
  fs.writeFileSync(path.join(base, 'pesada', 'a.bin'), Buffer.alloc(8192));
  fs.writeFileSync(path.join(base, 'leve', 'b.txt'), 'oi');
  const uso = directoryUsage(base);
  assert.ok(uso.bytes >= 8192);
  assert.equal(uso.maiores[0].caminho, 'pesada');
});

test('o manifesto diz o que é persistente, o que é temporário e quais são os limites', () => {
  const m = environmentManifest({
    instanceId: 'env-1',
    sessionKey: 'usuario/conversa',
    generation: 3,
    limits: { memoryMb: 1024, cpus: 1, pids: 256, commandTimeoutMs: 45000, maxOutputBytes: 100, idleTtlMs: 1800000, maxSandboxesPerUser: 2 },
    network: false,
    workspace: { base: '/workspace', arquivos: 7, bytes: 900 }
  });
  assert.equal(m.identificadores.geracao_do_sandbox, 3);
  assert.equal(m.limites.tempo_max_por_comando_s, 45);
  assert.equal(m.rede.disponivel_no_sandbox, false);
  assert.match(m.persistencia['/workspace'], /PERSISTENTE/);
  assert.match(m.persistencia['/runtime/tmp'], /TEMPOR/);
  assert.match(m.persistencia['/tmp'], /NÃO use/);
});
