// Validação estruturada de corpo de requisição com zod, num só lugar.
//
// Os schemas são "loose" (z.looseObject): campos desconhecidos passam adiante
// sem serem removidos — o objetivo aqui é garantir TIPO e TAMANHO dos campos
// que o backend realmente usa (e mensagens de erro consistentes), não travar a
// evolução do frontend. Checagens de NEGÓCIO (posse, duplicidade, limites por
// plano) continuam nos handlers.
import { z } from 'zod/v4';
import { ASSISTANT_TOOL_NAMES, MAX_ASSISTANT_PROFILE_CHARS } from './agent/assistantPolicy.js';

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
};
