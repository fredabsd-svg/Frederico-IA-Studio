// Telemetria local de confiabilidade (Fase 66) — leitura das próprias execuções.
//
// Escopo: o USUÁRIO autenticado, nunca a instalação inteira. O painel admin da
// Frente 14 responde "quanto se consumiu"; esta rota responde "o trabalho deu
// certo", e a resposta é de quem fez o trabalho. Um agregado global aqui
// misturaria conversas de pessoas diferentes num número que ninguém pode agir
// — e exporia padrão de uso alheio sem necessidade.
//
// Só leitura, e nada sai da instalação: os números vêm de `agent_runs` e
// `agent_run_events`, que a Fase 17 já grava. Não há coleta nova.
import { db } from '../db.js';
import { collectReliability } from '../agent/reliability.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

// Conversas de um projeto do Modo Desenvolvedor (ADR 0004: a lista DERIVA de
// conversations.project_id). Escopada ao dono — projeto de outro usuário não
// devolve conversa nenhuma, em vez de devolver erro que confirma a existência.
async function conversationIdsForProject(userId, projectId) {
  const rows = await db.prepare('SELECT id FROM conversations WHERE user_id=? AND project_id=?')
    .all(userId, projectId);
  return rows.map(row => row.id);
}

router.get('/reliability', async (req, res) => {
  const dias = Number(req.query.dias) || 30;
  const projectId = typeof req.query.project === 'string' && req.query.project.trim()
    ? req.query.project.trim()
    : null;

  let conversationIds = null;
  if (projectId) {
    try {
      conversationIds = await conversationIdsForProject(req.userId, projectId);
    } catch (err) {
      console.error('[confiabilidade] conversas do projeto falharam:', err.message);
      conversationIds = [];
    }
  }

  const report = await collectReliability(req.userId, { dias, conversationIds });
  res.json({ ...report, projeto: projectId });
});

export default router;
