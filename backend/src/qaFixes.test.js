import assert from 'node:assert/strict';
import test from 'node:test';

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/frederico-qafixes-tests';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';

const { estimateTokens } = await import('./memory/indexer.js');
const { contextBudgetForModel, historyBudgetForModel } = await import('./memory/contextBuilder.js');
const { clipForBriefing, withoutSystemNotices, fileSignature, looksDegenerate } = await import('./agent.js');

// Freio de repetição: eco do prompt em loop dispara; texto normal não.
test('looksDegenerate detecta eco repetido e ignora texto normal', () => {
  const echo = 'Usuario Faça uma pesquisa ampla na internet sobre essa empresa traga todos os dados. '.repeat(60);
  assert.equal(looksDegenerate(echo), true);
  // texto longo, porém VARIADO (nenhum bloco exato de 80 chars repetido): não dispara
  let normal = '';
  for (let i = 0; i < 120; i++) normal += `Seção ${i}: análise ${i * 7 + 3} sobre o item ${(i * 13) % 97} com dados distintos e conclusão própria número ${i}. `;
  assert.ok(normal.length > 4000);
  assert.equal(looksDegenerate(normal), false);
  assert.equal(looksDegenerate('resposta curta e válida'), false);
});

// CL-01: contagem de tokens não pode SUBESTIMAR em alfabetos não-latinos.
// (o valor antigo era length/3.5; o novo é sempre >= a esse, e mais próximo do
// custo real de CJK/árabe/cirílico)
test('estimateTokens nunca fica abaixo do piso antigo (len/3.5)', () => {
  for (const s of ['relatório fiscal', '会計報告書には税額', 'التقرير الضريبي', 'финансовый отчёт', 'x'.repeat(500)]) {
    assert.ok(estimateTokens(s) >= Math.ceil(s.length / 3.5), `subestimou: ${s}`);
  }
});

test('estimateTokens cobra bem mais por texto CJK do que o fator plano latino', () => {
  const cjk = '会計報告書には四半期に計算された税額が記載されています';
  // len/3.5 subestimava ~3x; o novo estima perto de 1 token/char para CJK
  assert.ok(estimateTokens(cjk) >= cjk.length, 'CJK deveria custar ~>= 1 token por caractere');
});

test('estimateTokens é idêntico ao comportamento antigo para ASCII puro', () => {
  const s = 'the quick brown fox jumps over the lazy dog 1234567890';
  assert.equal(estimateTokens(s), Math.ceil(s.length / 3.5));
});

// CL-02: um modelo grande com sufixo ":free" NÃO pode ser rebaixado ao teto leve
test('modelo :free de janela grande mantém orçamento grande (não cai para 18k)', () => {
  const settings = { memory_enabled: true, context_target_tokens: 100000 };
  const freeBig = contextBudgetForModel('anthropic/claude-3.5-sonnet:free', settings);
  const paidBig = contextBudgetForModel('anthropic/claude-3.5-sonnet', settings);
  assert.equal(freeBig, paidBig, 'o sufixo :free não deve mudar o tamanho da janela');
  assert.ok(freeBig > 18000, `esperado > 18000, veio ${freeBig}`);
});

test('modelo pequeno (8b) continua no tier leve mesmo sendo :free', () => {
  const settings = { memory_enabled: true, context_target_tokens: 100000 };
  assert.equal(contextBudgetForModel('meta-llama/llama-3.1-8b-instruct:free', settings), 18000);
});

test('historyBudgetForModel acompanha o tier grande do modelo free', () => {
  assert.ok(historyBudgetForModel('anthropic/claude-3.5-sonnet:free', 120000) >
            historyBudgetForModel('meta-llama/llama-3.1-8b-instruct:free', 18000));
});

// MM-02: o corte do briefing deixa marca visível (não é mais silencioso)
test('clipForBriefing marca o corte quando excede o limite', () => {
  assert.equal(clipForBriefing('curto', 100), 'curto');
  const long = clipForBriefing('a'.repeat(200), 50);
  assert.ok(long.length < 200 && /truncado/.test(long), 'deveria truncar e sinalizar');
});

// EC-01: a assinatura distingue regeneração de mesmo nome pelo tamanho
test('fileSignature muda quando o tamanho muda, mesmo com mtime igual', () => {
  assert.notEqual(
    fileSignature({ mtimeMs: 1000, size: 10 }),
    fileSignature({ mtimeMs: 1000, size: 20 })
  );
  assert.equal(fileSignature({ mtimeMs: 1000, size: 10 }), '1000:10');
});

// EC-02: avisos de sistema não vão para dentro do arquivo materializado
test('withoutSystemNotices remove o aviso de arquivo ausente', () => {
  const body = 'Relatório concluído.';
  const withNotice = body + '\n\n**O arquivo não foi gerado nesta tentativa.** Nenhum download foi criado. Use **Reenviar** para tentar novamente; se o problema persistir, escolha outro modelo marcado com **Ferramentas**.';
  assert.equal(withoutSystemNotices(withNotice), body);
});

// DOC-KIT: o assistente "Documentos profissionais" ensina os TRÊS kits de
// design (Word/Excel/PDF), não só o docpro. Sem isso o modelo importa o
// xlspro mas escreve a tabela com openpyxl cru (sem cabeçalho colorido/zebra).
test('DOCPRO_PROMPT ensina docpro, xlspro e pdfpro', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const m = src.match(/const DOCPRO_PROMPT = `([\s\S]*?)`;/);
  assert.ok(m, 'DOCPRO_PROMPT deveria existir');
  const prompt = m[1];
  assert.match(prompt, /from docpro import Relatorio/, 'deve ensinar o kit Word');
  assert.match(prompt, /from xlspro import Planilha/, 'deve ensinar o kit Excel');
  assert.match(prompt, /from pdfpro import RelatorioPDF/, 'deve ensinar o kit PDF');
  assert.match(prompt, /p\.tabela\(/, 'deve mostrar p.tabela para Excel estilizado');
  assert.match(prompt, /openpyxl cru/i, 'deve proibir estilizar célula na mão');
  assert.match(prompt, /FÓRMULAS DO EXCEL/i, 'deve ter regra de fórmulas corretas');
});
