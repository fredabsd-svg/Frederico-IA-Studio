// Estabilidade do sandbox na EXECUÇÃO — os testes obrigatórios §9 do plano.
//
// Usa um daemon Docker falso (o node:test não tem daemon) para exercitar o
// caminho real de execInSandbox. O que provam:
//   1) toda execução devolve estado ESTRUTURADO (status, diagnóstico, duração,
//      se mexeu em arquivos) — e um comando interrompido nunca sai como sucesso;
//   2) um timeout mata a ÁRVORE DE PROCESSOS e PRESERVA o sandbox (era o
//      contrário: derrubava o container e levava junto as dependências);
//   3) quando o sandbox realmente precisa ser trocado, a execução seguinte
//      carrega o aviso estruturado de reinício — uma única vez;
//   4) o container nasce com o cache persistente do usuário montado em /cache e
//      com TMPDIR apontando para a área descartável.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frederico-stability-'));
process.env.WORKSPACE_ROOT = root;
process.env.SANDBOX_KILL_GRACE_MS = '150'; // carência curta: o teste não pode dormir 2,5s
// Intervalo do progresso no PISO permitido (200 ms; o padrão é 900 ms e o piso
// existe para não inundar o SSE). Os pedaços do teste são espaçados o
// suficiente para o intervalo bater entre eles.
process.env.SANDBOX_PROGRESS_INTERVAL_MS = '200';

const {
  _setDockerClient,
  _sessionsForTests,
  execInSandbox,
  sessionKey,
  workspaceFor,
  sandboxEnvironmentStatus,
  sandboxCheckpointCreate,
  sandboxCheckpointRestore,
  sandboxRuntimeDependencies,
  sandboxLastExecutionLog
} = await import('./sandbox.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const USER = 'usuario-estabilidade';

// ---- Daemon falso -----------------------------------------------------------
// `killEndsCommand: false` simula a árvore de processos que NÃO morre — é o
// único caso em que derrubar o container continua sendo o certo.
function fakeDocker({ output = 'ok\n', outputChunks = null, chunkDelayMs = 0, exitCode = 0, hang = false, killEndsCommand = true } = {}) {
  const state = { criados: [], execs: [], kills: 0, removidos: 0 };
  const makeContainer = (id, createOptions) => {
    let pendente = null; // stream do comando principal ainda aberto
    const container = {
      id,
      createOptions,
      modem: { demuxStream: (stream, stdout) => { stream.on('data', c => stdout.write(c)); } },
      async start() { return true; },
      async kill() { state.kills++; if (pendente) { pendente.end(); pendente = null; } return true; },
      async remove() { state.removidos++; return true; },
      async stats() { return { memory_stats: { usage: 100 * 1024 * 1024, limit: 1024 * 1024 * 1024 } }; },
      async exec(opts) {
        state.execs.push(opts);
        const ehKill = String(opts.Cmd?.[2] || '').includes('FREDERICO_EXEC_ID=');
        return {
          async start() {
            const stream = new PassThrough();
            if (ehKill) {
              // O "kill" encontrou a árvore e a encerrou: o comando principal
              // termina sozinho, sem precisar derrubar o container.
              if (killEndsCommand && pendente) { pendente.end(); pendente = null; }
              setImmediate(() => stream.end());
              return stream;
            }
            if (hang) { pendente = stream; return stream; } // nunca termina por conta própria
            // Emissão em pedaços, opcionalmente espaçados: é o que permite
            // verificar que o progresso chega ANTES do comando terminar.
            const chunks = outputChunks || [output];
            let i = 0;
            const emite = () => {
              if (i >= chunks.length) { stream.end(); return; }
              const chunk = chunks[i++];
              if (chunk) stream.write(Buffer.from(chunk));
              if (chunkDelayMs > 0) setTimeout(emite, chunkDelayMs).unref?.();
              else setImmediate(emite);
            };
            setImmediate(emite);
            return stream;
          },
          async inspect() { return { ExitCode: hang ? -1 : exitCode }; }
        };
      }
    };
    return container;
  };
  return {
    state,
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:falsa' }) }),
    async createContainer(options) {
      state.criados.push(options);
      return makeContainer(`container-${state.criados.length}`, options);
    },
    getContainer: (id) => makeContainer(id, null),
    async listContainers() { return []; }
  };
}

function limpaSessoes() { _sessionsForTests.clear(); }

// ---- 1) Resultado estruturado ----------------------------------------------
test('execução bem-sucedida devolve estado estruturado e diagnóstico OK', async () => {
  limpaSessoes();
  _setDockerClient(fakeDocker({ output: 'tudo certo\n', exitCode: 0 }));
  const conversa = 'conversa-sucesso-1';
  const r = await execInSandbox(conversa, 'echo tudo certo', 5000, { userId: USER });

  assert.equal(r.exitCode, 0);
  assert.equal(r.status, 'ok');
  assert.equal(r.sucesso, true);
  assert.equal(r.processo_encerrado, false);
  assert.equal(r.diagnostico.categoria, 'OK');
  assert.ok(typeof r.duracao_ms === 'number');
  assert.match(r.output, /tudo certo/);
});

test('erro de dependência sai classificado como AMBIENTE, não como bug do projeto', async () => {
  limpaSessoes();
  _setDockerClient(fakeDocker({ output: "ModuleNotFoundError: No module named 'requests'\n", exitCode: 1 }));
  const r = await execInSandbox('conversa-dependencia-1', 'python -c "import requests"', 5000, { userId: USER });
  assert.equal(r.sucesso, false);
  assert.equal(r.diagnostico.categoria, 'DEPENDENCY_ERROR');
  assert.equal(r.diagnostico.falha_do_projeto, false);
});

// ---- 2) Timeout preserva o sandbox -----------------------------------------
test('timeout mata a árvore de processos e PRESERVA o sandbox', async () => {
  limpaSessoes();
  const docker = fakeDocker({ hang: true, killEndsCommand: true });
  _setDockerClient(docker);
  const conversa = 'conversa-timeout-1';

  const r = await execInSandbox(conversa, 'sleep 999', 120, { userId: USER });

  assert.equal(r.status, 'timeout');
  assert.equal(r.sucesso, false, 'timeout JAMAIS pode sair como sucesso');
  assert.equal(r.exitCode, 124);
  assert.equal(r.processo_encerrado, true);
  assert.match(r.output, /TIMEOUT/);
  assert.match(r.output, /o sandbox continua de pé/);

  // A varredura por FREDERICO_EXEC_ID é o que alcança netos e bisnetos.
  const kill = docker.state.execs.find(e => String(e.Cmd?.[2] || '').includes('FREDERICO_EXEC_ID='));
  assert.ok(kill, 'o timeout precisa disparar o encerramento da árvore de processos');
  assert.match(kill.Cmd[2], /kill -TERM/);
  assert.match(kill.Cmd[2], /kill -KILL/);

  assert.equal(docker.state.kills, 0, 'o container NÃO pode ser derrubado quando a árvore morreu');
  assert.ok(_sessionsForTests.has(sessionKey(USER, conversa)), 'o sandbox segue em serviço depois do timeout');
});

test('se a árvore não morrer, o container é derrubado — e o próximo comando avisa o reinício', async () => {
  limpaSessoes();
  const docker = fakeDocker({ hang: true, killEndsCommand: false });
  _setDockerClient(docker);
  const conversa = 'conversa-timeout-2';

  const primeiro = await execInSandbox(conversa, 'sleep 999', 120, { userId: USER });
  assert.equal(primeiro.status, 'timeout');
  assert.ok(docker.state.kills >= 1, 'último recurso: derrubar o container');
  assert.ok(!_sessionsForTests.has(sessionKey(USER, conversa)));

  // A execução seguinte materializa um container novo — e precisa DIZER isso.
  _setDockerClient(fakeDocker({ output: 'ok\n', exitCode: 0 }));
  const segundo = await execInSandbox(conversa, 'echo ok', 5000, { userId: USER });
  assert.ok(segundo.ambiente_reiniciado, 'o modelo precisa ser avisado do reinício');
  assert.equal(segundo.ambiente_reiniciado.motivo, 'timeout');
  assert.ok(segundo.ambiente_reiniciado.preservado.some(t => /workspace/i.test(t)));
  assert.ok(segundo.ambiente_reiniciado.perdido.some(t => /pacotes/i.test(t)));

  const terceiro = await execInSandbox(conversa, 'echo ok', 5000, { userId: USER });
  assert.equal(terceiro.ambiente_reiniciado, undefined, 'o aviso é entregue uma única vez');
});

// ---- 3) Alterações em arquivos ---------------------------------------------
test('a execução informa se chegou a mexer em arquivos do workspace', async () => {
  limpaSessoes();
  const conversa = 'conversa-arquivos-1';
  const ws = workspaceFor(conversa, USER);
  _setDockerClient(fakeDocker({ output: '', exitCode: 0 }));

  const semMudanca = await execInSandbox(conversa, 'true', 5000, { userId: USER });
  assert.equal(semMudanca.arquivos_alterados, false);

  // O daemon é falso, então o "efeito" do comando é simulado no host — que é
  // exatamente o mesmo diretório que o bind exporia dentro do container.
  const docker = fakeDocker({ output: '', exitCode: 0 });
  const criaArquivo = docker.createContainer.bind(docker);
  docker.createContainer = async (opts) => {
    fs.writeFileSync(path.join(ws.outputs, 'relatorio.txt'), 'gerado pelo comando');
    return criaArquivo(opts);
  };
  limpaSessoes();
  _setDockerClient(docker);
  const comMudanca = await execInSandbox(conversa, 'python gera.py', 5000, { userId: USER });
  assert.equal(comMudanca.arquivos_alterados, true);
});

// ---- 4) Camadas de persistência --------------------------------------------
test('o container nasce com o cache do usuário em /cache e o TMPDIR descartável', async () => {
  limpaSessoes();
  const docker = fakeDocker();
  _setDockerClient(docker);
  const conversa = 'conversa-camadas-1';
  await execInSandbox(conversa, 'echo oi', 5000, { userId: USER });

  const criado = docker.state.criados[0];
  assert.ok(criado.HostConfig.Binds.some(b => b.endsWith(':/workspace')));
  assert.ok(criado.HostConfig.Binds.some(b => b.endsWith(':/cache')), 'o cache de pacotes precisa ser bind do host');
  assert.ok(criado.HostConfig.Binds.some(b => b.includes(path.join('users', USER, '.cache'))), 'o cache é escopado por usuário');
  assert.ok(fs.existsSync(path.join(root, 'users', USER, '.cache', 'pip')));

  const exec = docker.state.execs[0];
  assert.ok(exec.Env.includes('TMPDIR=/runtime/tmp'));
  assert.ok(exec.Env.includes('PIP_CACHE_DIR=/cache/pip'));
  assert.ok(exec.Env.includes('npm_config_cache=/cache/npm'));
  assert.ok(exec.Env.some(v => v.startsWith('FREDERICO_EXEC_ID=')));
});

test('instalação bem-sucedida entra no manifesto; interrompida, não', async () => {
  limpaSessoes();
  const conversa = 'conversa-manifesto-1';

  _setDockerClient(fakeDocker({ output: 'Successfully installed requests\n', exitCode: 0 }));
  await execInSandbox(conversa, 'pip install requests', 5000, { userId: USER });
  assert.deepEqual(sandboxRuntimeDependencies(USER, conversa).map(i => i.gerenciador), ['pip']);

  limpaSessoes();
  _setDockerClient(fakeDocker({ hang: true }));
  await execInSandbox(conversa, 'pip install pandas', 120, { userId: USER });
  assert.equal(sandboxRuntimeDependencies(USER, conversa).length, 1, 'um install cortado por timeout não pode entrar no manifesto');
});

// ---- 4b) Streaming da saída -------------------------------------------------
test('a saída chega em pedaços ANTES do fim e o log em disco guarda tudo', async () => {
  limpaSessoes();
  const conversa = 'conversa-streaming-1';
  // Três pedaços espaçados: o comando só termina depois do último, então um
  // evento de progresso que chegue antes disso prova o streaming.
  _setDockerClient(fakeDocker({
    outputChunks: ['COMEÇO: coletando testes\n', 'meio\n'.repeat(3000), 'FIM: 3000 passaram\n'],
    chunkDelayMs: 300,
    exitCode: 0
  }));

  const eventos = [];
  const r = await execInSandbox(conversa, 'pytest -q', 5000, {
    userId: USER,
    onProgress: (p) => eventos.push(p)
  });

  assert.equal(r.status, 'ok');
  assert.ok(eventos.length >= 2, `o progresso precisa chegar em pedaços (recebidos: ${eventos.length})`);
  // O primeiro evento traz só o começo: chegou enquanto o comando ainda rodava.
  assert.match(eventos[0].trecho, /COMEÇO: coletando testes/);
  assert.ok(!eventos[0].trecho.includes('FIM: 3000 passaram'), 'o primeiro evento é anterior ao fim do comando');
  assert.ok(eventos.at(-1).linhas > eventos[0].linhas, 'os contadores avançam a cada pedaço');
  // Mais de 200 linhas: o resumo de progresso entra no resultado.
  assert.ok(r.progresso, 'saída longa deve trazer o resumo de progresso');
  assert.equal(r.progresso.linhas, 3002);
  assert.equal(r.progresso.log_completo, '.agent-env/ultima-execucao.log');

  // O resultado é aparado nos últimos 12 mil caracteres e PERDE o começo; o log
  // em disco é o que permite ao agente ver onde a coisa começou a dar errado.
  assert.ok(!r.output.includes('COMEÇO: coletando testes'), 'o resultado aparado perde o começo');
  const log = fs.readFileSync(path.join(workspaceFor(conversa, USER).agentEnv, 'ultima-execucao.log'), 'utf8');
  assert.match(log, /COMEÇO: coletando testes/);
  assert.match(log, /FIM: 3000 passaram/);
});

test('comando curto e bem-sucedido NÃO carrega resumo de progresso (evita ruído)', async () => {
  limpaSessoes();
  _setDockerClient(fakeDocker({ output: 'ok\n', exitCode: 0 }));
  const r = await execInSandbox('conversa-streaming-2', 'echo ok', 5000, { userId: USER });
  assert.equal(r.progresso, undefined);
});

test('o log do último comando é lido pela ação ultima_execucao, com as duas pontas', async () => {
  limpaSessoes();
  const conversa = 'conversa-streaming-3';
  _setDockerClient(fakeDocker({ output: 'saída curta\n', exitCode: 3 }));
  await execInSandbox(conversa, 'python quebra.py', 5000, { userId: USER });

  const log = sandboxLastExecutionLog(USER, conversa);
  assert.equal(log.existe, true);
  assert.equal(log.comando, 'python quebra.py');
  assert.equal(log.exit_code, 3);
  assert.match(log.trecho_inicial, /saída curta/);
});

test('a gravação do log NÃO conta como "o comando mexeu em arquivos"', async () => {
  limpaSessoes();
  const conversa = 'conversa-streaming-4';
  workspaceFor(conversa, USER);
  _setDockerClient(fakeDocker({ output: 'muita saída\n'.repeat(50), exitCode: 0 }));
  const r = await execInSandbox(conversa, 'echo muito', 5000, { userId: USER });
  assert.equal(r.arquivos_alterados, false, 'o log e o manifesto são escrituração interna, não trabalho do comando');
});

// ---- 5) Status e checkpoints pelo caminho público --------------------------
test('o status do ambiente descreve limites, persistência e geração', async () => {
  limpaSessoes();
  _setDockerClient(fakeDocker());
  const conversa = 'conversa-status-1';
  await execInSandbox(conversa, 'echo oi', 5000, { userId: USER });

  const status = sandboxEnvironmentStatus(USER, conversa, { networkEnabled: false });
  assert.equal(status.identificadores.geracao_do_sandbox, 1);
  assert.equal(status.sandbox.ativo, true);
  assert.equal(status.rede.disponivel_no_sandbox, false);
  assert.match(status.persistencia['/cache'], /PERSISTENTE/);
  assert.ok(status.limites.memoria_mb > 0);
});

test('checkpoint e restauração pelo caminho público devolvem o workspace ao ponto anterior', () => {
  const conversa = 'conversa-checkpoint-1';
  const ws = workspaceFor(conversa, USER);
  fs.writeFileSync(path.join(ws.base, 'projeto.py'), 'versao = 1\n');

  const cp = sandboxCheckpointCreate(USER, conversa, { label: 'antes' });
  fs.writeFileSync(path.join(ws.base, 'projeto.py'), 'versao = 2 (quebrada)\n');

  const r = sandboxCheckpointRestore(USER, conversa, cp.id);
  assert.equal(fs.readFileSync(path.join(ws.base, 'projeto.py'), 'utf8'), 'versao = 1\n');
  assert.ok(r.checkpoint_de_seguranca, 'o estado atual vira checkpoint antes de ser sobrescrito');

  // Os checkpoints ficam FORA da árvore da conversa (senão o snapshot seguinte
  // copiaria o anterior e o próprio sandbox poderia apagá-los).
  assert.ok(fs.existsSync(path.join(root, '.checkpoints', USER, conversa)));
  assert.ok(!fs.existsSync(path.join(ws.base, '.checkpoints')));
});
