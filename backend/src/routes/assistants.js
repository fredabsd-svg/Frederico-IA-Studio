// Rotas de assistants — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, loadAssistant, safeParse } from './helpers.js';
import { resolveDefaultModelRef } from '../defaults.js';
import { resolveBareModelToRef } from '../userProvider.js';
import { parseModelRef } from '../modelRef.js';

const router = makeRouter();

// O frontend envia o `model` como id do catálogo (ex.: "deepseek/deepseek-chat"
// no formato OpenRouter ou "deepseek-chat" no formato nativo). Aqui calculamos
// a referência completa `<provedor>::<modelo>` para guardar em `model_ref` —
// é o que `getUserProvider` consulta para evitar o chute silencioso do `rows[0]`
// (causa-raiz do 401 do PR #140). Quando o id é já uma modelRef completa
// (caso de integrações server-to-server), devolvemos como está.
async function resolveAssistantModelRef(userId, rawModel) {
  const bareModel = String(rawModel || resolveDefaultModelRef()).trim();
  if (!bareModel) return { model: bareModel, modelRef: null };
  const parsed = parseModelRef(bareModel);
  if (parsed.providerId) {
    // Já é um modelRef completo: gravamos como `model` o modelId cru para a
    // UI exibir o nome amigável, e `model_ref` com a referência cheia.
    return { model: parsed.modelId, modelRef: bareModel };
  }
  const ref = await resolveBareModelToRef(userId, bareModel);
  return { model: bareModel, modelRef: ref || null };
}

// ---- Assistentes (Assistant Studio) ----
router.get('/assistants', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM assistants WHERE user_id=? ORDER BY created_at ASC').all(req.userId))
    .map(a => ({ ...a, tools: safeParse(a.tools, []), personality: safeParse(a.personality, {}) })));
});

router.post('/assistants', validate(schemas.assistantCreate), async (req, res) => {
  const b = req.body; // nome e instruções garantidos por validate(schemas.assistantCreate)
  const id = nanoid();
  const t = now();
  const { model, modelRef } = await resolveAssistantModelRef(req.userId, b.model);
  await db.prepare('INSERT INTO assistants (id,user_id,name,emoji,color,model,model_ref,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, b.name.trim(), b.emoji || 'bot', b.color || null, model, modelRef, b.system_prompt, JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), t, t);
  res.json(await loadAssistant(req.userId, id));
});

router.put('/assistants/:id', validate(schemas.assistantUpdate), async (req, res) => {
  const b = req.body || {};
  const existing = await db.prepare('SELECT id, model, model_ref FROM assistants WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  // `model` não enviado (undefined) → mantém o que está gravado (a UI manda
  // só os campos alterados). Vazio/null → "solta" a fixação, devolve o
  // assistente ao modelo padrão do app.
  let nextModel = existing.model;
  let nextRef = existing.model_ref;
  if (b.model !== undefined) {
    const trimmed = String(b.model || '').trim();
    if (!trimmed) {
      nextModel = resolveDefaultModelRef();
      const ref = await resolveAssistantModelRef(req.userId, nextModel);
      nextModel = ref.model;
      nextRef = ref.modelRef;
    } else {
      const resolved = await resolveAssistantModelRef(req.userId, trimmed);
      nextModel = resolved.model;
      nextRef = resolved.modelRef;
    }
  }
  await db.prepare('UPDATE assistants SET name=?, emoji=?, color=?, model=?, model_ref=?, system_prompt=?, tools=?, personality=?, updated_at=? WHERE id=? AND user_id=?')
    .run(b.name?.trim() || 'Assistente', b.emoji || 'bot', b.color || null, nextModel, nextRef, b.system_prompt || '', JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), now(), req.params.id, req.userId);
  res.json(await loadAssistant(req.userId, req.params.id));
});

router.delete('/assistants/:id', async (req, res) => {
  const r = await db.prepare('DELETE FROM assistants WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ ok: true });
});

export default router;
