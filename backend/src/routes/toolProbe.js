// Rota admin para a sonda controlada de tool calling.
//
// POST /admin/tool-probe
//   Body: { scenarioIds?: string[], turns?: number, timeoutMs?: number,
//           live?: boolean, modelRef?: string }
//   Resposta: { verdict, reason, totals, perMode, perScenario }
//
//   - live=true: chama o provedor do próprio administrador (mais caro, mais
//     útil); `modelRef` escolhe um modelo específico da conta dele.
//   - live=false (default): roda em dry-run; retorna 'text_only' com 0 runs
//     de tool_call (sanity check do pipeline).
//
// A rota registra 'admin.tool_probe.executed' em admin_audit para que a ação
// fique rastreável. Não tenta deduzir se o veredito é "bom" — isso é decisão
// de produto, não de auditoria.

import { runProbe } from '../tools/probe/probeRunner.js';
import { providerDeCliente, SondaSemProvedor } from '../tools/probe/provider.js';
import { getUserProvider } from '../userProvider.js';
import { makeRouter, requireAdmin, recordAdminAction } from './helpers.js';

const router = makeRouter();

router.post('/admin/tool-probe', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const body = req.body ?? {};
  const scenarioIds = Array.isArray(body.scenarioIds) ? body.scenarioIds : undefined;
  const turns = Number.isFinite(body.turns) ? Number(body.turns) : undefined;
  const timeoutMs = Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : undefined;
  const live = body.live === true;

  // Modo live usa o provedor do PRÓPRIO administrador — o mesmo `getUserProvider`
  // que serve o chat —, então a sonda mede o provedor que ele de fato usa. O
  // `modelRef` opcional permite sondar um modelo específico da conta.
  //
  // Antes, este trecho importava `../provider.js` e chamava
  // `generateOpenAICompatible`: nenhum dos dois existe, então `live: true`
  // devolvia 503 sempre. Se o caller não quiser live, basta omitir `live: true`.
  let providerFn = null;
  if (live) {
    try {
      const provider = await getUserProvider(req.userId, String(body.modelRef || ''));
      if (!provider?.hasKey) {
        res.status(503).json({
          error: 'provider_indisponivel',
          detail: 'nenhum provedor de IA configurado para este administrador — cadastre a chave em Configurações.',
        });
        return;
      }
      providerFn = providerDeCliente({ client: provider.client, model: provider.model });
    } catch (err) {
      const semProvedor = err instanceof SondaSemProvedor;
      res.status(semProvedor ? 503 : 500).json({
        error: semProvedor ? 'provider_indisponivel' : 'probe_falhou',
        detail: err?.message ?? String(err),
      });
      return;
    }
  }

  let result;
  try {
    result = await runProbe({ providerFn, scenarioIds, turns, timeoutMs });
  } catch (err) {
    res.status(500).json({
      error: 'probe_falhou',
      detail: err?.message ?? String(err),
    });
    return;
  }

  await recordAdminAction(req, 'admin.tool_probe.executed', {
    verdict: result.verdict,
    live,
    scenarios: scenarioIds ?? 'all',
    turns: turns ?? 'default',
  });

  res.json(result);
});

export default router;