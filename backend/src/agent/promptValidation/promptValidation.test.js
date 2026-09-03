// Testes do HARNESS de validação de comportamento — não do modelo.
//
// Um harness cujas verificações não são testadas é pior que nenhum: ele carimba
// "passou" em cima de um provedor que não respondeu, ou reprova um modelo que
// acertou. Cada verificação é exercitada NOS DOIS SENTIDOS (o caso que ela deve
// aprovar e o que ela deve reprovar), porque uma verificação que sempre devolve
// `ok` só aparece assim.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  casos, chamou, naoChamouNada, perguntouEParou, semCodigoNoChat,
  ateNCaracteres, contem, naoContem, respondeuEmIngles, usouADataDeHoje
} from './casos.js';
import { rodarValidacao, mensagensDoCaso, normalizarResposta, relatorioMarkdown } from './runner.js';

const vars = { data_ddmmaaaa: '03/09/2026' };
const resposta = (texto, toolCalls = []) => ({ texto, toolCalls, vars });

test('chamou() aprova a ferramenta esperada e reprova a errada ou a ausência', () => {
  const verificar = chamou('run_python');
  assert.equal(verificar(resposta('', [{ name: 'run_python' }])).ok, true);
  assert.equal(verificar(resposta('', [{ name: 'web_search' }])).ok, false);
  const vazio = verificar(resposta('vou gerar a planilha'));
  assert.equal(vazio.ok, false);
  assert.match(vazio.motivo, /não chamou ferramenta nenhuma/);
});

test('naoChamouNada() reprova a ferramenta chamada em pedido de uma linha', () => {
  assert.equal(naoChamouNada(resposta('R$ 414,00')).ok, true);
  assert.equal(naoChamouNada(resposta('', [{ name: 'run_python' }])).ok, false);
});

test('perguntouEParou() reprova o turno que pergunta e continua executando', () => {
  assert.equal(perguntouEParou(resposta('Qual cliente?')).ok, true);
  // O modo de falha que a regra ataca: o modelo responde a própria pergunta.
  const seguiu = perguntouEParou(resposta('Qual cliente? Vou começar pelo maior.', [{ name: 'run_python' }]));
  assert.equal(seguiu.ok, false);
  assert.match(seguiu.motivo, /continuou executando/);
  assert.equal(perguntouEParou(resposta('Preparei o relatório do cliente principal.')).ok, false);
});

test('semCodigoNoChat() separa código despejado de menção a código', () => {
  assert.equal(semCodigoNoChat(resposta('```python\nimport pandas as pd\n```')).ok, false);
  assert.equal(semCodigoNoChat(resposta('Gerei a planilha com pandas; o total fecha em R$ 366.370,00.')).ok, true);
  // Bloco de código que NÃO é script (uma tabela, um trecho de saída) não conta.
  assert.equal(semCodigoNoChat(resposta('```\nJaneiro 128.400,00\n```')).ok, true);
});

test('ateNCaracteres(), contem() e naoContem() medem o que prometem', () => {
  assert.equal(ateNCaracteres(10)(resposta('curto')).ok, true);
  assert.equal(ateNCaracteres(10)(resposta('x'.repeat(11))).ok, false);
  assert.equal(contem(/414/, 'resultado')(resposta('R$ 414,00')).ok, true);
  assert.equal(contem(/414/, 'resultado')(resposta('R$ 400,00')).ok, false);
  const semColar = naoContem(/\bcole\b/i, 'não pediu colagem');
  assert.equal(semColar(resposta('Li o arquivo.')).ok, true);
  assert.equal(semColar(resposta('Cole aqui o conteúdo do PDF.')).ok, false);
});

test('respondeuEmIngles() acompanha o idioma de quem escreveu', () => {
  assert.equal(respondeuEmIngles(resposta('The trial balance is a report; you use it to check that debits equal credits.')).ok, true);
  assert.equal(respondeuEmIngles(resposta('O balancete é um relatório que você usa para conferir se o ativo não está diferente do passivo.')).ok, false);
});

test('usouADataDeHoje() reprova a data do treinamento', () => {
  assert.equal(usouADataDeHoje(resposta('Hoje é 03/09/2026.')).ok, true);
  assert.equal(usouADataDeHoje(resposta('Hoje é 3 de setembro de 2026.')).ok, true);
  const errada = usouADataDeHoje(resposta('Hoje é 12/03/2024.'));
  assert.equal(errada.ok, false);
  assert.match(errada.motivo, /data de treinamento/);
});

test('as mensagens do caso são as MESMAS que o app monta', () => {
  const comExecucao = mensagensDoCaso(casos.find((c) => c.id === 'arquivo.planilha'), { modelo: 'modelo-x' });
  assert.equal(comExecucao.mensagens.length, 3);
  assert.match(comExecucao.mensagens[0].content, /NÚCLEO DE CONFIANÇA/);
  // A seção de documentos entra porque o caso tem run_python — é a promessa que
  // o v4.2 fez e que o harness precisa exercitar de fato.
  assert.match(comExecucao.mensagens[0].content, /DOCUMENTOS PROFISSIONAIS/);
  assert.match(comExecucao.mensagens[0].content, /Modelo em uso: modelo-x/);
  assert.match(comExecucao.mensagens[1].content, /FERRAMENTAS E AMBIENTE/);
  assert.ok(comExecucao.ferramentas.some((f) => f.function.name === 'run_python'));

  const semFerramenta = mensagensDoCaso(casos.find((c) => c.id === 'idioma.usuario'), {});
  assert.deepEqual(semFerramenta.ferramentas, []);
  assert.doesNotMatch(semFerramenta.mensagens[0].content, /DOCUMENTOS PROFISSIONAIS/);
});

test('normalizarResposta() aceita o formato OpenAI cru e o já achatado', () => {
  const cru = normalizarResposta({
    choices: [{ message: { content: 'oi', tool_calls: [{ function: { name: 'run_python', arguments: '{}' } }] } }]
  });
  assert.equal(cru.texto, 'oi');
  assert.deepEqual(cru.toolCalls.map((c) => c.name), ['run_python']);
  const achatado = normalizarResposta({ content: null, tool_calls: [] });
  assert.equal(achatado.texto, '');   // content nulo vira string, não "null"
  assert.deepEqual(achatado.toolCalls, []);
});

test('sem provedor a execução é SECA e não finge veredito', async () => {
  const agregado = await rodarValidacao();
  assert.equal(agregado.seco, true);
  assert.equal(agregado.veredito, 'seco');
  assert.equal(agregado.totais.passou, 0);
  assert.ok(agregado.resultados.every((r) => r.veredito === 'pulado'));
  assert.match(relatorioMarkdown(agregado), /nenhum provedor foi chamado/);
});

test('o provedor que falha vira erro, nunca reprovação do prompt', async () => {
  const agregado = await rodarValidacao({
    providerFn: async () => { throw new Error('401 unauthorized'); },
    ids: ['conta.simples']
  });
  assert.equal(agregado.resultados[0].veredito, 'erro');
  assert.equal(agregado.totais.reprovou, 0);
  // Todos os casos com erro de provedor: o veredito diz "indisponível", não
  // "reprovou" — uma chave vencida não é regressão de comportamento.
  assert.equal(agregado.veredito, 'indisponivel');
});

test('a bateria julga a resposta do provedor e relata caso a caso', async () => {
  const agregado = await rodarValidacao({
    modelo: 'modelo-x',
    ids: ['conta.simples', 'arquivo.planilha'],
    providerFn: async ({ mensagens }) => (/12% de 3\.450/.test(mensagens[2].content)
      ? { content: 'R$ 414,00 (3.450 × 0,12).' }
      : { content: 'Fiz na mão.', tool_calls: [] })
  });
  assert.equal(agregado.veredito, 'reprovou');
  assert.equal(agregado.totais.passou, 1);
  const reprovado = agregado.resultados.find((r) => r.id === 'arquivo.planilha');
  assert.match(reprovado.achados.find((a) => !a.ok).motivo, /não chamou ferramenta nenhuma/);
  const md = relatorioMarkdown(agregado);
  assert.match(md, /R\$ 414,00/);          // a resposta inteira entra no relatório
  assert.match(md, /TRIAGEM automática/);  // e o relatório diz que não é aprovação
});

test('toda verificação da bateria tem nome — o relatório precisa dizer qual falhou', () => {
  assert.ok(casos.length >= 5, 'a bateria deveria cobrir os modos de falha da revisão');
  for (const caso of casos) {
    assert.ok(caso.verificacoes.length > 0, `${caso.id} não verifica nada`);
    assert.ok(caso.promessa, `${caso.id} não declara qual promessa do prompt ele cobra`);
  }
});
