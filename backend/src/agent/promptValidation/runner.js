// Executor da bateria de comportamento do prompt v4.2.
//
// O ponto inteiro do arquivo é montar o MESMO `messages[0]`/`messages[1]` que o
// `loop.js` monta em produção — `promptFor` + `toolAvailabilityNote`, com as
// ferramentas reais do assistente. Um harness que escrevesse o próprio prompt
// validaria um texto que ninguém usa.
//
// Sem `providerFn`, roda em SECO: não toca a rede, não gasta token e devolve
// veredito `seco`. É esse modo que a suíte de testes usa; o `--live` do CLI é
// que chama o provedor de verdade.

import { promptFor, toolsFor, toolAvailabilityNote } from '../prompts.js';
import { callContextVars } from '../systemPromptV4.js';
import { casos as todosOsCasos } from './casos.js';

const FERRAMENTAS_DE_EXECUCAO = ['run_python', 'bash', 'write_file', 'read_file', 'list_files'];
const TIMEOUT_PADRAO_MS = 60_000;

// O assistente que cada caso descreve, no formato que `toolsFor` entende.
// `tools: []` é deliberadamente diferente de ausente: lista vazia significa
// "sem ferramenta nenhuma" (assistantPolicy.js), que é o cenário do caso de
// honestidade.
function assistenteDoCaso(caso) {
  return { tools: caso.ferramentas === 'execucao' ? [...FERRAMENTAS_DE_EXECUCAO] : [] };
}

export function mensagensDoCaso(caso, { modelo, agora, sandboxNetworkEnabled = false } = {}) {
  const assistente = assistenteDoCaso(caso);
  const ferramentas = toolsFor(assistente);
  const sistema = promptFor(assistente, {
    tools: ferramentas,
    model: modelo,
    sandboxNetworkEnabled,
    ...(agora ? { now: agora } : {})
  });
  return {
    ferramentas,
    mensagens: [
      { role: 'system', content: sistema },
      { role: 'system', content: toolAvailabilityNote(ferramentas, { sandboxNetworkEnabled }) },
      { role: 'user', content: caso.mensagem }
    ]
  };
}

// Normaliza a resposta do provedor para o formato que as verificações esperam.
// Aceita tanto o formato OpenAI cru (`choices[0].message`) quanto um objeto já
// achatado, porque o CLI e os testes injetam coisas diferentes.
export function normalizarResposta(bruta) {
  const msg = bruta?.choices?.[0]?.message ?? bruta ?? {};
  const chamadas = msg.tool_calls || bruta?.tool_calls || [];
  return {
    texto: String(msg.content ?? bruta?.content ?? ''),
    toolCalls: chamadas.map((c) => ({
      name: c?.function?.name ?? c?.name ?? '(sem nome)',
      arguments: c?.function?.arguments ?? c?.arguments ?? null
    }))
  };
}

async function comTimeout(promessa, ms) {
  let timer;
  try {
    return await Promise.race([
      promessa,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rodarUm(caso, { providerFn, modelo, agora, timeoutMs }) {
  const { ferramentas, mensagens } = mensagensDoCaso(caso, { modelo, agora });
  const vars = callContextVars({ model: modelo, ...(agora ? { now: agora } : {}) });
  const inicio = Date.now();
  let resposta;
  try {
    resposta = normalizarResposta(await comTimeout(
      providerFn({ mensagens, ferramentas, modelo }),
      timeoutMs
    ));
  } catch (erro) {
    return {
      id: caso.id,
      promessa: caso.promessa,
      erro: erro?.message ?? String(erro),
      veredito: 'erro',
      achados: [],
      texto: '',
      toolCalls: [],
      duracaoMs: Date.now() - inicio
    };
  }

  const achados = caso.verificacoes.map((verificar) => {
    const r = verificar({ ...resposta, vars });
    return { ok: r.ok, motivo: r.motivo, verificacao: verificar.name || 'anônima' };
  });

  return {
    id: caso.id,
    promessa: caso.promessa,
    erro: null,
    veredito: achados.every((a) => a.ok) ? 'passou' : 'reprovou',
    achados,
    texto: resposta.texto,
    toolCalls: resposta.toolCalls,
    duracaoMs: Date.now() - inicio
  };
}

/**
 * Roda a bateria. `providerFn({ mensagens, ferramentas, modelo })` deve devolver
 * a resposta do provedor; sem ela, o modo é SECO.
 *
 * Sequencial de propósito: são sete chamadas, e serializar evita rate limit e
 * deixa o relatório sair na ordem em que a pessoa vai ler.
 */
export async function rodarValidacao({
  providerFn = null,
  modelo = process.env.VALIDACAO_MODELO || null,
  agora = undefined,
  timeoutMs = TIMEOUT_PADRAO_MS,
  ids = null
} = {}) {
  const casos = ids ? todosOsCasos.filter((c) => ids.includes(c.id)) : todosOsCasos;

  if (!providerFn) {
    return {
      seco: true,
      modelo,
      veredito: 'seco',
      resultados: casos.map((c) => ({
        id: c.id, promessa: c.promessa, veredito: 'pulado', achados: [], texto: '', toolCalls: [], erro: null, duracaoMs: 0
      })),
      totais: { casos: casos.length, passou: 0, reprovou: 0, erro: 0 }
    };
  }

  const resultados = [];
  for (const caso of casos) {
    resultados.push(await rodarUm(caso, { providerFn, modelo, agora, timeoutMs }));
  }

  const totais = {
    casos: resultados.length,
    passou: resultados.filter((r) => r.veredito === 'passou').length,
    reprovou: resultados.filter((r) => r.veredito === 'reprovou').length,
    erro: resultados.filter((r) => r.veredito === 'erro').length
  };
  // `erro` não é reprovação do prompt: é o provedor que não respondeu. Misturar
  // os dois faria uma chave vencida parecer regressão de comportamento.
  const veredito = totais.erro === totais.casos ? 'indisponivel'
    : totais.reprovou ? 'reprovou'
      : totais.erro ? 'parcial'
        : 'passou';

  return { seco: false, modelo, veredito, resultados, totais };
}

/**
 * Relatório em Markdown. Traz a resposta INTEIRA de cada caso porque o veredito
 * automático é triagem: a leitura humana continua sendo parte do gate.
 */
export function relatorioMarkdown(agregado) {
  const linhas = [`# Validação de comportamento — prompt v4.2`, ''];
  linhas.push(`- Modelo: \`${agregado.modelo || '(não informado)'}\``);
  linhas.push(`- Veredito: **${agregado.veredito}**`);
  if (agregado.seco) {
    linhas.push('- Execução SECA: nenhum provedor foi chamado, nenhum caso foi julgado.');
    return linhas.join('\n');
  }
  const t = agregado.totais;
  linhas.push(`- Totais: ${t.passou} passou / ${t.reprovou} reprovou / ${t.erro} erro (de ${t.casos})`, '');

  for (const r of agregado.resultados) {
    const marca = { passou: '✅', reprovou: '❌', erro: '⚠️', pulado: '·' }[r.veredito] || '?';
    linhas.push(`## ${marca} ${r.id}`, '', `_${r.promessa}_`, '');
    if (r.erro) linhas.push(`Falha de provedor: \`${r.erro}\``, '');
    for (const a of r.achados) linhas.push(`- ${a.ok ? '✅' : '❌'} \`${a.verificacao}\` — ${a.motivo}`);
    if (r.toolCalls.length) linhas.push('', `Ferramentas chamadas: ${r.toolCalls.map((c) => `\`${c.name}\``).join(', ')}`);
    if (r.texto) linhas.push('', 'Resposta:', '', '> ' + r.texto.split('\n').join('\n> '));
    linhas.push('');
  }
  linhas.push('---', '', 'O veredito acima é TRIAGEM automática: ele reprova o que é objetivamente errado (ferramenta não chamada, turno que não parou na pergunta, data do treinamento). A qualidade da resposta ainda precisa ser lida por uma pessoa.');
  return linhas.join('\n');
}
