// Validação estruturada de corpo de requisição com zod, num só lugar.
//
// Os schemas são "loose" (z.looseObject): campos desconhecidos passam adiante
// sem serem removidos — o objetivo aqui é garantir TIPO e TAMANHO dos campos
// que o backend realmente usa (e mensagens de erro consistentes), não travar a
// evolução do frontend. Checagens de NEGÓCIO (posse, duplicidade, limites por
// plano) continuam nos handlers.
import { z } from 'zod';

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
const modelId = z.string().trim().max(200);
const shortText = (max, msg) => z.string({ error: msg }).trim().min(1, msg).max(max);

export const schemas = {
  chat: z.looseObject({
    message: z.string({ error: 'Mensagem vazia.' }).trim().min(1, 'Mensagem vazia.').max(100_000, 'A mensagem é grande demais. Envie em partes menores.'),
    model: modelId.nullish(),
    assistantId: id.nullish(),
    orchestrateIds: z.array(id).max(20).optional(),
    effort: z.string().trim().max(30).nullish(),
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
    system_prompt: z.string({ error: 'Nome e instruções são obrigatórios.' }).trim().min(1, 'Nome e instruções são obrigatórios.').max(200_000),
    emoji: z.string().trim().max(80).nullish(),
    color: z.string().trim().max(50).nullish(),
    model: modelId.nullish(),
    tools: z.array(z.string().max(100)).max(50).optional(),
    personality: z.record(z.string(), z.unknown()).optional(),
  }),

  assistantUpdate: z.looseObject({
    name: z.string().trim().max(200).nullish(),
    system_prompt: z.string().max(200_000).nullish(),
    emoji: z.string().trim().max(80).nullish(),
    color: z.string().trim().max(50).nullish(),
    model: modelId.nullish(),
    tools: z.array(z.string().max(100)).max(50).optional(),
    personality: z.record(z.string(), z.unknown()).optional(),
  }),

  client: z.looseObject({
    name: shortText(200, 'Nome do cliente é obrigatório.'),
  }),

  template: z.looseObject({
    name: shortText(200, 'Nome e conteúdo são obrigatórios.'),
    content: z.string({ error: 'Nome e conteúdo são obrigatórios.' }).trim().min(1, 'Nome e conteúdo são obrigatórios.').max(100_000),
  }),

  memoryCreate: z.looseObject({
    content: shortText(20_000, 'Conteúdo vazio.'),
    type: z.enum(['perfil', 'preferencia', 'projeto', 'fato', 'manual']).optional(),
    scope: z.string().trim().max(150).optional(),
    importance: z.coerce.number().min(1).max(5).optional(),
    tags: z.string().max(500).nullish(),
  }),

  memoryUpdate: z.looseObject({
    content: z.string().trim().min(1, 'Conteúdo vazio.').max(20_000).optional(),
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
