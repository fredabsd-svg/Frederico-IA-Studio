// Rotas de account — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { TERMS_VERSION, getLatestConsent, recordConsent, exportUserData, deleteAllConversations, deleteAccount } from '../privacy.js';
import { enabledSocialProviders } from '../auth.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, isAdmin, PC_FOLDERS_ENABLED, scheduleTimeZone } from './helpers.js';

const router = makeRouter();

// termsVersion: fonte ÚNICA da versão vigente dos Termos/Política (a página
// legal pública do frontend lê daqui — nada de manter a data em dois lugares).
router.get('/health', (_, res) => res.json({ ok: true, name: 'Frederico AI Studio', auth: true, scheduleTimeZone, socialProviders: enabledSocialProviders, termsVersion: TERMS_VERSION }));

// Dados do usuário logado + flags que a interface usa (ex.: mostrar o botão de
// backup só para o administrador; esconder "Pastas do PC" quando desligado).
router.get('/me', (req, res) => res.json({
  id: req.userId,
  email: req.user?.email || null,
  name: req.user?.name || null,
  isAdmin: isAdmin(req),
  pcFoldersEnabled: PC_FOLDERS_ENABLED
}));

// ---- LGPD: consentimento e direitos do titular (ver privacy.js) ----

// Situação do consentimento do usuário logado. needsConsent = ainda não aceitou
// a VERSÃO VIGENTE dos Termos/Política (usuário novo por login social, conta
// criada antes do recurso, ou termos atualizados).
router.get('/consent', async (req, res) => {
  const latest = await getLatestConsent(req.userId);
  res.json({
    requiredVersion: TERMS_VERSION,
    acceptedVersion: latest?.version || null,
    acceptedAt: latest?.accepted_at || null,
    needsConsent: latest?.version !== TERMS_VERSION,
  });
});

// Registra o aceite da versão vigente (com IP e navegador como evidência).
router.post('/consent', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
  await recordConsent(req.userId, { ip, userAgent: req.headers['user-agent'] || null });
  res.json({ ok: true, version: TERMS_VERSION });
});

// Portabilidade (art. 18, V): baixa TODOS os dados do usuário em JSON.
router.get('/account/export', async (req, res) => {
  const data = await exportUserData(req.userId, { ...req.user, createdAt: req.user?.createdAt });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="meus-dados-frederico-ia-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// Apaga TODO o histórico de conversas (art. 18, VI) — hard delete, incluindo
// mensagens, arquivos, memórias extraídas e workspaces em disco.
router.delete('/account/conversations', async (req, res) => {
  const { deleted, skipped } = await deleteAllConversations(req.userId);
  if (skipped) return res.status(409).json({ error: `${deleted} conversa(s) apagada(s), mas ${skipped} ainda estava(m) respondendo. Pare o processamento e tente de novo.`, deleted, skipped });
  res.json({ ok: true, deleted });
});

// Exclusão TOTAL da conta (art. 18, VI) — hard delete de tudo (banco + disco).
// Exige confirmação: o corpo precisa trazer o e-mail da própria conta.
router.delete('/account', validate(schemas.accountDelete), async (req, res) => {
  const confirm = String(req.body?.confirm || '').trim().toLowerCase();
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!confirm || confirm !== email) {
    return res.status(400).json({ error: 'Confirmação incorreta: digite o e-mail da sua conta para excluir.' });
  }
  const result = await deleteAccount(req.userId);
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ ok: true });
});

export default router;
