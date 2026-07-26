// Teste INTEGRADO do Modo Design: rotas Express reais + PostgreSQL real +
// um provedor de IA FALSO respondendo no formato da API da OpenAI.
//
// O provedor falso é o que torna este teste possível sem chave paga e sem rede,
// e é ele que permite exercitar o caminho que mais importa: a resposta do
// modelo chega suja (conversa em volta, cerca de código, JSON errado) e o app
// tem de decidir entre gravar uma versão ou recusar. Nenhum teste de função
// pura cobre a rota inteira — validação, escrita, chat, preview e exportação
// juntos.
//
// Sem DATABASE_URL, é pulado (mesma convenção dos demais testes de banco).
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const { encryptSecret } = await import('../crypto.js');
const designRouter = (await import('./design.js')).default;

const stamp = Date.now();
const USER_A = `design-http-a-${stamp}`;
const USER_B = `design-http-b-${stamp}`;

const HTML = '<!DOCTYPE html><html lang="pt-BR"><head><title>Landing</title></head><body><h1>Contabilidade</h1></body></html>';

// ---- Provedor de IA falso ---------------------------------------------------
// Devolve o que o teste mandar na próxima resposta (`nextReply`), no envelope
// de chat completion. `finish_reason` é configurável porque o corte por limite
// de tokens é um caso que precisa de guarda própria.
let nextReply = HTML;
let nextFinish = 'stop';
let lastRequest = null;

const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    lastRequest = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fake',
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: nextReply }, finish_reason: nextFinish }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
});

let server, baseUrl, providerUrl;
let currentUser = USER_A;

if (dbReady) {
  provider.listen(0, '127.0.0.1');
  await new Promise(resolve => provider.once('listening', resolve));
  providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;

  for (const id of [USER_A, USER_B]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@teste.local`, false, now(), now());
    await db.prepare(
      `INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(`prov-${id}`, id, 'openai', 'Falso', providerUrl, encryptSecret('sk-teste'),
      JSON.stringify([{ id: 'fake-model' }]), 'fake-model', now(), now());
  }

  const app = express();
  app.use(express.json());
  // Autenticação simulada: o portão real (requireAuth) é exercitado por outros
  // caminhos; aqui o que importa é a rota funcionar com req.userId — e que a
  // troca de usuário prove o isolamento.
  app.use('/api', (req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser }; next(); });
  app.use('/api', designRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  provider?.close();
  if (!dbReady) return;
  for (const id of [USER_A, USER_B]) {
    await db.prepare('DELETE FROM "user" WHERE id=?').run(id);
  }
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* preview/export não são JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function newProject(outputType = 'web', prompt = 'uma landing de contabilidade') {
  nextReply = outputType === 'slides'
    ? '{"slides":[{"layout":"title","title":"Proposta","body":"Sub"},{"layout":"content","title":"Escopo","body":"- a\\n- b"}]}'
    : HTML;
  const r = await call('POST', '/api/design/projects', { outputType, prompt });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

// ---- Criação e geração ------------------------------------------------------

test('criar com prompt já entrega a primeira versão renderizável', { skip: needsDb }, async () => {
  const project = await newProject();
  assert.equal(project.outputType, 'web');
  assert.equal(project.currentVersion.versionNumber, 1);
  assert.equal(project.currentVersion.content, HTML);
  assert.match(project.previewUrl, /\/api\/design\/preview\/.{16,}/);
  // Sem título explícito, o pedido vira o nome — uma lista de "Novo site" não
  // ajuda ninguém a achar o projeto certo depois.
  assert.equal(project.title, 'uma landing de contabilidade');
});

test('o system prompt enviado ao modelo muda com o tipo de saída', { skip: needsDb }, async () => {
  await newProject('slides', 'apresentação sobre a reforma');
  assert.match(lastRequest.messages[0].content, /"slides"/);
  await newProject('document', 'proposta em pdf');
  assert.match(lastRequest.messages[0].content, /A4/);
});

test('resposta suja é limpa antes de virar versão', { skip: needsDb }, async () => {
  const project = await newProject();
  nextReply = `Claro! Segue a página:\n\n\`\`\`html\n${HTML}\n\`\`\`\n\nQualquer ajuste é só pedir.`;
  const r = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'deixe o título maior' });
  assert.equal(r.status, 200);
  assert.equal(r.json.currentVersion.content, HTML, 'nem a conversa nem a cerca podem entrar no artefato');
});

test('a edição reenvia o artefato atual e manda NÃO recomeçar', { skip: needsDb }, async () => {
  const project = await newProject();
  nextReply = HTML;
  await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'troque a cor' });
  const userMsg = lastRequest.messages.at(-1).content;
  assert.match(userMsg, /HTML ATUAL/);
  assert.ok(userMsg.includes(HTML));
  assert.match(userMsg, /troque a cor/);
});

test('resposta sem HTML não vira versão — e o erro aparece no chat', { skip: needsDb }, async () => {
  const project = await newProject();
  nextReply = 'Prefiro descrever: um cabeçalho azul com o logo à esquerda.';
  const r = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'mude o cabeçalho' });

  assert.equal(r.status, 502);
  assert.match(r.json.error, /HTML completo/);
  // A versão boa continua valendo: uma geração ruim não pode derrubar o preview.
  assert.equal(r.json.currentVersion.versionNumber, 1);
  assert.equal(r.json.versions.length, 1);
  // A pergunta e a explicação ficam registradas — um erro sem a pergunta que o
  // causou não ajuda ninguém a reformular.
  const roles = r.json.messages.map(m => m.role);
  assert.deepEqual(roles.slice(-2), ['user', 'assistant']);
  assert.match(r.json.messages.at(-1).content, /HTML completo/);
});

test('resposta cortada por limite de tokens é recusada', { skip: needsDb }, async () => {
  const project = await newProject();
  nextReply = '<!DOCTYPE html><html><body><h1>Come';
  nextFinish = 'length';
  const r = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'refaça' });
  nextFinish = 'stop';
  assert.equal(r.status, 502);
  assert.match(r.json.error, /limite de tamanho/);
  assert.equal(r.json.versions.length, 1, 'o HTML pela metade não pode virar versão');
});

test('slides: JSON fora do formato é recusado; no formato, vira versão', { skip: needsDb }, async () => {
  const project = await newProject('slides', 'apresentação de 4 slides');
  assert.equal(JSON.parse(project.currentVersion.content).slides.length, 2);

  nextReply = '{"paginas":[{"titulo":"a"}]}';
  const bad = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'mais um slide' });
  assert.equal(bad.status, 502);
  assert.match(bad.json.error, /"slides"/);
});

test('pedido vazio é barrado antes de chegar ao provedor', { skip: needsDb }, async () => {
  const project = await newProject();
  const r = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: '   ' });
  assert.equal(r.status, 400);
});

// ---- Versões ----------------------------------------------------------------

test('reverter troca a versão em exibição e mantém o histórico', { skip: needsDb }, async () => {
  const project = await newProject();
  const v1 = project.currentVersion.id;
  nextReply = HTML.replace('Contabilidade', 'Contabilidade 2');
  const second = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'versão 2' });
  assert.equal(second.json.versions.length, 2);

  const reverted = await call('POST', `/api/design/projects/${project.id}/revert`, { versionId: v1 });
  assert.equal(reverted.status, 200);
  assert.equal(reverted.json.currentVersionId, v1);
  assert.equal(reverted.json.versions.length, 2, 'reverter não apaga o que veio depois');
});

test('a resposta da geração aponta para a versão NOVA, não para a anterior', { skip: needsDb }, async () => {
  // Regressão encontrada pelo teste de navegador: o handler serializava a linha
  // do projeto carregada ANTES da geração, então `currentVersionId` vinha
  // velho. O efeito na tela era duplo — o histórico marcava a versão errada
  // como "em exibição" e o iframe, que recarrega quando esse id muda, seguia
  // mostrando o design anterior. Parecia que o pedido não tinha feito nada.
  const project = await newProject();
  const v1 = project.currentVersionId;
  nextReply = HTML.replace('Contabilidade', 'Contabilidade II');

  const r = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'segunda versão' });
  assert.equal(r.status, 200);
  assert.notEqual(r.json.currentVersionId, v1);
  assert.equal(r.json.currentVersionId, r.json.currentVersion.id);
  assert.equal(r.json.currentVersion.versionNumber, 2);
  assert.equal(r.json.versions[0].id, r.json.currentVersionId, 'a versão nova é a do topo');
});

test('reverter para uma versão inexistente responde 404', { skip: needsDb }, async () => {
  const project = await newProject();
  const r = await call('POST', `/api/design/projects/${project.id}/revert`, { versionId: 'nao-existe' });
  assert.equal(r.status, 404);
});

// ---- Isolamento entre contas ------------------------------------------------

test('projeto de outra conta é 404 em todas as rotas', { skip: needsDb }, async () => {
  const project = await newProject();
  currentUser = USER_B;
  try {
    for (const [method, path, body] of [
      ['GET', `/api/design/projects/${project.id}`],
      ['GET', `/api/design/projects/${project.id}/versions`],
      ['GET', `/api/design/projects/${project.id}/preview`],
      ['GET', `/api/design/projects/${project.id}/export`],
      ['PATCH', `/api/design/projects/${project.id}`, { title: 'sequestrado' }],
      ['DELETE', `/api/design/projects/${project.id}`],
      ['POST', `/api/design/projects/${project.id}/generate`, { prompt: 'mude tudo' }],
    ]) {
      const r = await call(method, path, body);
      assert.equal(r.status, 404, `${method} ${path} devia ser 404`);
    }
    assert.ok(!(await call('GET', '/api/design/projects')).json.some(p => p.id === project.id));
  } finally {
    currentUser = USER_A;
  }
});

// ---- Preview ----------------------------------------------------------------

test('o preview roda em origem opaca: CSP sandbox sem allow-same-origin', { skip: needsDb }, async () => {
  const project = await newProject();
  const token = project.previewUrl.split('/').pop();
  const r = await call('GET', `/api/design/preview/${token}`);

  assert.equal(r.status, 200);
  assert.equal(r.text, HTML);
  const csp = r.headers.get('content-security-policy');
  // Este cabeçalho é o que impede o HTML gerado por IA de enxergar o cookie de
  // sessão e o DOM do app, mesmo servido do mesmo domínio. `allow-same-origin`
  // aqui desfaria o isolamento inteiro.
  assert.match(csp, /sandbox allow-scripts/);
  assert.ok(!csp.includes('allow-same-origin'), 'allow-same-origin quebraria o sandbox');
  assert.match(csp, /frame-ancestors/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('token inválido não vaza a existência do projeto', { skip: needsDb }, async () => {
  const r = await call('GET', '/api/design/preview/token-que-nao-existe-mas-e-longo');
  assert.equal(r.status, 404);
  assert.match(r.text, /Prévia não encontrada/);
});

test('slides: o preview entrega o deck montado por nós, não o JSON cru', { skip: needsDb }, async () => {
  const project = await newProject('slides', 'apresentação');
  const r = await call('GET', `/api/design/projects/${project.id}/preview`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<!DOCTYPE html>/);
  assert.match(r.text, /class="slide /);
  assert.ok(!r.text.includes('"layout"'), 'o JSON não pode vazar para a página');
});

test('projeto sem versão mostra um aviso, não uma tela em branco', { skip: needsDb }, async () => {
  const r = await call('POST', '/api/design/projects', { outputType: 'web', title: 'Vazio' });
  const preview = await call('GET', `/api/design/projects/${r.json.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /ainda não tem nenhuma versão/);
});

test('conteúdo que não bate com o tipo não é renderizado', { skip: needsDb }, async () => {
  // Descasamento que só um bug de escrita ou um restore torto produz — e que
  // renderizaria JSON como se fosse HTML dentro do iframe.
  const project = await newProject('slides', 'apresentação');
  await db.prepare('UPDATE design_versions SET content=? WHERE id=?').run(HTML, project.currentVersion.id);
  const preview = await call('GET', `/api/design/projects/${project.id}/preview`);
  assert.match(preview.text, /não corresponde ao tipo/);
  const exported = await call('GET', `/api/design/projects/${project.id}/export`);
  assert.equal(exported.status, 409);
});

// ---- Exportação -------------------------------------------------------------

test('exportar web devolve o .html como anexo, com nome derivado do título', { skip: needsDb }, async () => {
  const project = await newProject();
  await call('PATCH', `/api/design/projects/${project.id}`, { title: 'Proposta Comercial — Ação' });
  const r = await call('GET', `/api/design/projects/${project.id}/export?format=html`);
  assert.equal(r.status, 200);
  assert.equal(r.text, HTML);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="proposta-comercial-acao\.html"/);
  // `attachment` + nosniff: o arquivo baixa, não abre na origem do app.
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('formato fora da lista do tipo cai no padrão em vez de errar', { skip: needsDb }, async () => {
  const project = await newProject();
  const r = await call('GET', `/api/design/projects/${project.id}/export?format=pptx`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /\.html"/);
});

test('slides exportam .pptx abrível', { skip: needsDb }, async () => {
  const project = await newProject('slides', 'apresentação');
  const res = await fetch(`${baseUrl}/api/design/projects/${project.id}/export?format=pptx`);
  assert.equal(res.status, 200);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.equal(buffer.subarray(0, 2).toString('binary'), 'PK', 'um .pptx é um zip');
  assert.match(res.headers.get('content-type'), /presentationml/);
});

test('exportar uma versão antiga não exige reverter o projeto', { skip: needsDb }, async () => {
  const project = await newProject();
  const v1 = project.currentVersion.id;
  const outro = HTML.replace('Contabilidade', 'Segunda versão');
  nextReply = outro;
  await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'versão 2' });

  const atual = await call('GET', `/api/design/projects/${project.id}/export`);
  assert.equal(atual.text, outro);
  const antiga = await call('GET', `/api/design/projects/${project.id}/export?versionId=${v1}`);
  assert.equal(antiga.text, HTML);
});

test('exportar projeto sem versão responde 404 com explicação', { skip: needsDb }, async () => {
  const r = await call('POST', '/api/design/projects', { outputType: 'web', title: 'Vazio' });
  const exported = await call('GET', `/api/design/projects/${r.json.id}/export`);
  assert.equal(exported.status, 404);
  assert.match(exported.json.error, /nenhuma versão/);
});

// ---- Design systems ---------------------------------------------------------

test('a marca entra no prompt e valores inválidos não passam', { skip: needsDb }, async () => {
  const created = await call('POST', '/api/design/systems', {
    name: 'Frederico', primaryColor: '#0a7d55', secondaryColor: 'verde-limão',
    fontHeading: "Inter'; } body{display:none}", fontBody: 'Inter',
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.primaryColor, '#0a7d55');
  assert.equal(created.json.secondaryColor, null, 'cor livre viraria injeção de CSS no artefato');
  assert.equal(created.json.fontHeading, null);

  nextReply = HTML;
  const project = await call('POST', '/api/design/projects', {
    outputType: 'web', prompt: 'landing', designSystemId: created.json.id,
  });
  assert.equal(project.status, 200);
  assert.match(lastRequest.messages[0].content, /#0a7d55/);
  assert.match(lastRequest.messages[0].content, /DESIGN SYSTEM DO USUÁRIO/);
});

test('projeto com marca de outra conta é recusado', { skip: needsDb }, async () => {
  const mine = await call('POST', '/api/design/systems', { name: 'Minha', primaryColor: '#111111' });
  currentUser = USER_B;
  try {
    const r = await call('POST', '/api/design/projects', { outputType: 'web', designSystemId: mine.json.id });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /não encontrado/);
  } finally {
    currentUser = USER_A;
  }
});
