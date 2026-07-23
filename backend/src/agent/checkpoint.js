// Checkpoint de execução: persiste o ESTADO OPERACIONAL de um run do agente para
// permitir RETOMADA REAL (continuar de onde parou) quando a tarefa é
// interrompida por limite de ciclos, falha do provedor, watchdog de stream
// travado ou parada do usuário.
//
// A ideia central: o array `messages` do agente JÁ é o estado completo —
// objetivo (mensagem do usuário), plano e texto parcial (conteúdo do
// assistente), etapas e ferramentas usadas (assistant.tool_calls), resultados
// e erros (mensagens role:'tool'), decisões (conteúdo do assistente). Persistir
// esse array + o modelo ativo + a cadeia de failover já tentada é o suficiente
// para o modelo continuar do ponto exato, SEM repetir o trabalho: as ferramentas
// já executadas continuam no array como resultados, então o modelo não as chama
// de novo — parte para a próxima etapa pendente.
//
// Um checkpoint por CONVERSA (a unidade de retomada). Persistido no Postgres
// (migração 007), então sobrevive a um reinício do backend.
import { db, now } from '../db.js';

// Teto do tamanho serializado do checkpoint. Postgres/JSONB aguenta MBs, mas um
// array gigante (muitos resultados de ferramenta longos) é aparado mantendo o
// pareamento tool_call/tool_result válido (ver trimCheckpointMessages).
const MAX_CHECKPOINT_BYTES = Math.max(64_000, Number(process.env.CHECKPOINT_MAX_BYTES) || 600_000);

const byteLen = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');

// Motivos de interrupção que JUSTIFICAM salvar um checkpoint para retomada real.
// Limite de ciclos, falha/stall do provedor (o watchdog de stream cai aqui — o
// stall exaurido vira 'provider_failure') e parada do usuário com progresso.
// Falhas de QUALIDADE (degeneração, protocolo malformado) NÃO entram: ali o
// certo é reenviar do zero, não continuar o mesmo array problemático. É o MESMO
// mecanismo central para o limite de ciclos E para o watchdog (requisito 8).
const RESUMABLE_REASONS = new Set(['step_limit', 'provider_failure', 'stalled', 'stopped']);
export function isResumableReason(reason) { return RESUMABLE_REASONS.has(String(reason || '')); }

// Nota que orienta o modelo a CONTINUAR (não recomeçar) ao retomar. Anexada
// após o array do checkpoint. Mantida aqui (não no loop) para ser testável.
export const RESUME_CONTINUE_NOTE = 'VOCÊ ESTÁ RETOMANDO uma tarefa que foi pausada (limite de tempo/etapas ou instabilidade do provedor). O histórico acima é o SEU progresso real: as ferramentas já executadas, seus resultados e os arquivos criados estão registrados. Continue da PRÓXIMA etapa pendente para concluir o objetivo — não recomece do zero, não repita ferramentas já executadas nem refaça arquivos que já existem. Se já estava quase terminando, finalize e entregue o resultado.';

// Nota do FÔLEGO AUTOMÁTICO (loop.js): injetada quando o loop renova o
// orçamento de etapas NO MEIO do run (compactando o histórico se necessário),
// em vez de abortar uma tarefa que ainda está rendendo. Vive aqui ao lado da
// nota de retomada porque compartilham o mesmo contrato de continuidade.
export const AUTO_CONTINUE_NOTE = 'CONTINUE a tarefa em andamento (o orçamento de etapas foi renovado; parte do histórico intermediário pode ter sido compactada por tamanho). O que está acima é o seu progresso real: ferramentas já executadas, resultados e arquivos criados. Prossiga da PRÓXIMA etapa pendente — não recomece do zero, não repita ferramentas já executadas nem refaça arquivos que já existem. Se o objetivo já foi alcançado, finalize e entregue o resultado agora.';

// Monta o array de mensagens para o run de RETOMADA: o estado salvo + as notas
// de continuidade. Se a última mensagem for texto do assistente (parou no meio
// de um raciocínio), adiciona a nota de "continue de onde parou" para ele não
// reemitir; se parou logo após um resultado de ferramenta, o próximo turno já é
// a continuação natural. Puro (sem I/O) para poder ser testado isoladamente.
export function buildResumeMessages(checkpointMessages, { streamResumeNote = '', objective = '' } = {}) {
  const messages = Array.isArray(checkpointMessages) ? checkpointMessages.slice() : [];
  if (objective && !messages.some(message => message?.role === 'user')) {
    messages.splice(leadingSystemCount(messages), 0, { role: 'user', content: String(objective) });
  }
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && streamResumeNote) messages.push({ role: 'system', content: streamResumeNote });
  messages.push({ role: 'system', content: RESUME_CONTINUE_NOTE });
  return messages;
}

// Onde começa o prefixo de sistema (para o breakpoint de prompt caching):
// conta as mensagens role:'system' consecutivas no início do array.
export function leadingSystemCount(messages) {
  let n = 0;
  while (n < messages.length && messages[n]?.role === 'system') n += 1;
  return n;
}

// Apara o array de mensagens para caber em maxBytes SEM quebrar o protocolo:
// mantém o preâmbulo de sistema (mensagens role:'system' do início) + as
// mensagens mais RECENTES que couberem, e nunca deixa a cauda começar por uma
// mensagem role:'tool' órfã (um resultado de ferramenta exige o assistant com
// tool_calls antes dele). Uma nota de sistema sinaliza o trecho elidido.
export function trimCheckpointMessages(messages, maxBytes = MAX_CHECKPOINT_BYTES, objective = '') {
  const arr = Array.isArray(messages) ? messages.slice() : [];
  if (byteLen(arr) <= maxBytes) return arr;

  // 1) Separa o preâmbulo de sistema do início (prompt-base, notas, memória).
  let headEnd = 0;
  while (headEnd < arr.length && arr[headEnd].role === 'system') headEnd += 1;
  const head = arr.slice(0, headEnd);
  const rest = arr.slice(headEnd);

  const note = { role: 'system', content: '[continuidade: parte do histórico intermediário desta execução foi omitida por tamanho; o objetivo, os resultados recentes das ferramentas e o estado atual estão preservados abaixo]' };
  const objectiveNote = objective
    ? { role: 'user', content: `[objetivo original preservado pelo checkpoint]\n${String(objective).slice(0, 12000)}` }
    : null;
  let budget = maxBytes - byteLen(head) - byteLen(note) - (objectiveNote ? byteLen(objectiveNote) : 0);

  // 2) Acumula do FIM para o começo enquanto couber.
  const tail = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const size = byteLen(rest[i]);
    if (size > budget && tail.length) break;
    tail.unshift(rest[i]);
    budget -= size;
    if (budget <= 0) break;
  }

  // 3) Remove mensagens 'tool' órfãs no INÍCIO da cauda (sem o assistant que as
  // originou, a API rejeita). Também remove um assistant com tool_calls que
  // ficou SEM nenhum resultado logo em seguida seria um problema, mas como
  // cortamos pelo fim, os resultados dos tool_calls mantidos já estão na cauda.
  while (tail.length && tail[0].role === 'tool') tail.shift();

  const trimmed = [...head, note, ...(objectiveNote ? [objectiveNote] : []), ...tail];
  return byteLen(trimmed) <= maxBytes ? trimmed : [...head, note, ...(objectiveNote ? [objectiveNote] : []), ...tail.slice(-40)];
}

// Grava (upsert) o checkpoint da conversa. `messages` é o array completo do
// agente no momento da interrupção. Aparado se exceder o teto.
export async function saveCheckpoint({ userId, conversationId, runId, objective, reason, model, triedModels, step, messages, usage, meta }) {
  if (!conversationId || !userId || !Array.isArray(messages) || !messages.length) return false;
  const safeMessages = trimCheckpointMessages(messages, MAX_CHECKPOINT_BYTES, objective);
  const t = now();
  try {
    await db.prepare(`
      INSERT INTO execution_checkpoints
        (conversation_id, user_id, run_id, objective, reason, model, tried_models, step, messages, usage, meta, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (conversation_id) DO UPDATE SET
        run_id=EXCLUDED.run_id, objective=EXCLUDED.objective, reason=EXCLUDED.reason,
        model=EXCLUDED.model, tried_models=EXCLUDED.tried_models, step=EXCLUDED.step,
        messages=EXCLUDED.messages, usage=EXCLUDED.usage, meta=EXCLUDED.meta,
        updated_at=EXCLUDED.updated_at
    `).run(
      conversationId, userId, runId || '', objective || null, reason || null,
      model || null, JSON.stringify(triedModels || []), Number.isFinite(step) ? step : null,
      JSON.stringify(safeMessages), JSON.stringify(usage || {}), JSON.stringify(meta || {}), t, t
    );
    return true;
  } catch (err) {
    console.error('[checkpoint] falha ao salvar:', err.message);
    return false;
  }
}

// Carrega o checkpoint da conversa (ou null). Faz o parse defensivo dos campos
// JSON (o driver pg já devolve JSONB como objeto, mas TEXT vinha como string —
// tratamos os dois).
export async function loadCheckpoint(userId, conversationId) {
  if (!userId || !conversationId) return null;
  let row;
  try {
    row = await db.prepare('SELECT * FROM execution_checkpoints WHERE conversation_id=? AND user_id=?').get(conversationId, userId);
  } catch (err) {
    console.error('[checkpoint] falha ao carregar:', err.message);
    return null;
  }
  if (!row) return null;
  const parse = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  const messages = parse(row.messages, null);
  if (!Array.isArray(messages) || !messages.length) return null;
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    runId: row.run_id,
    objective: row.objective || '',
    reason: row.reason || '',
    model: row.model || null,
    triedModels: parse(row.tried_models, []),
    step: row.step || 0,
    messages,
    usage: parse(row.usage, {}),
    meta: parse(row.meta, {}),
    updatedAt: row.updated_at
  };
}

// Existe checkpoint para esta conversa? (barato — não traz o array de mensagens)
export async function hasCheckpoint(userId, conversationId) {
  if (!userId || !conversationId) return false;
  try {
    const row = await db.prepare('SELECT 1 FROM execution_checkpoints WHERE conversation_id=? AND user_id=?').get(conversationId, userId);
    return Boolean(row);
  } catch { return false; }
}

// Remove o checkpoint (chamado quando o run conclui de forma limpa — não há mais
// o que retomar).
export async function clearCheckpoint(conversationId) {
  if (!conversationId) return;
  try {
    await db.prepare('DELETE FROM execution_checkpoints WHERE conversation_id=?').run(conversationId);
  } catch (err) {
    console.error('[checkpoint] falha ao limpar:', err.message);
  }
}
