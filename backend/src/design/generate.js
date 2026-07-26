// Chamada ao provedor de IA para gerar/editar um artefato de design.
//
// Fica separada da rota para que o caminho crítico — pedido → artefato válido —
// tenha um contrato só: `{ ok, content, usage, model }` ou `{ ok:false, error }`
// com mensagem já escrita para o usuário. Nada aqui toca o banco.
import { getUserProvider } from '../userProvider.js';
import { buildGenerateMessages, extractArtifact, MAX_EDIT_CONTEXT_CHARS } from './core.js';

// Teto de saída. Vários provedores compatíveis com a OpenAI default para 4096
// tokens quando o campo não é enviado — o que corta uma página HTML inteira ao
// meio e devolveria um artefato quebrado como se fosse bom.
const MAX_TOKENS = Math.max(1024, Number(process.env.DESIGN_MAX_TOKENS || 8000));
const TIMEOUT_MS = Math.max(30_000, Number(process.env.DESIGN_GENERATE_TIMEOUT_MS || 180_000));
const TEMPERATURE = Number(process.env.DESIGN_TEMPERATURE ?? 0.6);

export const NO_KEY_MSG =
  'Nenhum provedor de IA configurado. Adicione uma chave em Configurações › Provedor de IA para usar o Modo Design.';

export async function generateArtifact({
  userId, outputType, prompt, current = '', designSystem = null, history = [], model = '', target = null,
}) {
  if (String(current || '').length > MAX_EDIT_CONTEXT_CHARS) {
    return {
      ok: false,
      error: 'Este design ficou grande demais para ser editado por conversa. Crie um projeto novo a partir do resultado atual ou peça uma versão mais enxuta.',
    };
  }

  const provider = await getUserProvider(userId, model);
  if (!provider.hasKey || !provider.client) return { ok: false, error: NO_KEY_MSG };

  const messages = buildGenerateMessages({ outputType, prompt, current, designSystem, history, target });

  let completion;
  try {
    completion = await provider.client.chat.completions.create(
      { model: provider.model, messages, temperature: TEMPERATURE, max_tokens: MAX_TOKENS },
      { timeout: TIMEOUT_MS },
    );
  } catch (err) {
    console.error('[design] falha na geração:', err?.message);
    const status = err?.status || err?.response?.status;
    if (status === 401 || status === 403) {
      return { ok: false, error: `A chave do provedor ${provider.providerName || ''} foi recusada. Confira em Configurações › Provedor de IA.`.replace('  ', ' ') };
    }
    return { ok: false, error: 'Não consegui falar com o provedor de IA agora. Tente de novo em instantes.' };
  }

  const choice = completion?.choices?.[0];
  const raw = String(choice?.message?.content || '').trim();

  // Resposta cortada por limite de tokens: o artefato pode até "parecer" HTML,
  // mas está incompleto. Falhar aqui é melhor do que gravar uma versão quebrada
  // — o usuário perderia o preview bom que já tinha.
  if (choice?.finish_reason === 'length') {
    return {
      ok: false,
      error: 'O modelo atingiu o limite de tamanho antes de terminar o design. Peça algo mais enxuto ou use um modelo com saída maior.',
    };
  }

  const artifact = extractArtifact(raw, outputType);
  if (!artifact.ok) return { ok: false, error: `${artifact.error} Tente reformular o pedido.` };

  return {
    ok: true,
    content: artifact.content,
    usage: completion?.usage || null,
    model: completion?.model || provider.model,
  };
}
