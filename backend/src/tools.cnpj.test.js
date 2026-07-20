import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-cnpj-tests';
// Desliga o cache de ferramentas: estes casos reusam o MESMO CNPJ com respostas
// mockadas diferentes, então o cache mascararia o comportamento sob teste.
process.env.TOOL_CACHE = '0';

const { consultarCnpj, normalizeCnpj } = await import('./tools.js');

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: () => 'application/json' }
});

test('normalizeCnpj mantém apenas dígitos', () => {
  assert.equal(normalizeCnpj('00.000.000/0001-91'), '00000000000191');
  assert.equal(normalizeCnpj(' 11 222 333/4444-55 '), '11222333444455');
});

test('rejeita CNPJ que não tem 14 dígitos', async () => {
  const r = await consultarCnpj('123');
  assert.equal(r.code, 'CNPJ_INVALIDO');
  assert.equal(r.recoverable, true);
});

test('usa a BrasilAPI e devolve os campos normalizados', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /brasilapi\.com\.br\/api\/cnpj\/v1\/00000000000191/);
      return jsonResponse(200, {
        cnpj: '00000000000191',
        razao_social: 'BANCO DO BRASIL SA',
        nome_fantasia: 'DIRECAO GERAL',
        descricao_situacao_cadastral: 'ATIVA',
        cnae_fiscal: 6422100,
        cnae_fiscal_descricao: 'Bancos múltiplos, com carteira comercial',
        cnaes_secundarios: [{ codigo: 6499999, descricao: 'Outras atividades' }],
        municipio: 'BRASILIA', uf: 'DF', logradouro: 'SAUN QUADRA 5', numero: 'S/N', cep: '70040912',
        opcao_pelo_simples: false, opcao_pelo_mei: false,
        qsa: [{ nome_socio: 'FULANO DE TAL', qualificacao_socio: 'Diretor' }]
      });
    };
    const r = await consultarCnpj('00.000.000/0001-91');
    assert.equal(r.fonte, 'BrasilAPI');
    assert.equal(r.razao_social, 'BANCO DO BRASIL SA');
    assert.equal(r.situacao_cadastral, 'ATIVA');
    assert.equal(r.cnae_principal, '6422100 - Bancos múltiplos, com carteira comercial');
    assert.equal(r.cnaes_secundarios.length, 1);
    assert.equal(r.opcao_simples, 'Não');
    assert.equal(r.socios[0].nome, 'FULANO DE TAL');
    assert.match(r.endereco, /BRASILIA\/DF/);
  } finally {
    globalThis.fetch = original;
  }
});

test('CNPJ inexistente na BrasilAPI vira erro claro', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse(404, { message: 'not found' });
    const r = await consultarCnpj('00000000000191');
    assert.equal(r.code, 'CNPJ_NAO_ENCONTRADO');
  } finally {
    globalThis.fetch = original;
  }
});

test('cai para a ReceitaWS quando a BrasilAPI falha', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('brasilapi')) throw new Error('rede indisponível');
      return jsonResponse(200, {
        cnpj: '00.000.000/0001-91',
        nome: 'EMPRESA EXEMPLO LTDA',
        fantasia: 'EXEMPLO',
        situacao: 'ATIVA',
        atividade_principal: [{ code: '62.01-5-01', text: 'Desenvolvimento de programas' }],
        atividades_secundarias: [{ code: '00.00-0-00', text: '' }],
        municipio: 'PALMAS', uf: 'TO',
        qsa: [{ nome: 'BELTRANO', qual: 'Sócio-Administrador' }]
      });
    };
    const r = await consultarCnpj('00000000000191');
    assert.equal(r.fonte, 'ReceitaWS');
    assert.equal(r.razao_social, 'EMPRESA EXEMPLO LTDA');
    assert.equal(r.cnae_principal, '62.01-5-01 - Desenvolvimento de programas');
    assert.equal(r.cnaes_secundarios.length, 0); // filtra o CNAE vazio 00.00-0-00
    assert.equal(r.socios[0].qualificacao, 'Sócio-Administrador');
  } finally {
    globalThis.fetch = original;
  }
});

test('quando as duas bases falham, devolve erro recuperável com detalhes', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('timeout'); };
    const r = await consultarCnpj('00000000000191');
    assert.equal(r.code, 'CNPJ_CONSULTA_INDISPONIVEL');
    assert.equal(r.recoverable, true);
    assert.ok(Array.isArray(r.detalhes) && r.detalhes.length === 2);
  } finally {
    globalThis.fetch = original;
  }
});
