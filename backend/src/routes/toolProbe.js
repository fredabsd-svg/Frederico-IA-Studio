// Rota admin para a sonda controlada de tool calling.
//
// POST /admin/tool-probe
//   Body: { scenarioIds?: string[], turns?: number, timeoutMs?: number, live?: boolean }
//   Resposta: { verdict, reason, totals, perMode, perScenario }
//
//   - live=true: chama o provider real (mais caro, mais útil).
//   - live=false (default): roda em dry-run; retorna 'text_only' com 0 runs
//     de tool_call (sanity check do pipeline).
//
// A rota registra 'admin.tool_probe.executed' em admin_audit para que a ação
// fique rastreável. Não tenta deduzir se o veredito é "bom" — isso é decisão
// de produto, não de auditoria.

import { runProbe } from '../tools/probe/probeRunner.js';
import { makeRouter, requireAdmin, recordAdminAction } from './helpers.js';

const router = makeRouter();

router.post('/admin/tool-probe', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const body = req.body ?? {};
  const scenarioIds = Array.isArray(body.scenarioIds) ? body.scenarioIds : undefined;
  const turns = Number.isFinite(body.turns) ? Number(body.turns) : undefined;
  const timeoutMs = Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : undefined;
  const live = body.live === true;

  // Modo live injeta o provider real. Sem rede/sem env vars válidas, o provider
  // vai jogar e o runner vai capturar como providerError (sem derrubar a rota).
  let providerFn = null;
  if (live) {
    try {
      const mod = await import('../provider.js');
      // A função exportada chama OpenAI-compat. Se o caller não quiser live,
      // basta omitir `live: true`.
      providerFn = async (messages, options) => {
        return await mod.generateOpenAICompatible({
          messages,
          model: options.model ?? process.env.DEFAULT_LLM ?? 'default',
          temperature: options.temperature ?? 0,
          maxTokens: options.maxTokens ?? 300,
          tools: options.tools,
        });
      };
    } catch (err) {
      // Provider indisponível neste ambiente: devolve erro claro em vez de 500.
      res.status(503).json({
        error: 'provider_indisponivel',
        detail: `não foi possível carregar provider.js: ${err?.message ?? String(err)}`,
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