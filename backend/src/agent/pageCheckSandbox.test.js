// Validação do dev server dentro do sandbox (Fase 38, 2ª parte).
//
// Sem Docker aqui, o `execInSandbox` é INJETADO — o que permite exercitar de
// verdade a parte que decide: montar o script, ler a saída do container e
// transformá-la em veredito. Os casos de saída suja/truncada/ausente são o
// coração do teste: nenhum deles pode virar "validado".
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  SENTINEL, sandboxUrlFor, validatePort, buildSandboxCheckScript,
  parseSandboxCheckOutput, checkSandboxPage
} from './pageCheckSandbox.js';

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fred-sandboxcheck-'));
}
const evidenciaSadia = {
  status: 200, title: 'App', visibleTextLength: 80, visualElements: 1, elementCount: 30,
  consoleErrors: [], pageErrors: [], badResponses: [], blockedRequests: [], failedRequests: [],
  navigationError: null, assercoes: [], erroFatal: null
};
const linhaSentinela = ev => `${SENTINEL}${JSON.stringify(ev)}`;

// ── puro ────────────────────────────────────────────────────────────────────

test('a URL é sempre o loopback do próprio container', () => {
  assert.equal(sandboxUrlFor(5173), 'http://127.0.0.1:5173/');
  assert.equal(sandboxUrlFor(8000, 'painel'), 'http://127.0.0.1:8000/painel');
  assert.equal(sandboxUrlFor(3000, '/a/b'), 'http://127.0.0.1:3000/a/b');
});

test('porta inválida é recusada antes de montar comando nenhum', () => {
  assert.equal(validatePort(5173).porta, 5173);
  assert.match(validatePort(0).error, /Porta inválida/);
  assert.match(validatePort(70000).error, /Porta inválida/);
  assert.match(validatePort('abc').error, /Porta inválida/);
});

test('o script é CommonJS e fixa a origem — o playwright é global na imagem', () => {
  const script = buildSandboxCheckScript({ url: 'http://127.0.0.1:5173/' });
  // `import` de ESM não honra NODE_PATH; `require` honra. Trocar isto quebra a
  // resolução do pacote global e o sintoma seria "playwright não disponível".
  assert.match(script, /require\('playwright'\)/);
  assert.doesNotMatch(script, /^import /m);
  assert.match(script, /new URL\(CFG\.url\)\.origin/);
  assert.match(script, /route\.abort\(\)/);
  assert.match(script, /executablePath: process\.env\.CHROMIUM_PATH \|\| '\/usr\/bin\/chromium'/);
});

test('o script sempre imprime a sentinela, mesmo em falha', () => {
  const script = buildSandboxCheckScript({ url: 'http://127.0.0.1:5173/' });
  // O `finally` é o que garante isto: sem ele, um erro deixaria o chamador sem
  // saber se quebrou ou se nem rodou.
  assert.match(script, /\.finally\(\(\) => \{ process\.stdout\.write/);
  assert.match(script, /erroFatal/);
});

test('o script carrega as asserções pedidas, com o valor escapado', () => {
  const script = buildSandboxCheckScript({
    url: 'http://127.0.0.1:5173/',
    esperarSeletor: '#app .lista',
    esperarTexto: 'Bem-vindo "ao" app'
  });
  assert.match(script, /"esperarSeletor":"#app \.lista"/);
  // Aspas no texto não podem quebrar o script gerado.
  assert.match(script, /Bem-vindo \\"ao\\" app/);
});

// O script é montado por concatenação de texto. Se ele não fizer parse, o
// sintoma dentro do container é um stack trace sem sentinela — que o parser
// reporta como "o navegador pode não ter iniciado", escondendo a causa real.
// `node --check` fecha essa distância.
test('o script gerado é JavaScript válido (node --check)', () => {
  const script = buildSandboxCheckScript({
    url: 'http://127.0.0.1:5173/painel?a=1',
    esperarSeletor: '#app > .lista[data-x="1"]',
    esperarTexto: "aspas ' e \" e \\ barra",
    screenshotPath: '/workspace/outputs/v.jpg'
  });
  const arquivo = path.join(os.tmpdir(), `fred-script-check-${process.pid}.cjs`);
  fs.writeFileSync(arquivo, script, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', arquivo], { stdio: 'pipe' });
  } finally {
    fs.rmSync(arquivo, { force: true });
  }
});

test('parseSandboxCheckOutput acha a sentinela no meio do ruído do dev server', () => {
  const saida = [
    'vite v5 dev server running',
    'ready in 320 ms',
    linhaSentinela(evidenciaSadia),
    '[vite] hmr update /src/App.jsx'
  ].join('\n');
  const { evidence } = parseSandboxCheckOutput(saida);
  assert.equal(evidence.status, 200);
  assert.equal(evidence.title, 'App');
});

test('saída sem sentinela e saída truncada NÃO viram validação', () => {
  assert.match(parseSandboxCheckOutput('Segmentation fault').error, /não produziu resultado/);
  assert.match(parseSandboxCheckOutput('').error, /não produziu resultado/);
  assert.match(parseSandboxCheckOutput(`${SENTINEL}{"status":20`).error, /ilegível/);
});

test('com duas sentinelas vale a ÚLTIMA — a execução mais recente', () => {
  const saida = [
    linhaSentinela({ ...evidenciaSadia, title: 'antiga' }),
    linhaSentinela({ ...evidenciaSadia, title: 'atual' })
  ].join('\n');
  assert.equal(parseSandboxCheckOutput(saida).evidence.title, 'atual');
});

// ── ciclo com execInSandbox injetado ────────────────────────────────────────

test('dev server sadio: veredito ok e o script temporário é apagado', async () => {
  const base = workspace();
  let comando = '';
  const exec = async (_conv, cmd) => { comando = cmd; return { output: linhaSentinela(evidenciaSadia), exit_code: 0 }; };

  const r = await checkSandboxPage(exec, { workspaceBase: base, conversationId: 'c1', porta: 5173 });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'http://127.0.0.1:5173/');
  assert.equal(r.medido.texto_visivel, 80);
  // NODE_PATH é o que faz o require do pacote global funcionar.
  assert.match(comando, /NODE_PATH="\$\(npm root -g\)" node \/workspace\/\.pagecheck\/check\.cjs/);
  assert.equal(fs.existsSync(path.join(base, '.pagecheck')), false, 'o script não pode ficar no workspace');
  fs.rmSync(base, { recursive: true, force: true });
});

test('o veredito é o MESMO da validação no backend (tela em branco reprova)', async () => {
  const base = workspace();
  const exec = async () => ({
    output: linhaSentinela({ ...evidenciaSadia, visibleTextLength: 0, visualElements: 0 }),
    exit_code: 0
  });
  const r = await checkSandboxPage(exec, { workspaceBase: base, conversationId: 'c1', porta: 5173 });
  assert.equal(r.ok, false);
  assert.ok(r.problemas.some(p => /EM BRANCO/.test(p)));
  fs.rmSync(base, { recursive: true, force: true });
});

test('erro de console dentro do sandbox reprova, e o recurso externo é só aviso', async () => {
  const base = workspace();
  const exec = async () => ({
    output: linhaSentinela({
      ...evidenciaSadia,
      consoleErrors: ['Failed to resolve module specifier'],
      blockedRequests: ['https://fonts.googleapis.com/css2']
    }),
    exit_code: 0
  });
  const r = await checkSandboxPage(exec, { workspaceBase: base, conversationId: 'c1', porta: 5173 });
  assert.equal(r.ok, false);
  assert.equal(r.avisos.length, 1);
  fs.rmSync(base, { recursive: true, force: true });
});

// O caso que impede o "validado" falso do outro lado: o navegador nem subiu.
test('navegador que não inicia devolve disponivel:false, nunca um veredito', async () => {
  const base = workspace();
  const exec = async () => ({
    output: linhaSentinela({ ...evidenciaSadia, erroFatal: 'Não foi possível iniciar o navegador no sandbox: ENOENT' }),
    exit_code: 1
  });
  const r = await checkSandboxPage(exec, { workspaceBase: base, conversationId: 'c1', porta: 5173 });
  assert.equal(r.disponivel, false);
  assert.equal(r.ok, undefined);
  assert.match(r.observacao, /Não afirme que a página foi validada/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('saída ilegível devolve erro com um pedaço da saída para diagnóstico', async () => {
  const base = workspace();
  const exec = async () => ({ output: 'Error: listen EADDRINUSE :::5173', exit_code: 1 });
  const r = await checkSandboxPage(exec, { workspaceBase: base, conversationId: 'c1', porta: 5173 });
  assert.match(r.erro, /não produziu resultado/);
  assert.match(r.saida, /EADDRINUSE/);
  assert.equal(r.ok, undefined);
  fs.rmSync(base, { recursive: true, force: true });
});

test('o script temporário é apagado mesmo quando a execução falha', async () => {
  const base = workspace();
  const exec = async () => { throw new Error('container morreu'); };
  await assert.rejects(() => checkSandboxPage(exec, { workspaceBase: base, conversationId: 'c1', porta: 5173 }));
  assert.equal(fs.existsSync(path.join(base, '.pagecheck')), false);
  fs.rmSync(base, { recursive: true, force: true });
});
