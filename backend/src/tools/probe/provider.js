// Provedor REAL da sonda de tool calling — o modo `--live`.
//
// O defeito que este arquivo fecha: os dois pontos de entrada do modo live (a
// rota `POST /admin/tool-probe` e o `scripts/run-tool-probe.mjs`) importavam
// `src/provider.js` e chamavam `generateOpenAICompatible`. Nenhum dos dois
// existe: o módulo de provedor mora em `src/agent/provider.js` e nunca exportou
// essa função. Na rota, `live: true` devolvia 503 sempre; no CLI, o `catch`
// caía em dry-run e imprimia um veredito — e dry-run responde `no_tool` em
// TODOS os cenários. Ou seja: a sonda dizia "este modelo não faz tool calling"
// sem nunca ter chamado modelo nenhum. Uma sonda que mente em silêncio é pior
// que sonda nenhuma, porque o veredito dela vira decisão de produto.
//
// A correção é uma fonte só, usada pelos dois pontos de entrada, para eles não
// tornarem a divergir. Quem resolve o provedor continua sendo quem já resolve
// em produção: a rota usa o provedor do usuário (`getUserProvider`), o CLI usa
// as variáveis de ambiente.

import { createAiClient } from '../../aiClient.js';

// Modelo de mentira que o `probeRunner` põe em `options.model` quando ninguém
// definiu `PROBE_MODEL`. Ele nasceu na época em que não havia provedor real; se
// fosse enviado ao provedor, viraria "model not found" em todos os runs.
const MODELO_PLACEHOLDER = 'probe-model';

export class SondaSemProvedor extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'SondaSemProvedor';
  }
}

/**
 * Achata a resposta da API para o formato que o classificador lê
 * (`{ content, tool_calls }`). O classificador é deliberadamente burro quanto à
 * origem: é o que permite reclassificar respostas gravadas sem rerodar a rede.
 */
export function achatarResposta(completion) {
  const msg = completion?.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? '',
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    usage: completion?.usage ?? null
  };
}

/**
 * `providerFn` a partir de um cliente já resolvido — o caminho da rota admin,
 * onde o provedor (chave, base URL e modelo) é o do usuário autenticado.
 *
 * `options.model` só vence quando alguém definiu `PROBE_MODEL` de propósito;
 * caso contrário ele é o placeholder do runner e o modelo do provedor manda.
 */
export function providerDeCliente({ client, model }) {
  if (!client) throw new SondaSemProvedor('cliente do provedor ausente');
  if (!model) throw new SondaSemProvedor('modelo do provedor ausente');
  return async (messages, options = {}) => {
    const escolhido = options.model && options.model !== MODELO_PLACEHOLDER ? options.model : model;
    const completion = await client.chat.completions.create({
      model: escolhido,
      messages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 300,
      ...(options.tools?.length ? { tools: options.tools } : {})
    });
    return achatarResposta(completion);
  };
}

/**
 * `providerFn` a partir do ambiente — o caminho do CLI, que não tem usuário
 * autenticado nem banco.
 *
 * Levanta `SondaSemProvedor` em vez de devolver `null`: o chamador precisa
 * PARAR e dizer o que falta. Cair em dry-run aqui foi exatamente o defeito.
 */
export function providerDoAmbiente(env = process.env) {
  const apiKey = env.SONDA_API_KEY || env.VALIDACAO_API_KEY || env.FREE_TIER_API_KEY;
  const baseURL = env.SONDA_BASE_URL || env.VALIDACAO_BASE_URL
    || env.FREE_TIER_BASE_URL || env.DEEPSEEK_BASE_URL;
  const model = env.SONDA_MODELO || env.PROBE_MODEL || env.VALIDACAO_MODELO || env.DEFAULT_LLM;

  if (!apiKey) {
    throw new SondaSemProvedor(
      'sem chave de provedor: defina SONDA_API_KEY (ou VALIDACAO_API_KEY / FREE_TIER_API_KEY)'
    );
  }
  if (!model) {
    throw new SondaSemProvedor(
      'sem modelo: defina SONDA_MODELO (ou PROBE_MODEL / VALIDACAO_MODELO / DEFAULT_LLM)'
    );
  }
  return providerDeCliente({ client: createAiClient({ apiKey, baseURL }), model });
}
