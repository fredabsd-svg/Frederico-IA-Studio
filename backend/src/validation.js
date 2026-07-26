// Validação estruturada de corpo de requisição com zod, num só lugar.
//
// Os schemas são "loose" (z.looseObject): campos desconhecidos passam adiante
// sem serem removidos — o objetivo aqui é garantir TIPO e TAMANHO dos campos
// que o backend realmente usa (e mensagens de erro consistentes), não travar a
// evolução do frontend. Checagens de NEGÓCIO (posse, duplicidade, limites por
// plano) continuam nos handlers.
import { z } from 'zod/v4';
import { ASSISTANT_TOOL_NAMES, MAX_ASSISTANT_PROFILE_CHARS } from './agent/assistantPolicy.js';
import {
  OUTPUT_TYPES as DESIGN_OUTPUT_TYPES,
  MAX_TITLE_CHARS as DESIGN_MAX_TITLE_CHARS,
  MAX_PROMPT_CHARS as DESIGN_MAX_PROMPT_CHARS,
} from './design/core.js';

// Mensagens de erro do zod em português (o app inteiro fala pt-BR).
z.config(z.locales.pt());

// Middleware: valida req[source] contra o schema; em erro responde 400 com a
// primeira mensagem (padrão { error } que o frontend já entende). Em sucesso,
// substitui o corpo pela versão validada (com trims e coerções aplicados).
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const parsed = schema.safeParse(req[source] ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path.join('.');
      return res.status(400).json({ error: field ? `${issue.message} (campo: ${field})` : issue.message });
    }
    req[source] = parsed.data;
    next();
  };
}

const id = z.string().trim().max(120);
// Inclui a referência interna "provider-id::model-id". Alguns catálogos usam
// ids longos; o id bruto é limitado a 300 no importador.
const modelId = z.string().trim().max(360);
const shortText = (max, msg) => z.string({ error: msg }).trim().min(1, msg).max(max);
const assistantTools = z.array(z.enum(ASSISTANT_TOOL_NAMES, { message: 'Ferramenta de assistente inválida.' })).max(ASSISTANT_TOOL_NAMES.length).optional();
const assistantPersonality = z.looseObject({
  form: z.coerce.number().min(0).max(100).optional(),
  det: z.coerce.number().min(0).max(100).optional(),
  criat: z.coerce.number().min(0).max(100).optional(),
}).optional();

// Configuração de uma execução MULTIMODELO (2+ modelos na mesma mensagem).
// A normalização fina (papéis válidos, tetos de rodadas/orçamento) acontece em
// agent/multiModel.js — aqui garantimos apenas tipo e tamanho.
const multiModelConfig = z.looseObject({
  mode: z.enum(['compare', 'council', 'debate', 'pipeline']).optional(),
  models: z.array(z.looseObject({
    id: modelId,
    role: z.string().trim().max(40).nullish(),
    label: z.string().trim().max(80).nullish(),
    prompt: z.string().max(4000).nullish(),
  })).max(12, 'Modelos demais para uma única execução.'),
  coordinator: modelId.nullish(),
  rounds: z.coerce.number().optional(),
  maxTokensPerModel: z.coerce.number().nullish(),
  budgetUsd: z.coerce.number().nullish(),
  context: z.enum(['full', 'recent', 'summary', 'none']).optional(),
});

export const schemas = {
  chat: z.looseObject({
    message: z.string({ error: 'Mensagem vazia.' }).trim().min(1, 'Mensagem vazia.').max(100_000, 'A mensagem é grande demais. Envie em partes menores.'),
    model: modelId.nullish(),
    assistantId: id.nullish(),
    // Modo Equipe envia por padrão TODOS os assistentes do usuário — o teto é
    // só um freio de abuso, alto o bastante para nunca barrar uso legítimo.
    orchestrateIds: z.array(id).max(100, 'A equipe tem assistentes demais para uma única mensagem (máximo 100).').optional(),
    effort: z.string().trim().max(30).nullish(),
    multiModel: multiModelConfig.nullish(),
    attachments: z.array(z.looseObject({
      id: id.nullish(),
      path: z.string().trim().max(500),
      name: z.string().trim().max(500).nullish(),
      size: z.coerce.number().nonnegative().nullish(),
    })).max(20, 'Anexos demais para uma única mensagem.').optional(),
  }),

  multiModelCancelSlot: z.looseObject({
    slot: z.coerce.number().int().min(0).max(11),
  }),

  modelTeamCreate: z.looseObject({
    name: shortText(120, 'Dê um nome para a equipe de modelos.'),
    config: multiModelConfig,
  }),

  task: z.looseObject({
    message: z.string({ error: 'Mensagem vazia.' }).trim().min(1, 'Mensagem vazia.').max(100_000, 'A mensagem é grande demais. Envie em partes menores.'),
    conversationId: shortText(120, 'Conversa não informada.'),
    model: modelId.nullish(),
    assistantId: id.nullish(),
  }),

  conversationCreate: z.looseObject({
    title: z.string().trim().max(300).optional(),
    model: modelId.nullish(),
    clientId: id.nullish(),
  }),

  control: z.looseObject({
    action: z.enum(['pause', 'resume', 'stop'], { message: 'Ação inválida.' }),
  }),

  assistantCreate: z.looseObject({
    name: shortText(200, 'Nome e instruções são obrigatórios.'),
    system_prompt: z.string({ error: 'Nome e instruções são obrigatórios.' }).trim().min(1, 'Nome e instruções são obrigatórios.').max(MAX_ASSISTANT_PROFILE_CHARS, `As instruções podem ter no máximo ${MAX_ASSISTANT_PROFILE_CHARS} caracteres.`),
    emoji: z.string().trim().max(80).nullish(),
    color: z.string().trim().max(50).nullish(),
    model: modelId.nullish(),
    tools: assistantTools,
    personality: assistantPersonality,
  }),

  assistantUpdate: z.looseObject({
    name: z.string().trim().max(200).nullish(),
    system_prompt: z.string().max(MAX_ASSISTANT_PROFILE_CHARS, `As instruções podem ter no máximo ${MAX_ASSISTANT_PROFILE_CHARS} caracteres.`).nullish(),
    emoji: z.string().trim().max(80).nullish(),
    color: z.string().trim().max(50).nullish(),
    model: modelId.nullish(),
    tools: assistantTools,
    personality: assistantPersonality,
  }),

  client: z.looseObject({
    name: shortText(200, 'Nome do cliente é obrigatório.'),
  }),

  template: z.looseObject({
    name: shortText(200, 'Nome e conteúdo são obrigatórios.'),
    content: z.string({ error: 'Nome e conteúdo são obrigatórios.' }).trim().min(1, 'Nome e conteúdo são obrigatórios.').max(100_000),
  }),

  memoryCreate: z.looseObject({
    content: z.string({ error: 'Conteúdo vazio.' }).trim().min(1, 'Conteúdo vazio.')
      .max(100_000, 'O conteúdo é grande demais para uma memória (máximo de 100 mil caracteres). Divida em partes menores.'),
    type: z.enum(['perfil', 'preferencia', 'projeto', 'fato', 'manual']).optional(),
    scope: z.string().trim().max(150).optional(),
    importance: z.coerce.number().min(1).max(5).optional(),
    tags: z.string().max(500).nullish(),
  }),

  memoryUpdate: z.looseObject({
    content: z.string().trim().min(1, 'Conteúdo vazio.')
      .max(100_000, 'O conteúdo é grande demais para uma memória (máximo de 100 mil caracteres). Divida em partes menores.').optional(),
    type: z.enum(['perfil', 'preferencia', 'projeto', 'fato', 'manual']).optional(),
    scope: z.string().trim().max(150).optional(),
    importance: z.coerce.number().min(1).max(5).optional(),
    tags: z.string().max(500).nullish(),
  }),

  scheduleCreate: z.looseObject({
    title: shortText(200, 'Dê um nome e uma instrução para a rotina.'),
    prompt: z.string({ error: 'Dê um nome e uma instrução para a rotina.' }).trim().min(1, 'Dê um nome e uma instrução para a rotina.').max(100_000),
    cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
    day: z.coerce.number().optional(),
    hour: z.coerce.number().optional(),
    assistant_id: id.nullish(),
    model: modelId.nullish(),
    client_id: id.nullish(),
  }),

  accountDelete: z.looseObject({
    confirm: z.string().trim().max(320).optional(),
  }),

  // ---- Modo Design ---------------------------------------------------------
  // O conteúdo do artefato NUNCA chega pelo corpo da requisição: ele é sempre
  // produzido pelo modelo e validado por design/core.js. Aqui só entram o
  // pedido em linguagem natural e os metadados do projeto.
  designProjectCreate: z.looseObject({
    title: z.string().trim().max(DESIGN_MAX_TITLE_CHARS).optional(),
    outputType: z.enum(DESIGN_OUTPUT_TYPES, { message: 'Tipo de saída inválido.' }).optional(),
    designSystemId: id.nullish(),
    prompt: z.string().trim().max(DESIGN_MAX_PROMPT_CHARS, 'O pedido é grande demais. Resuma o que você precisa.').optional(),
    model: modelId.nullish(),
  }),

  designProjectUpdate: z.looseObject({
    title: z.string().trim().min(1, 'Dê um nome ao projeto.').max(DESIGN_MAX_TITLE_CHARS).optional(),
    designSystemId: id.nullish(),
  }),

  designGenerate: z.looseObject({
    prompt: z.string({ error: 'Descreva o que você quer.' }).trim().min(1, 'Descreva o que você quer.')
      .max(DESIGN_MAX_PROMPT_CHARS, 'O pedido é grande demais. Resuma o que você precisa.'),
    model: modelId.nullish(),
    // Edição inline: o elemento clicado na prévia. Os tetos aqui são só o
    // primeiro freio — o descritor vem de dentro do iframe (onde roda código
    // gerado por IA) e é normalizado de novo por `sanitizeTarget`.
    target: z.looseObject({
      tag: z.string().trim().max(40).nullish(),
      classes: z.string().max(300).nullish(),
      id: z.string().max(200).nullish(),
      caminho: z.string().max(400).nullish(),
      slide: z.coerce.number().nullish(),
      texto: z.string().max(1000).nullish(),
      html: z.string().max(4000).nullish(),
      truncado: z.coerce.boolean().nullish(),
    }).nullish(),
  }),

  // Ajustes finos: só as chaves do catálogo em design/tokens.js sobrevivem, e a
  // validação por tipo (hex / faixa numérica) acontece em `sanitizeAdjustments`.
  // Aqui garantimos apenas que veio um objeto pequeno de valores escalares.
  designAdjustments: z.looseObject({
    adjustments: z.record(
      z.string().max(40),
      z.union([z.string().max(40), z.number(), z.null()]),
    ).nullish(),
  }),

  designRevert: z.looseObject({
    versionId: shortText(120, 'Versão não informada.'),
  }),

  designSystem: z.looseObject({
    name: z.string().trim().max(80).optional(),
    primaryColor: z.string().trim().max(20).nullish(),
    secondaryColor: z.string().trim().max(20).nullish(),
    fontHeading: z.string().trim().max(60).nullish(),
    fontBody: z.string().trim().max(60).nullish(),
    notes: z.string().trim().max(2000).nullish(),
  }),
};
