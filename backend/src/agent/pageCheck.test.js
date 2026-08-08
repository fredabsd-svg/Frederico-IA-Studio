// Validação por navegador (Fase 38): a política de requisição, a checagem de
// caminho e — o que mais importa — o VEREDITO, que é onde mora a decisão de
// produto. O navegador em si é best-effort e não roda aqui (nem na suíte do
// CI sem Chromium); o teste do caminho sem navegador cobre esse contrato.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowPreviewRequest, previewUrlFor, validatePagePath, buildVerdict, checkPage
} from './pageCheck.js';

const ORIGIN = 'http://127.0.0.1:45123';

// ── política de requisição ──────────────────────────────────────────────────

test('só a origem fixada passa — o navegador da validação é offline', () => {
  assert.equal(allowPreviewRequest(`${ORIGIN}/site/index.html`, ORIGIN), true);
  assert.equal(allowPreviewRequest(`${ORIGIN}/assets/app.css?v=2`, ORIGIN), true);

  assert.equal(allowPreviewRequest('https://cdn.exemplo.com/react.js', ORIGIN), false);
  // Outra porta do loopback é a que mais importa recusar: é onde mora a API do
  // próprio backend.
  assert.equal(allowPreviewRequest('http://127.0.0.1:3000/api/conversations', ORIGIN), false);
  assert.equal(allowPreviewRequest('http://localhost:45123/site/index.html', ORIGIN), false);
  assert.equal(allowPreviewRequest('http://169.254.169.254/latest/meta-data/', ORIGIN), false);
  assert.equal(allowPreviewRequest('file:///etc/passwd', ORIGIN), false);
  assert.equal(allowPreviewRequest('não é url', ORIGIN), false);
  assert.equal(allowPreviewRequest(`${ORIGIN}/x`, ''), false, 'sem origem fixada nada passa');
});

test('previewUrlFor codifica cada segmento sem comer as barras', () => {
  assert.equal(previewUrlFor(ORIGIN, 'site/index.html'), `${ORIGIN}/site/index.html`);
  assert.equal(previewUrlFor(ORIGIN, '/repo/meu site/página.html'), `${ORIGIN}/repo/meu%20site/p%C3%A1gina.html`);
});

test('validatePagePath recusa absoluto, travessia e o que não é página', () => {
  assert.equal(validatePagePath('repo/site/dist/index.html').path, 'repo/site/dist/index.html');
  assert.match(validatePagePath('/etc/passwd').error, /não absoluto/);
  assert.match(validatePagePath('../fora/index.html').error, /".."/);
  assert.match(validatePagePath('outputs/relatorio.pdf').error, /não parece uma/);
  assert.match(validatePagePath('').error, /Informe o caminho/);
});

// ── veredito ────────────────────────────────────────────────────────────────

const SADIA = { status: 200, visibleTextLength: 120, visualElements: 2, elementCount: 40 };

test('página sadia passa, sem inventar problema', () => {
  const v = buildVerdict(SADIA, []);
  assert.equal(v.ok, true);
  assert.deepEqual(v.problemas, []);
  assert.match(v.resumo, /carregou sem erro/);
});

// O modo de falha que motivou a fase inteira.
test('página em branco é reprovada, e a evidência é a medida', () => {
  const v = buildVerdict({ status: 200, visibleTextLength: 0, visualElements: 0, elementCount: 3 }, []);
  assert.equal(v.ok, false);
  assert.ok(v.problemas.some(p => /EM BRANCO/.test(p)));
});

test('página só de imagem NÃO é confundida com página em branco', () => {
  const v = buildVerdict({ status: 200, visibleTextLength: 0, visualElements: 1, elementCount: 5 }, []);
  assert.equal(v.ok, true);
});

test('erro de console e erro não tratado reprovam', () => {
  const v = buildVerdict({
    ...SADIA,
    consoleErrors: ['Failed to load module script'],
    pageErrors: ["TypeError: Cannot read properties of undefined (reading 'map')"]
  }, []);
  assert.equal(v.ok, false);
  assert.ok(v.problemas.some(p => /Erro no console/.test(p)));
  assert.ok(v.problemas.some(p => /não tratado/.test(p)));
});

test('recurso LOCAL faltando é problema; recurso EXTERNO bloqueado é só aviso', () => {
  const v = buildVerdict({
    ...SADIA,
    badResponses: [{ url: `${ORIGIN}/assets/app.css`, status: 404 }],
    blockedRequests: ['https://cdn.exemplo.com/fonte.woff2']
  }, []);
  assert.equal(v.ok, false);
  assert.ok(v.problemas.some(p => /não encontrado \(404\)/.test(p)));
  // A distinção é deliberada: chamar a CDN bloqueada de falha ensinaria o
  // agente a ignorar o veredito.
  assert.equal(v.avisos.length, 1);
  assert.ok(v.avisos[0].includes('offline'));
});

test('só aviso NÃO reprova, mas aparece no resumo', () => {
  const v = buildVerdict({ ...SADIA, blockedRequests: ['https://cdn.exemplo.com/a.js'] }, []);
  assert.equal(v.ok, true);
  assert.match(v.resumo, /1 aviso/);
});

test('falha de navegação reprova e não acusa tela em branco por tabela', () => {
  const v = buildVerdict({ navigationError: 'Timeout 15000ms exceeded', visibleTextLength: 0, visualElements: 0 }, []);
  assert.equal(v.ok, false);
  assert.ok(v.problemas.some(p => /não carregou/.test(p)));
  // Sem navegação não há o que medir: acusar "em branco" seria um segundo
  // problema inventado a partir do mesmo fato.
  assert.equal(v.problemas.filter(p => /EM BRANCO/.test(p)).length, 0);
});

test('status de erro na própria página reprova', () => {
  const v = buildVerdict({ ...SADIA, status: 404 }, []);
  assert.equal(v.ok, false);
  assert.ok(v.problemas.some(p => /respondeu 404/.test(p)));
});

test('asserção do agente que não se cumpriu reprova e viaja no resultado', () => {
  const v = buildVerdict(SADIA, [
    { tipo: 'seletor', valor: '#app', ok: true, descricao: 'o seletor "#app" existe na página' },
    { tipo: 'texto', valor: 'Bem-vindo', ok: false, detalhe: 'O texto "Bem-vindo" não aparece na página renderizada.' }
  ]);
  assert.equal(v.ok, false);
  assert.equal(v.assercoes.length, 2);
  assert.ok(v.problemas.some(p => /Bem-vindo/.test(p)));
});

// ── contrato sem navegador ──────────────────────────────────────────────────

test('sem Chromium a validação NÃO mente: devolve disponivel:false com o motivo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-pagecheck-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>oi</h1>');
  const result = await checkPage(root, 'index.html');
  // Este ambiente não tem CHROMIUM_PATH; o caminho exercitado é justamente o
  // que impede um "validado" falso.
  assert.equal(result.disponivel, false);
  assert.match(result.observacao, /NÃO foi feita/);
  assert.equal(result.ok, undefined, 'sem navegador não existe veredito');
  fs.rmSync(root, { recursive: true, force: true });
});

test('caminho inválido é recusado antes de qualquer navegador', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-pagecheck-'));
  const result = await checkPage(root, '../fora.html');
  assert.match(result.erro, /".."/);
  assert.equal(result.disponivel, true, 'a recusa é do caminho, não do ambiente');
  fs.rmSync(root, { recursive: true, force: true });
});

test('página inexistente é dita como tal, não como falha de navegador', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-pagecheck-'));
  const result = await checkPage(root, 'nao-existe.html');
  assert.match(result.erro, /não existe no workspace/);
  fs.rmSync(root, { recursive: true, force: true });
});
