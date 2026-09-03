// Trava o prompt do assistente "Documentos profissionais" contra a API REAL dos
// kits (`sandbox/kits.py`, `docpro.py`, `xlspro.py`, `pdfpro.py`).
//
// O defeito que este arquivo fecha é concreto: o prompt ensinava
// `assinaturas(cargos=)` no Word e `subtitulos=` no PDF, `citacao(fonte=)` num
// e `autor=` no outro, `sumario(entradas)` num e `sumario()` sem argumento no
// outro. O modelo então chamava o parâmetro errado, o `run_python` estourava e
// a conversa gastava uma rodada inteira consertando o que o prompt havia
// ensinado errado. Um prompt que documenta uma API inventada é pior que um
// prompt curto.
//
// A API sai do `ast` do Python (backend/scripts/api-dos-kits.py), não de um
// `import`: assim o teste roda neste job — que é Node puro e não tem
// python-docx, openpyxl nem reportlab — em vez de se auto-pular.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(aqui, '..', 'scripts', 'api-dos-kits.py');

function apiDosKits() {
  for (const python of ['python3', 'python']) {
    try {
      return JSON.parse(execFileSync(python, [script], { encoding: 'utf8' }));
    } catch (erro) {
      if (erro?.code !== 'ENOENT') throw erro;
    }
  }
  throw new Error('python3 não encontrado — a extração da API dos kits não pôde rodar');
}

// Qual classe está por trás de cada receptor usado nos exemplos do prompt.
const RECEPTOR = {
  r: 'Relatorio',       // Word
  a: 'Sobrio',          // Word registrável
  p: 'Planilha',        // Excel
  q: 'RelatorioPDF',    // PDF
  fmt: '_Fmt'           // formatação pt-BR de kits.py
};

// A seção de kits saiu do perfil do assistente de documentos e virou parte da
// BASE (v4.2): é ela que este arquivo trava contra o código.
async function prompt() {
  const { DOCUMENTOS_PROFISSIONAIS } = await import('./agent/systemPromptV4.js');
  return DOCUMENTOS_PROFISSIONAIS;
}

test('todo método citado no prompt existe de fato nos kits', async () => {
  const api = apiDosKits();
  const texto = await prompt();
  const chamadas = new Map();
  for (const m of texto.matchAll(/\b(r|a|p|q|fmt)\.([a-z_][a-z0-9_]*)\s*\(/g)) {
    if (!chamadas.has(m[1])) chamadas.set(m[1], new Set());
    chamadas.get(m[1]).add(m[2]);
  }
  assert.ok(chamadas.size >= 4, 'o prompt deveria exemplificar os quatro kits');

  const inexistentes = [];
  for (const [receptor, metodos] of chamadas) {
    const classe = RECEPTOR[receptor];
    const disponiveis = new Set(api.classes[classe] || []);
    for (const metodo of metodos) {
      if (!disponiveis.has(metodo)) inexistentes.push(`${classe}.${metodo}`);
    }
  }
  assert.deepEqual(inexistentes, [],
    'o prompt ensina método que não existe no kit — corrija o prompt ou o kit');
});

test('os parâmetros nomeados do prompt existem nas assinaturas dos kits', async () => {
  const api = apiDosKits();
  const texto = await prompt();
  // Só as linhas de código do prompt: a prosa também usa "palavra=" em exemplos
  // entre crases, e casar nela produziria falso positivo.
  // Uma linha do prompt encadeia várias chamadas com ";" — cada trecho é
  // avaliado contra a SUA assinatura, senão o `ordenada=` de `r.lista(...)`
  // seria cobrado do `r.paragrafo(...)` que veio antes na mesma linha.
  const linhas = texto.split('\n')
    .filter((l) => /^\s*(r|a|p|q|fmt)\./.test(l))
    .flatMap((l) => l.split(';'));
  const desconhecidos = [];
  for (const linha of linhas) {
    const chamada = linha.match(/\b(r|a|p|q|fmt)\.([a-z_][a-z0-9_]*)\s*\(/);
    if (!chamada) continue;
    const assinatura = api.assinaturas[`${RECEPTOR[chamada[1]]}.${chamada[2]}`];
    if (!assinatura) continue;
    for (const nomeado of linha.matchAll(/([a-z_][a-z0-9_]*)=/g)) {
      const nome = nomeado[1];
      // "moeda=[...]" dentro de um dicionário de outra chamada da mesma linha
      // seria ruído; por isso só cobramos o que a assinatura NÃO tem quando o
      // nome parece um parâmetro do kit (aparece em alguma assinatura).
      const conhecido = Object.values(api.assinaturas).some((args) => args.includes(nome));
      if (conhecido && !assinatura.includes(nome)) {
        desconhecidos.push(`${RECEPTOR[chamada[1]]}.${chamada[2]}(${nome}=)`);
      }
    }
  }
  assert.deepEqual([...new Set(desconhecidos)], [],
    'o prompt usa parâmetro que a assinatura do kit não aceita');
});

test('os quatro kits usam os MESMOS nomes de parâmetro', async () => {
  const api = apiDosKits();
  // Foi a divergência que mais custou rodada: `cargos=` num kit e `subtitulos=`
  // no outro para a mesma coisa, `fonte=` num e `autor=` no outro.
  for (const alvo of ['Relatorio.assinaturas', 'Sobrio.assinaturas',
    'RelatorioPDF.assinaturas']) {
    assert.ok(api.assinaturas[alvo].includes('cargos'),
      `${alvo} deveria aceitar cargos=`);
    assert.ok(api.assinaturas[alvo].includes('subtitulos'),
      `${alvo} deveria continuar aceitando subtitulos= como alias`);
  }
  for (const alvo of ['Relatorio.citacao', 'RelatorioPDF.citacao']) {
    assert.ok(api.assinaturas[alvo].includes('fonte'), `${alvo} deveria aceitar fonte=`);
  }
  assert.ok(api.assinaturas['RelatorioPDF.citacao'].includes('autor'),
    'o PDF deveria continuar aceitando autor= como alias');
  for (const alvo of ['Relatorio.tabela', 'Planilha.tabela', 'RelatorioPDF.tabela']) {
    for (const tipo of ['moeda', 'pct', 'milhar', 'data', 'total']) {
      assert.ok(api.assinaturas[alvo].includes(tipo),
        `${alvo} deveria aceitar ${tipo}=`);
    }
  }
});

test('o prompt não ensina mais a API que a v2 aposentou', async () => {
  const texto = await prompt();
  // `sumario([(título, página)])` é a origem do índice que apontava a página
  // errada: o modelo informava o número. Na v2 o kit descobre a página real.
  assert.doesNotMatch(texto, /sumario\(\[/, 'o sumário não recebe mais páginas à mão');
  assert.doesNotMatch(texto, /subtitulos=/, 'use cargos= (subtitulos= é só alias)');
  assert.doesNotMatch(texto, /citacao\([^)\n]*autor=/, 'use fonte= (autor= é só alias)');
  assert.doesNotMatch(texto, /Source (Serif|Sans)/,
    'a tipografia padrão passou a ser Cambria/Calibri, que o cliente TEM');
});

test('o prompt cabe no orçamento de contexto', async () => {
  const texto = await prompt();
  // Catraca contra crescimento silencioso: a seção de documentos é a maior do
  // sistema e cresce a cada bloco novo.
  assert.ok(texto.length < 14000,
    `a seção de documentos está com ${texto.length} caracteres`);
});

// A seção só compensa para quem pode EXECUTAR: são ~11 mil caracteres de API de
// kit, e um assistente sem run_python não gera arquivo nenhum. O reverso também
// importa — antes ela só existia no assistente "Documentos profissionais", então
// um assistente personalizado com execução diagramava .docx na mão.
test('a seção de documentos entra com run_python e só com ele', async () => {
  const { promptFor } = await import('./agent/prompts.js');
  assert.match(promptFor(null), /DOCUMENTOS PROFISSIONAIS/);
  assert.doesNotMatch(promptFor({ tools: ['consultar_cnpj'] }), /DOCUMENTOS PROFISSIONAIS/);
});
