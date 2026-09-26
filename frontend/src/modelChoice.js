// Resolução do modelo selecionado — PURA (testável), fonte única para o
// seletor principal, o assistente e a conversa reaberta.
//
// O catálogo (/api/models) identifica cada modelo por `<provedor>::<modelo>`.
// Parte do estado salvo, porém, ainda chega com o id "cru" (assistentes e
// conversas antigas gravavam só `deepseek-chat`). Antes, qualquer id que não
// batesse exatamente era trocado em silêncio pelo primeiro modelo da lista —
// e a próxima mensagem saía por outro modelo sem aviso nenhum.

export const MODEL_STORAGE_KEY = 'fred_model';

const SEPARATOR = '::';

// O catálogo identifica modelos por `<provedor>::<modelo>` (model_ref). Usar o
// `model` cru fazia o seletor não achar o modelo e, no envio, o backend
// escolher o primeiro provedor que listasse aquele id — ignorando a chave que o
// usuário fixou no assistente.
export function assistantModelRef(assistant) {
  return assistant?.model_ref || assistant?.model || '';
}

export function rawModelId(ref) {
  const value = String(ref || '').trim();
  const at = value.indexOf(SEPARATOR);
  return at > 0 ? value.slice(at + SEPARATOR.length) : value;
}

// Rótulo legível para um id que não está no catálogo: nunca mostra a
// referência interna `<provedor>::<modelo>` inteira.
export function modelDisplayName(models, ref) {
  const found = (models || []).find(m => m.id === ref);
  return found?.name || rawModelId(ref);
}

// Encontra o modelo do catálogo que corresponde ao id pedido: exato primeiro,
// depois pelo id cru — só quando ele é INEQUÍVOCO (um único provedor o
// oferece). Com dois provedores listando o mesmo id, adivinhar escolheria a
// chave errada; aí devolve null e quem chama decide com aviso.
export function matchModel(models, wanted) {
  const list = Array.isArray(models) ? models : [];
  const id = String(wanted || '').trim();
  if (!id) return null;
  const exact = list.find(m => m.id === id);
  if (exact) return exact;
  const raw = rawModelId(id);
  const byRaw = list.filter(m => (m.providerModelId || rawModelId(m.id)) === raw);
  return byRaw.length === 1 ? byRaw[0] : null;
}

// Decide o modelo efetivo. `candidates` em ordem de preferência (escolha
// salva, modelo do assistente...). Devolve `{ id, replaced, from }`:
// `replaced` = havia um pedido explícito que não existe mais no catálogo e
// foi substituído — a interface deve avisar (Regra 5.5: fallback explícito).
export function resolveModelChoice(models, candidates, { prefer } = {}) {
  const list = Array.isArray(models) ? models : [];
  const wanted = (Array.isArray(candidates) ? candidates : [candidates]).map(c => String(c || '').trim()).filter(Boolean);
  for (const id of wanted) {
    const hit = matchModel(list, id);
    if (hit) return { id: hit.id, replaced: false, from: null };
  }
  const fallback = (prefer ? list.find(prefer) : null) || list[0] || null;
  return {
    id: fallback?.id || '',
    replaced: wanted.length > 0 && Boolean(fallback),
    from: wanted[0] || null
  };
}

// Membros do multimodelo que existem no catálogo atual. Um membro salvo que
// aponta para provedor removido (ou o `{id:''}` que nascia com a lista vazia)
// contava como "pronto" e a execução falhava só no servidor.
export function multiModelStatus(config, models) {
  const ids = new Set((models || []).map(m => m.id));
  const members = Array.isArray(config?.models) ? config.models : [];
  const missing = members.filter(m => !m?.id || !ids.has(m.id)).map(m => m?.id || '');
  return { total: members.length, missing, ready: members.length >= 2 && missing.length === 0 };
}
