// Wrapper mínimo de JSON.parse que nunca joga — usado pelo classificador e
// por qualquer rota que precise ler JSON vindo do LLM sem derrubar o request.

export const JSONAttempt = {
  safeParse(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, value: null, error: 'input não é string ou é vazio' };
    }
    try {
      return { ok: true, value: JSON.parse(text), error: null };
    } catch (err) {
      return { ok: false, value: null, error: err?.message ?? String(err) };
    }
  },
};