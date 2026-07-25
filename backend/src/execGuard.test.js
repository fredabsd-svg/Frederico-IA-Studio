// Guarda de execução: o que a IA pode rodar no sandbox e o que exige
// autorização explícita do usuário. Cobre as três regras do execGuard.js —
// caminho de sistema, Pastas do PC (arquivos reais) e fuga para o shell — e a
// função pura que lê a autorização no texto do pedido.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardCommand, guardPythonCode, explicitlyAuthorizesPcWrite } from './execGuard.js';

const blocks = (fn) => {
  try { fn(); return null; }
  catch (e) { return e; }
};

// ---- bash: padrões destrutivos clássicos -------------------------------------

test('bash: bloqueia rm -rf em caminho de sistema (inclusive com espaços duplos)', () => {
  assert.ok(blocks(() => guardCommand('rm  -rf /')));
  assert.ok(blocks(() => guardCommand('rm -fr /home')));
});

test('bash: permite rm -rf dentro do workspace', () => {
  assert.equal(guardCommand('rm -rf build'), true);
  assert.equal(guardCommand('rm -rf ./node_modules'), true);
});

test('bash: bloqueia escalonamento, docker, fork bomb e desligamento', () => {
  for (const cmd of ['sudo apt install x', 'docker ps', ':(){ :|:& };:', 'shutdown -h now']) {
    assert.ok(blocks(() => guardCommand(cmd)), `deveria bloquear: ${cmd}`);
  }
});

test('bash: permite comandos comuns de análise', () => {
  for (const cmd of ['python analise.py', 'ls -la outputs', 'libreoffice --headless --convert-to pdf x.docx']) {
    assert.equal(guardCommand(cmd), true, `não deveria bloquear: ${cmd}`);
  }
});

// ---- Pastas do PC: arquivos REAIS do usuário ---------------------------------

test('bash: alterar /mnt/pc sem autorização é bloqueado com orientação de confirmar', () => {
  const err = blocks(() => guardCommand('rm /mnt/pc/clientes/nota.pdf'));
  assert.ok(err, 'deveria bloquear');
  assert.equal(err.needsAuthorization, true);
  assert.match(err.message, /confirme|confirmar|confirmação|confirm/i);
});

test('bash: LER /mnt/pc continua livre (só a alteração é travada)', () => {
  assert.equal(guardCommand('ls -la /mnt/pc/clientes'), true);
  assert.equal(guardCommand('cat /mnt/pc/clientes/balanco.csv'), true);
});

test('bash: com autorização do turno, alterar /mnt/pc é liberado', () => {
  assert.equal(guardCommand('mv /mnt/pc/clientes/a.pdf /mnt/pc/clientes/_org/a.pdf', { pcWriteAuthorized: true }), true);
});

// ---- run_python: a lacuna que existia ---------------------------------------

test('python: rmtree numa Pasta do PC sem autorização é bloqueado', () => {
  const err = blocks(() => guardPythonCode("import shutil\nshutil.rmtree('/mnt/pc/clientes')"));
  assert.ok(err, 'deveria bloquear');
  assert.equal(err.needsAuthorization, true);
});

test('python: os.remove e open(w) numa Pasta do PC sem autorização são bloqueados', () => {
  assert.ok(blocks(() => guardPythonCode("import os\nos.remove('/mnt/pc/docs/x.pdf')")));
  assert.ok(blocks(() => guardPythonCode("open('/mnt/pc/docs/x.txt', 'w').write('oi')")));
  assert.ok(blocks(() => guardPythonCode("Path('/mnt/pc/docs/x.txt').unlink()")));
});

test('python: LER uma Pasta do PC nunca é bloqueado', () => {
  assert.equal(guardPythonCode("import pandas as pd\ndf = pd.read_csv('/mnt/pc/dados/balanco.csv')"), true);
  assert.equal(guardPythonCode("open('/mnt/pc/docs/x.txt', 'r').read()"), true);
  assert.equal(guardPythonCode("import os\nprint(os.listdir('/mnt/pc/docs'))"), true);
});

test('python: escrever no workspace da conversa continua livre', () => {
  assert.equal(guardPythonCode("open('/workspace/outputs/relatorio.xlsx', 'wb').write(b'')"), true);
  assert.equal(guardPythonCode("import shutil\nshutil.rmtree('tmp_build')"), true);
});

test('python: com autorização do turno, organizar a Pasta do PC é liberado', () => {
  const code = "import shutil\nshutil.move('/mnt/pc/docs/a.pdf', '/mnt/pc/docs/_organizado/a.pdf')";
  assert.equal(guardPythonCode(code, { pcWriteAuthorized: true }), true);
});

test('python: escrita/remoção em caminho de SISTEMA é bloqueada mesmo com autorização', () => {
  assert.ok(blocks(() => guardPythonCode("import os\nos.remove('/etc/passwd')", { pcWriteAuthorized: true })));
  assert.ok(blocks(() => guardPythonCode("open('/usr/bin/x', 'w')", { pcWriteAuthorized: true })));
});

test('python: comentário com trecho perigoso não bloqueia', () => {
  assert.equal(guardPythonCode("# shutil.rmtree('/mnt/pc/docs') seria destrutivo\nprint('ok')"), true);
});

// ---- fuga para o shell dentro do Python --------------------------------------

test('python: os.system com comando destrutivo cai na mesma guarda do bash', () => {
  assert.ok(blocks(() => guardPythonCode("import os\nos.system('rm -rf /')")));
  assert.ok(blocks(() => guardPythonCode("import subprocess\nsubprocess.run('sudo rm x', shell=True)")));
});

test('python: os.system com comando inofensivo passa', () => {
  assert.equal(guardPythonCode("import os\nos.system('ls -la')"), true);
});

// ---- autorização lida do pedido do usuário ----------------------------------

test('autorização: pedidos claros de alterar/organizar arquivos autorizam', () => {
  for (const texto of [
    'Organize a pasta de clientes por ano',
    'Apague os arquivos duplicados da pasta Documentos',
    'Salve o relatório na minha pasta do computador',
    'Renomeie os arquivos da pasta conforme a data',
  ]) {
    assert.equal(explicitlyAuthorizesPcWrite(texto), true, `deveria autorizar: ${texto}`);
  }
});

test('autorização: pedidos de leitura/análise NÃO autorizam escrita', () => {
  for (const texto of [
    'Quanto foi o lucro líquido no balanço?',
    'Liste os arquivos da pasta de clientes',
    'Analise os PDFs da pasta e me diga o total',
    'Faça um resumo desse documento',
  ]) {
    assert.equal(explicitlyAuthorizesPcWrite(texto), false, `não deveria autorizar: ${texto}`);
  }
});

test('autorização: frase negativa mantém a proteção', () => {
  assert.equal(explicitlyAuthorizesPcWrite('Organize a lista mas não apague nenhum arquivo'), false);
  assert.equal(explicitlyAuthorizesPcWrite('Analise sem alterar os arquivos da pasta'), false);
});

test('autorização: texto vazio ou ausente nunca autoriza', () => {
  assert.equal(explicitlyAuthorizesPcWrite(''), false);
  assert.equal(explicitlyAuthorizesPcWrite(null), false);
  assert.equal(explicitlyAuthorizesPcWrite(undefined), false);
});

test('autorização: verbo e alvo em frases diferentes não autorizam', () => {
  // "crie uma planilha" (workspace) + "a pasta tem 40 itens" (menção solta) não
  // é um pedido para alterar os arquivos do computador.
  assert.equal(explicitlyAuthorizesPcWrite('Crie uma planilha com o resumo. A pasta tem 40 itens.'), false);
});
