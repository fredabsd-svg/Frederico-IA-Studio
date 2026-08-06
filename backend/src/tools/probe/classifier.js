// Classificador de respostas do LLM para a sonda de tool calling.
//
// OBJETIVO
// Receber a resposta crua do provider (objeto com `content`, `tool_calls`, etc.)
// e dizer: "o modelo tentou chamar tool? Se sim, com quais argumentos? Se não,
// produziu texto plausível?".
//
// Por que é separado do runner?
//   1) É a única parte 100% determinística e testável sem rede.
//   2) Permite reclassificar respostas gravadas sem rerodar chamadas.
//   3) Permite que o veredito final mude sem precisar rerodar a sonda.
//
// FORMATO DE SAÍDA — Record<string, unknown>
//   {
//     decision:    'tool_call' | 'no_tool' | 'malformed',
//     toolName?:    string,
//     arguments?:   object,
//     rawContent?:  string,        // texto livre (pode coexistir com tool_call em alguns provedores)
//     parseSource?: 'native' | 'json_block' | 'xml_block' | 'fallback',
//     parseError?:  string,         // só se decision === 'malformed'
//   }
//
// MODOS DE PARSE (em ordem de preferência):
//   1. native    — `response.tool_calls` veio populado pelo provider.
//   2. json_block — modelo emitiu ```json { ... } ``` no conteúdo.
//   3. xml_block  — modelo emitiu <tool_call>...</tool_call>.
//   4. fallback   — nada encontrado: decision = 'no_tool'.

import { JSONAttempt } from './parseFallback.js';

// ---------- Helpers internos ----------

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// Extrai o primeiro bloco ```json ... ``` do texto, retornando { raw, body } ou null.
function extractJsonBlock(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const re = /```(?:json)?\s*([\s\S]*?)```/i;
  const match = re.exec(text);
  if (!match) return null;
  return { raw: match[1].trim(), body: match[1].trim() };
}

// Extrai um bloco <tool_call name="..."> ... </tool_call>. Suporta argumento em
// atributo ou em corpo JSON. Retorna { name, arguments } ou null.
function extractXmlBlock(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const re =
    /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>|<tool_call\b([^>]*)\/>/i;
  const match = re.exec(text);
  if (!match) return null;
  const attrPart = match[1] ?? match[3] ?? '';
  const body = match[2] ?? '';
  const nameMatch = /\bname\s*=\s*"([^"]+)"/i.exec(attrPart);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  // Tenta primeiro um atributo args='...'; depois corpo como JSON.
  const argsAttr = /\bargs\s*=\s*"([\s\S]*?)"/i.exec(attrPart);
  let parsedArgs = null;
  if (argsAttr) {
    try {
      parsedArgs = JSON.parse(unescapeXml(argsAttr[1]));
    } catch {
      parsedArgs = null;
    }
  }
  if (!parsedArgs && body.trim().length > 0) {
    try {
      parsedArgs = JSON.parse(body.trim());
    } catch {
      parsedArgs = null;
    }
  }
  return { name, arguments: parsedArgs };
}

// Desescapa XML escapado em atributo (mínimo necessário).
function unescapeXml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Valida que arguments tem o shape mínimo: objeto com ao menos 1 chave.
function shapeOk(args) {
  if (!isPlainObject(args)) return false;
  return Object.keys(args).length > 0;
}

// ---------- API pública ----------

export function classifyToolCall(response) {
  // 1. Caminho nativo: provider já estruturou.
  if (response && Array.isArray(response.tool_calls) && response.tool_calls.length > 0) {
    const first = response.tool_calls[0];
    const fn = first?.function ?? first;
    const name = typeof fn?.name === 'string' ? fn.name : null;
    // arguments pode chegar como string (JSON) ou objeto, dependendo do provider.
    let args = fn?.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return {
          decision: 'malformed',
          toolName: name ?? undefined,
          rawContent: typeof response.content === 'string' ? response.content : '',
          parseSource: 'native',
          parseError: 'tool_call.arguments não é JSON válido',
        };
      }
    }
    if (!name || !shapeOk(args)) {
      return {
        decision: 'malformed',
        toolName: name ?? undefined,
        rawContent: typeof response.content === 'string' ? response.content : '',
        parseSource: 'native',
        parseError: 'tool_call sem name ou arguments vazio',
      };
    }
    return {
      decision: 'tool_call',
      toolName: name,
      arguments: args,
      rawContent: typeof response.content === 'string' ? response.content : '',
      parseSource: 'native',
    };
  }

  // 2-3. Fallbacks baseados em texto.
  const content = typeof response?.content === 'string' ? response.content : '';

  const xml = extractXmlBlock(content);
  if (xml && xml.name) {
    if (!shapeOk(xml.arguments)) {
      return {
        decision: 'malformed',
        toolName: xml.name,
        rawContent: content,
        parseSource: 'xml_block',
        parseError: 'XML block com arguments ausentes ou vazios',
      };
    }
    return {
      decision: 'tool_call',
      toolName: xml.name,
      arguments: xml.arguments,
      rawContent: content,
      parseSource: 'xml_block',
    };
  }

  const json = extractJsonBlock(content);
  if (json) {
    const attempt = JSONAttempt.safeParse(json.body);
    if (attempt.ok) {
      const obj = attempt.value;
      const name = typeof obj?.name === 'string' ? obj.name : null;
      const args = obj?.arguments;
      if (name && shapeOk(args)) {
        return {
          decision: 'tool_call',
          toolName: name,
          arguments: args,
          rawContent: content,
          parseSource: 'json_block',
        };
      }
    }
    return {
      decision: 'malformed',
      rawContent: content,
      parseSource: 'json_block',
      parseError: 'JSON block encontrado mas sem { name, arguments } válidos',
    };
  }

  // 4. Sem tool call.
  return {
    decision: 'no_tool',
    rawContent: content,
    parseSource: 'fallback',
  };
}

// Compara a classificação contra o cenário esperado. Retorna { match, reason }.
// match=false com reason legível serve para humanos; o veredito final agrega
// matches em vez de inspecionar reasons.
export function compareToExpectation(classified, scenario) {
  if (scenario.expectedDecision === 'no_tool') {
    if (classified.decision === 'no_tool') return { match: true, reason: 'esperava no_tool e veio no_tool' };
    if (classified.decision === 'tool_call') {
      return {
        match: false,
        reason: `esperava no_tool mas modelo chamou tool "${classified.toolName}"`,
      };
    }
    return {
      match: false,
      reason: `esperava no_tool mas resposta veio malformed (${classified.parseError ?? 'sem detalhes'})`,
    };
  }

  // Esperado: tool_call.
  if (classified.decision !== 'tool_call') {
    return {
      match: false,
      reason: `esperava tool_call "${scenario.expectedToolName ?? '?'}" mas veio ${classified.decision}`,
    };
  }

  // Comparação frouxa de arguments: chaves presentes batem; valores string batem
  // ignorando caixa/espaços; números batem por igualdade. Não comparamos campos
  // extras (modelos podem adicionar campos "úteis").
  const expected = scenario.expectedArguments ?? {};
  const got = classified.arguments ?? {};
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in got)) {
      return {
        match: false,
        reason: `arguments sem chave obrigatória "${k}" (recebido: ${JSON.stringify(got)})`,
      };
    }
    if (typeof v === 'string' && typeof got[k] === 'string') {
      if (got[k].trim().toLowerCase() !== v.trim().toLowerCase()) {
        return {
          match: false,
          reason: `arguments["${k}"] divergente: esperado "${v}", veio "${got[k]}"`,
        };
      }
    } else if (got[k] !== v) {
      return {
        match: false,
        reason: `arguments["${k}"] divergente: esperado ${JSON.stringify(v)}, veio ${JSON.stringify(got[k])}`,
      };
    }
  }
  return { match: true, reason: 'tool_call + arguments batem com esperado' };
}