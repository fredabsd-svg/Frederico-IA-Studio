const TOOL_PROTOCOL_BLOCK_SOURCE = '<\\s*tool_call\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*tool_call\\s*>';
const TOOL_PROTOCOL_START_RE = /<\s*(?:tool_call\b|function\s*(?:=|\b[^>]{0,120}\bname\s*=))/i;
const TOOL_PROTOCOL_LOOKBEHIND = 96;
const TOOL_PROTOCOL_MAX_CHARS = 250_000;

function cleanVisiblePrefix(value) {
  return String(value || '')
    .replace(/```(?:xml|json|text)?\s*$/i, '')
    .trimEnd();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function normalizeArguments(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeJsonCalls(value) {
  const entries = Array.isArray(value) ? value : [value];
  const calls = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return null;
    const name = String(entry.name || entry.function?.name || '').trim();
    const args = normalizeArguments(
      entry.arguments ?? entry.parameters ?? entry.function?.arguments ?? entry.function?.parameters
    );
    if (!name || !args) return null;
    calls.push({ name, arguments: args });
  }
  return calls;
}

function parseJsonBlock(block) {
  const raw = String(block || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  if (!raw.startsWith('{') && !raw.startsWith('[')) return null;
  try {
    return normalizeJsonCalls(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseXmlFunction(block) {
  const raw = String(block || '');
  const functionMatch =
    /<\s*function\s*=\s*["']?([a-zA-Z_][\w.-]*)["']?\s*>([\s\S]*?)<\s*\/\s*function\s*>/i.exec(raw)
    || /<\s*function\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*function\s*>/i.exec(raw);
  if (!functionMatch) return null;

  const args = {};
  const body = functionMatch[2];
  const parameterPatterns = [
    /<\s*parameter\s*=\s*["']?([a-zA-Z_][\w.-]*)["']?\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi,
    /<\s*parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi
  ];
  for (const pattern of parameterPatterns) {
    let match;
    while ((match = pattern.exec(body))) {
      if (!(match[1] in args)) args[match[1]] = decodeEntities(match[2].trim());
    }
    if (Object.keys(args).length) break;
  }
  if (!Object.keys(args).length && body.trim()) return null;
  return [{ name: functionMatch[1].trim(), arguments: args }];
}

function parseProtocolBlock(block) {
  return parseJsonBlock(block) || parseXmlFunction(block);
}

export function toolProtocolStartIndex(value) {
  return String(value || '').search(TOOL_PROTOCOL_START_RE);
}

// Alguns provedores (ex.: DeepSeek) devolvem a chamada de ferramenta como um
// objeto JSON PURO no texto — sem <tool_call>/<function> — tipicamente
// {"code":"..."} ou {"name":"run_python","arguments":{...}}, às vezes seguido de
// uma cerca ```json. Sem interceptar, o JSON vaza no chat e o modelo repete em
// loop. Aqui detectamos esse formato para escondê-lo e acionar a correção.
const BARE_JSON_TOOL_KEYS = new Set(['code', 'command', 'cmd', 'shell', 'script']);

function stripLeadingFence(value) {
  return String(value || '').replace(/^\s*```(?:json|tool_call|python|bash)?\s*/i, '');
}

// Extrai o primeiro objeto JSON balanceado a partir do início (ignora chaves
// dentro de strings). Retorna o texto do objeto ou null.
function leadingJsonObject(value) {
  const s = stripLeadingFence(value).trimStart();
  if (s[0] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length && i < TOOL_PROTOCOL_MAX_CHARS; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(0, i + 1); }
  }
  return null;
}

// Analisa um JSON puro de ferramenta no início do texto.
//  - { detected:false } quando não parece uma chamada de ferramenta;
//  - { detected:true, malformed:true } quando é uma chamada, mas não dá para
//    converter com segurança (esconde do usuário e aciona a correção);
//  - { detected:true, calls:[...] } quando dá para converter em chamada nativa.
export function parseBareJsonToolCall(value, availableToolNames = []) {
  const text = String(value || '');
  const objText = leadingJsonObject(text);
  if (!objText) return { detected: false };
  let obj;
  try { obj = JSON.parse(objText); } catch { return { detected: false }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { detected: false };

  const allowed = new Set([...availableToolNames].map(name => String(name)));
  const keys = Object.keys(obj);

  // Forma nomeada: {"name":"run_python","arguments":{...}}
  const named = normalizeJsonCalls(obj);
  if (named && named.length) {
    const ok = named.every(call => allowed.has(call.name));
    return ok ? { detected: true, malformed: false, calls: named }
              : { detected: true, malformed: true, calls: [] };
  }

  // Forma só-argumentos: {"code":...} / {"command":...} — sem o nome da tool.
  // Só tratamos como chamada quando HÁ ferramentas disponíveis; caso contrário
  // pode ser uma resposta JSON legítima do assistente.
  const hasToolKey = keys.some(k => BARE_JSON_TOOL_KEYS.has(k.toLowerCase()));
  if (hasToolKey && allowed.size) {
    return { detected: true, malformed: true, calls: [] };
  }
  return { detected: false };
}

export function parseTextToolCalls(value, availableToolNames = []) {
  const text = String(value || '');
  const start = toolProtocolStartIndex(text);
  if (start < 0) {
    // Sem marcador XML: tenta o formato JSON puro ({"code":...}) antes de
    // considerar a resposta como texto comum.
    const bare = parseBareJsonToolCall(text, availableToolNames);
    if (bare.detected) {
      return { detected: true, malformed: !!bare.malformed, calls: bare.calls || [], visibleText: '' };
    }
    return { detected: false, malformed: false, calls: [], visibleText: text };
  }

  const visibleText = cleanVisiblePrefix(text.slice(0, start));
  if (text.length > TOOL_PROTOCOL_MAX_CHARS) {
    return { detected: true, malformed: true, calls: [], visibleText };
  }

  const allowed = new Set([...availableToolNames].map(name => String(name)));
  const blockRe = new RegExp(TOOL_PROTOCOL_BLOCK_SOURCE, 'gi');
  const blocks = [];
  let match;
  while ((match = blockRe.exec(text))) blocks.push(match[1]);

  // Some providers omit the outer <tool_call> wrapper but keep the function
  // and parameter tags. Treat the remaining text as one candidate.
  if (!blocks.length && /<\s*function\s*(?:=|\b[^>]*\bname\s*=)/i.test(text.slice(start))) {
    blocks.push(text.slice(start));
  }
  if (!blocks.length) {
    return { detected: true, malformed: true, calls: [], visibleText };
  }

  const calls = [];
  for (const block of blocks) {
    const parsed = parseProtocolBlock(block);
    if (!parsed?.length) {
      return { detected: true, malformed: true, calls: [], visibleText };
    }
    for (const call of parsed) {
      if (!allowed.has(call.name)) {
        return { detected: true, malformed: true, calls: [], visibleText };
      }
      calls.push(call);
    }
  }
  return { detected: true, malformed: false, calls, visibleText };
}

export function sanitizeToolProtocolText(value) {
  const raw = String(value || '');
  let clean = raw.replace(new RegExp(TOOL_PROTOCOL_BLOCK_SOURCE, 'gi'), '');
  const danglingStart = toolProtocolStartIndex(clean);
  if (danglingStart >= 0) clean = clean.slice(0, danglingStart);
  return clean
    .replace(/```(?:xml|json|text)?\s*```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createToolProtocolStreamGuard(enabled = true) {
  let pending = '';
  let suppressed = false;

  return {
    push(chunk) {
      const text = String(chunk || '');
      if (!enabled) return text;
      if (suppressed) return '';
      pending += text;

      const start = toolProtocolStartIndex(pending);
      if (start >= 0) {
        const visible = cleanVisiblePrefix(pending.slice(0, start));
        pending = '';
        suppressed = true;
        return visible;
      }

      const emitLength = Math.max(0, pending.length - TOOL_PROTOCOL_LOOKBEHIND);
      if (!emitLength) return '';
      const visible = pending.slice(0, emitLength);
      pending = pending.slice(emitLength);
      return visible;
    },
    finish() {
      if (!enabled || suppressed) {
        const visible = enabled ? '' : pending;
        pending = '';
        return visible;
      }
      const start = toolProtocolStartIndex(pending);
      const visible = start >= 0
        ? cleanVisiblePrefix(pending.slice(0, start))
        : pending;
      if (start >= 0) suppressed = true;
      pending = '';
      return visible;
    },
    get suppressed() {
      return suppressed;
    }
  };
}
