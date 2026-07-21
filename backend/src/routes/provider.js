// Rotas de provider — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import OpenAI from 'openai';
import { db, now } from '../db.js';
import { encryptSecret, decryptSecret, maskSecret } from '../crypto.js';
import { getUserProvider } from '../userProvider.js';
import { friendlyApiError } from '../agent.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

// ---- BYOK: provedor de IA por usuário (chave própria, cifrada) ----
// GET nunca devolve a chave inteira — só uma máscara e o estado.
router.get('/provider', async (req, res) => {
  const row = await db.prepare('SELECT api_key_enc, base_url, model FROM user_settings WHERE user_id=?').get(req.userId);
  let keyMask = '';
  if (row?.api_key_enc) { const dec = decryptSecret(row.api_key_enc); keyMask = dec ? maskSecret(dec) : ''; }
  const prov = await getUserProvider(req.userId);
  res.json({
    hasKey: prov.hasKey, source: prov.source, keyMask,
    base_url: row?.base_url || '', model: row?.model || '',
    // Modo gratuito ativo: o front mostra provedor/modelo da plataforma.
    ...(prov.source === 'free' ? { freeProvider: prov.providerName, freeModel: prov.model, freeModels: prov.freeModels } : {})
  });
});

// PUT salva/atualiza. apiKey ausente = mantém a atual; apiKey '' = remove.
router.put('/provider', async (req, res) => {
  const b = req.body || {};
  try {
    const existing = await db.prepare('SELECT api_key_enc FROM user_settings WHERE user_id=?').get(req.userId);
    let api_key_enc = existing?.api_key_enc || null;
    if (b.apiKey !== undefined) api_key_enc = String(b.apiKey).trim() ? encryptSecret(String(b.apiKey).trim()) : null;
    const base_url = (b.base_url || '').trim() || null;
    const model = (b.model || '').trim() || null;
    const t = now();
    await db.prepare(`INSERT INTO user_settings (user_id, api_key_enc, base_url, model, created_at, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT (user_id) DO UPDATE SET api_key_enc=excluded.api_key_enc, base_url=excluded.base_url, model=excluded.model, updated_at=excluded.updated_at`)
      .run(req.userId, api_key_enc, base_url, model, t, t);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Não foi possível salvar. Verifique se a ENCRYPTION_KEY está configurada no servidor.' });
  }
});

// POST testa a chave com uma chamada leve (lista de modelos).
router.post('/provider/test', async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  const baseURL = String(req.body?.base_url || '').trim() || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  let client;
  if (apiKey) {
    // Testa a chave que a pessoa acabou de digitar (ainda não salva).
    client = new OpenAI({ apiKey, baseURL });
  } else {
    // Sem chave nova no corpo: testa a configuração já salva.
    const prov = await getUserProvider(req.userId);
    client = prov.client;
  }
  if (!client) return res.status(400).json({ ok: false, error: 'Nenhuma chave configurada.' });
  try { await client.models.list(); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: friendlyApiError(e) }); }
});

export default router;
