// Perguntas interativas do agente (`ask_user`).
//
// POR QUE EXISTE: pedir uma DECISÃO ao usuário (escopo, opção A ou B, permissão)
// não é falha técnica. Antes, a única forma de o agente parar e perguntar era
// terminar o texto com "?" e esperar que a heurística `endsAwaitingUserReply`
// reconhecesse — o que dependia de pontuação e produzia dois defeitos: pergunta
// sem "?" seguia como execução incompleta (virava `fatal_error` +
// `execution_failed` na interface) e a interface não tinha como oferecer botões
// para responder.
//
// Aqui a pergunta passa a ser um CONTRATO: uma ferramenta interna que o loop
// INTERCEPTA antes do `runTool` — ela não roda no sandbox, não toca arquivos,
// não acessa rede. O resultado é um `inputRequest` validado no backend (nada do
// que o modelo escreve é aceito sem normalização), emitido como evento SSE
// `input_required` e persistido no `execution_meta` da mensagem, para sobreviver
// ao reload e ao replay.
//
// LIMITES DELIBERADOS:
// - não é oferecida a sub-agentes (o filho não fala com o usuário);
// - não é oferecida em tarefa de segundo plano (`forceExecution`): não há
//   ninguém para responder, e parar ali deixaria a fila travada;
// - só a PRIMEIRA solicitação válida de um lote é considerada.
import { nanoid } from 'nanoid';

export const ASK_USER_TOOL_NAME = 'ask_user';
export const INPUT_REQUEST_KINDS = Object.freeze(['text', 'confirm', 'select']);

// Limites de tamanho: o modelo não define o tamanho do que a interface renderiza.
export const INPUT_REQUEST_LIMITS = Object.freeze({
  question: 2000,
  label: 160,
  value: 300,
  description: 400,
  placeholder: 160,
  defaultValue: 300,
  button: 60,
  options: 8
});

export const askUserToolDefinition = {
  type: 'function',
  function: {
    name: ASK_USER_TOOL_NAME,
    description:
      'Pausa o trabalho e solicita ao usuário uma decisão necessária (escopo, escolha entre alternativas, autorização). '
      + 'Use apenas quando não for seguro ou possível continuar sem essa resposta — nunca para confirmar algo que o pedido atual já autoriza. '
      + 'Esta ferramenta não executa nada: ela encerra o turno e devolve a pergunta ao usuário.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', description: 'A pergunta, em português, escrita para a pessoa (sem JSON, sem markdown de bloco).' },
        kind: { type: 'string', enum: [...INPUT_REQUEST_KINDS], description: 'text = resposta livre; confirm = sim/não; select = escolher entre opções.' },
        options: {
          type: 'array',
          maxItems: INPUT_REQUEST_LIMITS.options,
          description: 'Obrigatório (2 a 8 itens) quando kind = select.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', description: 'Texto do botão/opção.' },
              value: { type: 'string', description: 'Valor curto que identifica a opção.' },
              description: { type: 'string', description: '(opcional) uma linha explicando a consequência da opção.' }
            },
            required: ['label', 'value']
          }
        },
        placeholder: { type: 'string', description: '(opcional, kind = text) dica dentro do campo.' },
        defaultValue: { type: 'string', description: '(opcional) valor sugerido.' },
        confirmLabel: { type: 'string', description: '(opcional, kind = confirm) rótulo do botão principal.' },
        cancelLabel: { type: 'string', description: '(opcional, kind = confirm) rótulo do botão secundário.' },
        required: { type: 'boolean', description: '(opcional) true quando não há como continuar sem resposta.' }
      },
      required: ['question', 'kind']
    }
  }
};

// HTML/markup vindo do modelo é recusado: o texto é renderizado como texto na
// interface, e aceitar tag aqui só abriria caminho para confusão visual.
const MARKUP_RE = /<\s*\/?\s*[a-z!?]/i;

// Caracteres de controle (menos os de quebra de linha e tabulacao) saem fora:
// nada de NUL nem de sequencia de escape ANSI atravessando o SSE ate a tela.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function cleanText(value, limit) {
  const s = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_RE, '')
    .trim();
  if (!s) return '';
  if (MARKUP_RE.test(s)) return null; // sinaliza rejeição
  return s.slice(0, limit);
}

function cleanOption(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = cleanText(raw.label, INPUT_REQUEST_LIMITS.label);
  const value = cleanText(raw.value, INPUT_REQUEST_LIMITS.value);
  if (!label || !value) return null;
  const description = cleanText(raw.description, INPUT_REQUEST_LIMITS.description);
  return { label, value, ...(description ? { description } : {}) };
}

export function newInputRequestId() {
  return `iq_${nanoid(10)}`;
}

// Normaliza (e RE-VALIDA) os argumentos que o modelo mandou. Devolve
// `{ request }` ou `{ error }` — o erro volta ao modelo como resultado de
// ferramenta, para ele corrigir a chamada em vez de o turno morrer.
// Propriedades desconhecidas são descartadas: o schema é a fronteira.
export function normalizeInputRequest(rawArgs, { id = null, createdAt = null } = {}) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  const question = cleanText(args.question, INPUT_REQUEST_LIMITS.question);
  if (question === null) return { error: 'A pergunta não pode conter HTML ou tags. Reescreva em texto simples.' };
  if (!question) return { error: 'Informe "question": a pergunta que o usuário precisa responder.' };

  const kind = String(args.kind || '').trim().toLowerCase();
  if (!INPUT_REQUEST_KINDS.includes(kind)) {
    return { error: `"kind" precisa ser um destes: ${INPUT_REQUEST_KINDS.join(', ')}.` };
  }

  let options = [];
  if (Array.isArray(args.options)) {
    if (args.options.length > INPUT_REQUEST_LIMITS.options) {
      return { error: `No máximo ${INPUT_REQUEST_LIMITS.options} opções.` };
    }
    for (const raw of args.options) {
      const option = cleanOption(raw);
      if (!option) return { error: 'Cada opção precisa de "label" e "value" em texto simples (sem HTML).' };
      options.push(option);
    }
    // Valores repetidos tornariam a resposta ambígua.
    const seen = new Set();
    for (const option of options) {
      if (seen.has(option.value)) return { error: `A opção "${option.value}" aparece duas vezes; use valores distintos.` };
      seen.add(option.value);
    }
  }
  if (kind === 'select' && options.length < 2) {
    return { error: 'Com kind = "select" são necessárias pelo menos duas opções.' };
  }
  if (kind !== 'select') options = [];

  const placeholder = kind === 'text' ? cleanText(args.placeholder, INPUT_REQUEST_LIMITS.placeholder) : '';
  const defaultValue = cleanText(args.defaultValue, INPUT_REQUEST_LIMITS.defaultValue);
  const confirmLabel = kind === 'confirm' ? cleanText(args.confirmLabel, INPUT_REQUEST_LIMITS.button) : '';
  const cancelLabel = kind === 'confirm' ? cleanText(args.cancelLabel, INPUT_REQUEST_LIMITS.button) : '';
  if (placeholder === null || defaultValue === null || confirmLabel === null || cancelLabel === null) {
    return { error: 'Os rótulos e o valor sugerido não podem conter HTML ou tags.' };
  }

  return {
    request: {
      // O id é do BACKEND: um id escolhido pelo modelo poderia colidir de
      // propósito com uma solicitação anterior e confundir a interface.
      id: id || newInputRequestId(),
      kind,
      question,
      ...(options.length ? { options } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(defaultValue ? { defaultValue } : {}),
      ...(confirmLabel ? { confirmLabel } : {}),
      ...(cancelLabel ? { cancelLabel } : {}),
      required: args.required === true,
      createdAt: createdAt || new Date().toISOString()
    }
  };
}

// Compatibilidade: quando o modelo NÃO usa a ferramenta e apenas termina o texto
// perguntando (fallback de `endsAwaitingUserReply`), a solicitação é montada
// aqui com a própria pergunta — a interface trata os dois caminhos igual.
// Aqui a recusa de markup NÃO se aplica: a "pergunta" é o próprio texto que o
// modelo já mostrou ao usuário (podendo conter markdown ou um `<` num trecho de
// código). Só limpamos caracteres de controle e cortamos no limite.
export function textInputRequest(question, { id = null, createdAt = null } = {}) {
  const clean = String(question ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_RE, '')
    .trim()
    .slice(0, INPUT_REQUEST_LIMITS.question);
  return {
    id: id || newInputRequestId(),
    kind: 'text',
    question: clean || 'Preciso da sua resposta para continuar.',
    required: false,
    fallback: true,
    createdAt: createdAt || new Date().toISOString()
  };
}

// A ferramenta só entra no inventário quando faz sentido perguntar.
export function shouldOfferAskUser({ lowSignalTurn = false, isSubagent = false, forceExecution = false, hasTools = false } = {}) {
  if (lowSignalTurn) return false;
  if (isSubagent) return false;
  if (forceExecution) return false;
  // Assistente configurado SEM ferramentas continua sem ferramentas: acrescentar
  // uma aqui mudaria a nota de inventário (que hoje explica ao usuário como
  // habilitá-las) e o plano de capacidades do modelo. Nesse caso o fallback
  // textual — `endsAwaitingUserReply` — segue cobrindo a pergunta.
  if (!hasTools) return false;
  return true;
}

// Nota de sistema que acompanha a ferramenta no inventário: sem ela o modelo
// tende a perguntar no texto (e a continuar executando) em vez de parar.
export const ASK_USER_NOTE = `- ask_user: PARAR e pedir uma decisão ao usuário (escopo, escolha entre alternativas, autorização). Use quando não for seguro continuar sem a resposta. Chame a ferramenta em vez de escrever a pergunta e seguir executando: ela encerra o turno, a pessoa responde na interface e você continua no próximo turno. Escolha kind="confirm" para sim/não, kind="select" (2 a 8 opções) para alternativas e kind="text" para resposta livre. Nunca use para confirmar algo que o pedido atual já autoriza, nem para pedir dado que você consegue obter com as outras ferramentas.`;
