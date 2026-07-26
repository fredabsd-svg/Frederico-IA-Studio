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
  // O artefato sai inteiro; a prévia acrescenta a ponte de seleção/ajuste (v2),
  // que NÃO acompanha a exportação — o teste do .html baixado guarda isso.
  assert.ok(r.text.startsWith(HTML.replace('</body></html>', '')));
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

// ---- v2: ajustes finos (sliders) -------------------------------------------

// Artefato que segue o contrato das variáveis de ajuste (o system prompt exige
// esse bloco :root em toda saída HTML).
const HTML_TOKENS = [
  '<!DOCTYPE html><html lang="pt-BR"><head><style>',
  ':root{--fred-cor-primaria:#1f3b8a;--fred-cor-secundaria:#e8523f;--fred-fonte-base:16px;--fred-raio:12px}',
  'h1{color:var(--fred-cor-primaria)}',
  '</style></head><body><h1>Contabilidade</h1></body></html>',
].join('');

async function projetoComTokens() {
  nextReply = HTML_TOKENS;
  const r = await call('POST', '/api/design/projects', { outputType: 'web', prompt: 'landing com variáveis' });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

test('os controles são DERIVADOS do artefato, não uma lista fixa', { skip: needsDb }, async () => {
  const comTokens = await projetoComTokens();
  assert.deepEqual(comTokens.tokens.map(t => t.id), ['corPrimaria', 'corSecundaria', 'fonteBase', 'raio']);
  assert.equal(comTokens.tokens[0].defaultValue, '#1f3b8a');

  // Artefato que não segue o contrato: nenhum controle. A tela usa isso para
  // explicar o motivo, em vez de mostrar sliders que não fazem nada.
  const semTokens = await newProject();
  assert.deepEqual(semTokens.tokens, []);
});

test('o system prompt pede as variáveis nas saídas HTML e NÃO em slides', { skip: needsDb }, async () => {
  await newProject('document', 'proposta');
  assert.match(lastRequest.messages[0].content, /--fred-cor-primaria/);
  await newProject('slides', 'apresentação');
  assert.ok(!lastRequest.messages[0].content.includes('--fred-cor-primaria'));
});

test('salvar ajuste não chama a IA nem cria versão', { skip: needsDb }, async () => {
  const project = await projetoComTokens();
  const antes = lastRequest;

  const r = await call('PUT', `/api/design/projects/${project.id}/adjustments`, {
    adjustments: { corPrimaria: '#0a7d55', raio: 0 },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.adjustments, { corPrimaria: '#0a7d55', raio: 0 });
  assert.equal(r.json.currentVersion.versionNumber, 1, 'o ajuste não é uma versão nova');
  assert.equal(lastRequest, antes, 'nenhuma chamada ao provedor');
});

test('valor inválido é descartado em vez de virar CSS', { skip: needsDb }, async () => {
  const project = await projetoComTokens();
  const r = await call('PUT', `/api/design/projects/${project.id}/adjustments`, {
    adjustments: {
      corPrimaria: '#fff;background-image:url(http://x/y)',
      raio: 999,
      naoExiste: 'qualquer coisa',
    },
  });
  assert.equal(r.status, 200);
  // A cor com carga some; a medida fora da faixa é trazida para dentro dela.
  assert.deepEqual(r.json.adjustments, { raio: 32 });
});

test('o ajuste entra na prévia como sobreposição, sem tocar no artefato', { skip: needsDb }, async () => {
  const project = await projetoComTokens();
  await call('PUT', `/api/design/projects/${project.id}/adjustments`, { adjustments: { corPrimaria: '#0a7d55' } });

  const preview = await call('GET', `/api/design/projects/${project.id}/preview`);
  assert.match(preview.text, /--fred-cor-primaria: #0a7d55 !important/);
  // O valor original continua no documento: o ajuste é camada, não reescrita.
  assert.match(preview.text, /--fred-cor-primaria:#1f3b8a/);

  // E a versão guardada segue intacta — é ela que o modelo recebe ao editar.
  const detalhe = await call('GET', `/api/design/projects/${project.id}`);
  assert.equal(detalhe.json.currentVersion.content, HTML_TOKENS);
});

test('o que você vê é o que você baixa: o ajuste vai na exportação', { skip: needsDb }, async () => {
  const project = await projetoComTokens();
  await call('PUT', `/api/design/projects/${project.id}/adjustments`, { adjustments: { raio: 24 } });
  const exportado = await call('GET', `/api/design/projects/${project.id}/export?format=html`);
  assert.match(exportado.text, /--fred-raio: 24px !important/);
  // Mas o arquivo baixado NÃO leva a ponte de edição: é o design, não o editor.
  assert.ok(!exportado.text.includes('fred-preview-selecionado'));
  assert.ok(!exportado.text.includes('data-fred-alvo'));
});

test('ajustes sobrevivem a uma nova geração e a uma reversão', { skip: needsDb }, async () => {
  const project = await projetoComTokens();
  await call('PUT', `/api/design/projects/${project.id}/adjustments`, { adjustments: { corPrimaria: '#0a7d55' } });

  nextReply = HTML_TOKENS.replace('Contabilidade', 'Contabilidade II');
  const gerado = await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'v2' });
  assert.deepEqual(gerado.json.adjustments, { corPrimaria: '#0a7d55' }, 'o ajuste é do projeto, não da versão');

  const revertido = await call('POST', `/api/design/projects/${project.id}/revert`, { versionId: project.currentVersionId });
  assert.deepEqual(revertido.json.adjustments, { corPrimaria: '#0a7d55' });
});

test('ajuste em projeto de outra conta é 404', { skip: needsDb }, async () => {
  const project = await projetoComTokens();
  currentUser = USER_B;
  try {
    const r = await call('PUT', `/api/design/projects/${project.id}/adjustments`, { adjustments: { raio: 4 } });
    assert.equal(r.status, 404);
  } finally {
    currentUser = USER_A;
  }
});

test('slides: os controles vêm do deck que NÓS montamos', { skip: needsDb }, async () => {
  const project = await newProject('slides', 'apresentação');
  // O modelo devolve JSON, mas o HTML renderizado é nosso — e ele declara as
  // mesmas variáveis, então a apresentação também ganha sliders de cor.
  assert.ok(project.tokens.some(t => t.id === 'corPrimaria'));
  await call('PUT', `/api/design/projects/${project.id}/adjustments`, { adjustments: { corPrimaria: '#0a7d55' } });
  const preview = await call('GET', `/api/design/projects/${project.id}/preview`);
  assert.match(preview.text, /--fred-cor-primaria: #0a7d55 !important/);
});

// ---- v2: edição inline ------------------------------------------------------

test('a prévia carrega a ponte de seleção; a exportação, não', { skip: needsDb }, async () => {
  const project = await newProject();
  const preview = await call('GET', `/api/design/projects/${project.id}/preview`);
  assert.match(preview.text, /fred-preview-selecionado/, 'a ponte precisa estar na prévia');
  assert.match(preview.text, /data-fred-alvo/);

  const exportado = await call('GET', `/api/design/projects/${project.id}/export`);
  assert.equal(exportado.text, HTML, 'o arquivo baixado sai exatamente como o artefato');
});

test('o alvo clicado vira instrução de mexer SÓ nele', { skip: needsDb }, async () => {
  const project = await newProject();
  nextReply = HTML;
  await call('POST', `/api/design/projects/${project.id}/generate`, {
    prompt: 'deixe maior',
    target: { tag: 'h1', classes: 'hero', caminho: 'body > h1', texto: 'Contabilidade', html: '<h1 class="hero">Contabilidade</h1>' },
  });
  const enviado = lastRequest.messages.at(-1).content;
  assert.match(enviado, /ALVO/);
  assert.match(enviado, /<h1 class="hero">Contabilidade<\/h1>/);
  assert.match(enviado, /APENAS esse elemento/);
});

test('o histórico registra em QUE elemento a mudança foi pedida', { skip: needsDb }, async () => {
  const project = await newProject();
  nextReply = HTML;
  const r = await call('POST', `/api/design/projects/${project.id}/generate`, {
    prompt: 'deixe maior',
    target: { tag: 'h1', texto: 'Contabilidade', html: '<h1>Contabilidade</h1>' },
  });
  // Sem isso, "deixe maior" no histórico não diz maior o quê.
  const fala = r.json.messages.filter(m => m.role === 'user').at(-1);
  assert.match(fala.content, /deixe maior/);
  assert.match(fala.content, /<h1>/);
});

test('alvo sem nada que identifique é ignorado (vira edição normal)', { skip: needsDb }, async () => {
  const project = await newProject();
  nextReply = HTML;
  await call('POST', `/api/design/projects/${project.id}/generate`, { prompt: 'mude a cor', target: { classes: 'só isso' } });
  assert.ok(!lastRequest.messages.at(-1).content.includes('ALVO'));
});

test('slides: o alvo é o número do slide, sem o HTML do deck', { skip: needsDb }, async () => {
  const project = await newProject('slides', 'apresentação');
  nextReply = '{"slides":[{"layout":"title","title":"A","body":""}]}';
  await call('POST', `/api/design/projects/${project.id}/generate`, {
    prompt: 'troque o título',
    target: { tag: 'h2', slide: 2, texto: 'Escopo', html: '<h2>Escopo</h2>' },
  });
  const enviado = lastRequest.messages.at(-1).content;
  assert.match(enviado, /slide 2/);
  assert.match(enviado, /APENAS esse slide/);
  assert.ok(!enviado.includes('<h2>Escopo</h2>'), 'o HTML do deck confundiria o modelo, que devolve JSON');
});
