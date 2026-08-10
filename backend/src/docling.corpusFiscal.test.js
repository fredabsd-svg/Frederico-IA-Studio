// F-18: o corpus documental atravessando o pipeline do Docling.
//
// O `docling.corpus.test.js` cobre o PRIMEIRO CONTATO do arquivo (magic bytes,
// roteamento por extensão). O `docling/pipeline.test.js` cobre o MECANISMO
// (otimização, chunking, tabelas) com Markdown de brinquedo. O que faltava — e
// era o que a auditoria duvidava — é o meio-termo: documentos com a FORMA dos
// que este produto recebe todo dia. DRE com célula mesclada, certidão da PGFN
// com cabeçalho em toda página, nota fiscal escaneada com ruído de OCR, razão
// analítico cuja tabela atravessa a quebra de página.
//
// LIMITE DECLARADO: o `docling` de verdade (a extração por ML) NÃO roda aqui
// nem no CI — depende do serviço e dos modelos. O corpus abaixo é a SAÍDA do
// serviço, no formato em que ele entrega, e o que se prova é o que o produto
// faz com ela. A qualidade da extração em si continua sem cobertura, e está
// dito assim em `docs/AUDITORIA_2026-07.md` §2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeMarkdown } from './docling/markdown.js';
import { chunkMarkdown } from './docling/chunker.js';
import { summarizeTables, parseMarkdownTable, validateTable, tableToCsv, findTables, extractTableBlocks } from './docling/tables.js';
import { selectChunks } from './docling/context.js';

// A mesma cadeia que o service.js roda em produção.
function pipeline(raw, { maxChunkTokens = 1200, documentId = 'doc' } = {}) {
  const { markdown, report } = optimizeMarkdown(raw);
  const chunks = chunkMarkdown(markdown, { maxChunkTokens, documentId });
  return { markdown, report, chunks, tables: summarizeTables(chunks) };
}

// ---------------------------------------------------------------------------
// DRE — o caso das CÉLULAS MESCLADAS e dos números em pt-BR
// ---------------------------------------------------------------------------

// Numa DRE, a linha de grupo ("RECEITA OPERACIONAL BRUTA") é uma célula
// mesclada: o Docling a entrega com as demais colunas VAZIAS.
const DRE = `<!-- page: 1 -->
## Demonstração do Resultado do Exercício
Valores expressos em reais, conforme escrituração contábil.

| Conta | 2024 | 2025 |
| --- | --- | --- |
| RECEITA OPERACIONAL BRUTA |  |  |
| Vendas de mercadorias | 1.250.000,00 | 1.480.500,00 |
| (-) Deduções e impostos | (312.500,00) | (370.125,00) |
| RECEITA LÍQUIDA | 937.500,00 | 1.110.375,00 |
| Resultado do exercício | (45.230,18) | 88.940,72 |
`;

test('DRE: célula mesclada vira coluna vazia e a tabela continua coerente', () => {
  const t = parseMarkdownTable(DRE);
  const v = validateTable(t);
  assert.equal(v.colCount, 3);
  assert.ok(v.ok, `a DRE não deveria ter alerta: ${v.issues.join(', ')}`);
  // A linha de grupo existe, com as colunas vazias — não foi descartada.
  assert.deepEqual(t.rows[0], ['RECEITA OPERACIONAL BRUTA', '', '']);
});

test('DRE: o CSV escapa o número em pt-BR em vez de partir a coluna', () => {
  // O risco é concreto: a vírgula do decimal brasileiro é o separador do CSV.
  // Sem aspas, "1.250.000,00" viraria DUAS colunas e a planilha exportada
  // mentiria — com números que existem, no lugar errado.
  const csv = tableToCsv(parseMarkdownTable(DRE));
  const linhaVendas = csv.split('\r\n').find(l => l.startsWith('Vendas'));
  assert.equal(linhaVendas, 'Vendas de mercadorias,"1.250.000,00","1.480.500,00"');
  assert.equal(csv.split('\r\n')[0], 'Conta,2024,2025');
});

test('DRE: negativo entre parênteses chega intacto (o pipeline não reinterpreta número)', () => {
  const csv = tableToCsv(parseMarkdownTable(DRE));
  assert.match(csv, /\(45\.230,18\)/);
  assert.match(csv, /\(312\.500,00\)/);
});

test('DRE: linha com menos colunas é SINALIZADA, não completada em silêncio', () => {
  // É como sai uma célula mesclada que o extrator não conseguiu alinhar.
  // Preencher o buraco caladamente produziria um demonstrativo plausível e
  // errado — o pior desfecho possível para um documento contábil.
  const quebrada = DRE.replace('| RECEITA OPERACIONAL BRUTA |  |  |', '| RECEITA OPERACIONAL BRUTA |');
  const v = validateTable(parseMarkdownTable(quebrada));
  assert.equal(v.ok, false);
  assert.ok(v.issues.some(i => i.startsWith('colunas_inconsistentes')), v.issues.join(', '));
});

// A DRE acima tem uma LINHA EM BRANCO entre a frase e a tabela. Sem ela, o
// chunker mantém prosa e tabela no mesmo bloco (`mixed`) — e é aí que morava
// o defeito. Um documento real tem as duas formas, e o Docling não garante
// qual: depende de como o extrator viu o espaçamento na página.
const DRE_COLADA = DRE.replace('contábil.\n\n|', 'contábil.\n|');

test('DRE: a linha em branco antes da tabela decide como ela é agrupada', () => {
  // Fixa o fato que torna o teste seguinte necessário. Se um dia o chunker
  // passar a separar sempre, este teste avisa — e aí o outro vira redundante
  // em vez de silenciosamente inútil.
  assert.ok(pipeline(DRE).chunks.some(c => c.type === 'table'),
    'com linha em branco, a tabela vira um chunk próprio');
  assert.ok(pipeline(DRE_COLADA).chunks.every(c => c.type !== 'table'),
    'colada à frase, ela fica dentro de um chunk misto');
});

test('DRE: tabela embutida em chunk misto NÃO escapa da validação (regressão)', () => {
  // Defeito encontrado por este corpus. Com a tabela colada à frase, o resumo
  // devolvia `count: 0, withWarnings: 0` — que se lê como "nenhuma tabela com
  // problema" quando o correto era "não procurei". Pior: a tabela também não
  // aparecia na listagem da rota nem podia ser baixada em CSV.
  const quebrada = DRE_COLADA.replace('| RECEITA OPERACIONAL BRUTA |  |  |', '| RECEITA OPERACIONAL BRUTA |');
  const out = pipeline(quebrada);
  assert.equal(out.chunks.every(c => c.type !== 'table'), true, 'o cenário exige um chunk misto');
  assert.equal(out.tables.count, 1, 'a tabela embutida precisa ser encontrada');
  assert.equal(out.tables.withWarnings, 1, 'e o alerta dela precisa aparecer');
  assert.equal(out.tables.details[0].embedded, true);
});

// ---------------------------------------------------------------------------
// Certidão da PGFN — cabeçalho em toda página e um código que não pode sumir
// ---------------------------------------------------------------------------

const CABECALHO = 'MINISTÉRIO DA FAZENDA\nProcuradoria-Geral da Fazenda Nacional';
const RODAPE = 'Emitida às 09:14:02 do dia 15/01/2026';
const PGFN = `<!-- page: 1 -->
${CABECALHO}
## CERTIDÃO NEGATIVA DE DÉBITOS
ALFA COMERCIO LTDA, CNPJ 11.222.333/0001-44, não possui pendências.
Código de controle da certidão: A1B2.C3D4.E5F6.7890
${RODAPE}
<!-- page: 2 -->
${CABECALHO}
Validade: 15/07/2026
${RODAPE}
<!-- page: 3 -->
${CABECALHO}
Qualquer rasura torna o documento inválido.
${RODAPE}`;

test('PGFN: o cabeçalho repetido sai e o código de controle ÚNICO fica', () => {
  // Este é o teste que importa na certidão. O código aparece uma vez só, no
  // meio de duas páginas de texto repetido: é exatamente o que um removedor
  // de ruído desatento levaria junto — e é o único dado pelo qual a certidão
  // pode ser conferida no site da PGFN.
  const out = pipeline(PGFN);
  assert.ok(!out.markdown.includes('MINISTÉRIO DA FAZENDA'), 'cabeçalho repetido deveria sair');
  assert.ok(!out.markdown.includes('Emitida às 09:14:02'), 'rodapé repetido deveria sair');
  assert.match(out.markdown, /A1B2\.C3D4\.E5F6\.7890/);
  assert.match(out.markdown, /11\.222\.333\/0001-44/);
  assert.match(out.markdown, /15\/07\/2026/);
  assert.ok(out.report.removedHeaderFooterLines > 0);
});

test('PGFN de DUAS páginas: nada é removido, de propósito', () => {
  // `detectRunningHeadFoot` exige 3 páginas. Com duas, "aparece nas duas" não
  // distingue cabeçalho de conteúdo — e apagar conteúdo de uma certidão é bem
  // pior que deixar uma linha repetida. O teste fixa a escolha para que uma
  // "otimização" futura não a desfaça sem perceber.
  const duas = PGFN.split('<!-- page: 3 -->')[0];
  const out = pipeline(duas);
  assert.equal(out.report.removedHeaderFooterLines, 0);
  assert.ok(out.markdown.includes('MINISTÉRIO DA FAZENDA'));
});

test('PGFN: cada trecho sabe de que página veio', () => {
  // Sem isso a IA não pode dizer "a validade está na página 2", que é a
  // promessa de rastreabilidade da camada documental.
  const out = pipeline(PGFN);
  const validade = out.chunks.find(c => c.content.includes('15/07/2026'));
  assert.ok(validade, 'a validade precisa estar em algum trecho');
  assert.equal(validade.page, 2);
  assert.match(validade.source_reference, /^page_2_/);
});

// ---------------------------------------------------------------------------
// Nota fiscal ESCANEADA — ruído de OCR
// ---------------------------------------------------------------------------

const NF_ESCANEADA = `<!-- page: 1 -->
## NOTA FISCAL ELETRONICA
Emitente: INDUSTRIA MECAN1CA BETA S.A.
Endereco: Rua das Palmeiras, 1O5 - Sao Pau1o/SP
Descricao dos produtos e servi-
cos prestados no periodo de referencia.

| Item | Qtd | Unitario |
| --- | --- | --- |
| Parafuso M8 | 1.200 | 0,45 |
| Arruela lisa | 3.500 | 0,12 |
`;

test('NF escaneada: o pipeline não "conserta" o texto do OCR', () => {
  // Tentador e errado. O "1" no lugar do "I" em MECAN1CA e a palavra quebrada
  // por hifenização são o que o OCR leu; corrigir por conta própria seria
  // inventar conteúdo que não está no documento. Quem decide é o modelo, com
  // o texto à vista.
  const out = pipeline(NF_ESCANEADA);
  assert.match(out.markdown, /MECAN1CA/);
  assert.match(out.markdown, /Pau1o\/SP/);
  assert.match(out.markdown, /servi-\ncos/);
});

test('NF escaneada: página única não perde nada como se fosse cabeçalho', () => {
  const out = pipeline(NF_ESCANEADA);
  assert.equal(out.report.keptPages, 1);
  assert.equal(out.report.removedHeaderFooterLines, 0);
});

test('NF escaneada: a tabela de itens é achada mesmo dividindo seção com o texto', () => {
  const out = pipeline(NF_ESCANEADA);
  assert.equal(out.tables.count, 1);
  assert.equal(out.tables.details[0].cols, 3);
  assert.ok(out.tables.details[0].ok, out.tables.details[0].issues.join(', '));
});

test('NF escaneada: pergunta em português encontra o trecho da tabela', () => {
  const out = pipeline(NF_ESCANEADA);
  const sel = selectChunks(out.chunks, 'qual o valor unitario do parafuso', 500);
  assert.ok(sel.length > 0, 'a seleção não pode voltar vazia');
  assert.ok(sel.some(c => c.content.includes('Parafuso M8')));
});

// ---------------------------------------------------------------------------
// Razão analítico — tabela que ATRAVESSA a quebra de página
// ---------------------------------------------------------------------------

const RAZAO = `<!-- page: 1 -->
## Razão Analítico
| Data | Histórico | Valor |
| --- | --- | --- |
| 01/03 | Venda NF 100 | 1.000,00 |
| 02/03 | Venda NF 101 | 2.000,00 |
<!-- page: 2 -->
| Data | Histórico | Valor |
| --- | --- | --- |
| 03/03 | Venda NF 102 | 3.000,00 |`;

test('Razão: a continuação na página seguinte não é perdida', () => {
  // O Docling reabre o cabeçalho da tabela na página nova. O risco é a
  // continuação virar órfã e sumir — o lançamento de 3.000,00 simplesmente
  // não chegaria à IA, e ninguém notaria a ausência.
  const out = pipeline(RAZAO);
  assert.ok(out.chunks.some(c => c.content.includes('3.000,00')), 'a continuação sumiu');
  assert.equal(out.tables.count, 2, 'cada parte é uma tabela rastreável');
});

test('Razão: cada parte da tabela aponta para a SUA página', () => {
  const out = pipeline(RAZAO);
  assert.deepEqual(out.tables.details.map(d => d.page), [1, 2]);
});

// ---------------------------------------------------------------------------
// A costura entre LISTAR e EXPORTAR — as duas rotas têm de falar da mesma tabela
// ---------------------------------------------------------------------------

test('listagem e exportação usam a mesma numeração', () => {
  // Antes cada rota filtrava os chunks por conta própria. Duas listas
  // derivadas em lugares diferentes acabam discordando, e o usuário baixa a
  // tabela errada acreditando ter baixado a que viu na tela. Agora as duas
  // chamam `findTables`; este teste cobra que os índices batam com o que a
  // listagem publica.
  const out = pipeline(RAZAO);
  const porIndice = findTables(out.chunks);
  assert.deepEqual(porIndice.map(t => t.index), out.tables.details.map(d => d.index));
  for (const d of out.tables.details) {
    const alvo = porIndice.find(t => t.index === d.index);
    assert.equal(alvo.chunk.source_reference, d.source_reference);
  }
});

test('o CSV exportado pelo índice é o da tabela daquele índice', () => {
  const out = pipeline(RAZAO);
  const segunda = findTables(out.chunks).find(t => t.index === 2);
  const csv = tableToCsv(segunda.content);
  assert.match(csv, /3\.000,00/);
  assert.ok(!csv.includes('1.000,00'), 'não pode misturar a página 1 na tabela 2');
});

test('extractTableBlocks ignora pipe solto, que é ruído e não tabela', () => {
  // Uma linha isolada com pipes aparece em OCR de documento com bordas.
  // Tratá-la como tabela encheria a listagem de tabelas de uma linha só.
  assert.deepEqual(extractTableBlocks('texto\n| separador visual |\noutro texto'), []);
  assert.equal(extractTableBlocks('| a | b |\n| 1 | 2 |').length, 1);
});

test('Razão: nenhuma parte da tabela é cortada no meio de uma linha', () => {
  // Chunk de tabela tem de conter linhas inteiras: meia linha vira número
  // sem rótulo, que é pior que dado nenhum.
  const out = pipeline(RAZAO, { maxChunkTokens: 40 });
  for (const c of out.chunks.filter(c => c.content.includes('|'))) {
    for (const linha of c.content.split('\n').filter(l => l.includes('|'))) {
      assert.match(linha.trim(), /^\|.*\|$/, `linha cortada: ${linha}`);
    }
  }
});
