// Chamada JSON à API que NÃO engole erro.
//
// Por que existe: vários painéis faziam `await fetch(...)` e mostravam o aviso
// de sucesso sem olhar `res.ok` — um 4xx/5xx virava "Rotina disparada" ou
// "Modo gratuito ativado!", e o `catch {}` vazio escondia a queda de rede. A
// interface precisa refletir o backend (REGRAS-DO-PROJETO.md §8.1), então este
// atalho lança `Error` com a mensagem do backend (`{ error }`) ou `HTTP <status>`
// quando a resposta não é 2xx. Quem chama decide o texto do aviso.
//
// Sem import de `constants.js` de propósito: aquele módulo lê `import.meta.env`
// (Vite) e este precisa rodar no `node --test`. Quem chama monta a URL com API.

// Lê o corpo como JSON sem explodir quando ele vem vazio ou em texto puro
// (proxy devolvendo HTML de erro, 204 sem corpo...).
async function readBody(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function apiJson(url, options = {}, fetchImpl = globalThis.fetch) {
  const init = { ...options };
  // Objeto simples no body vira JSON com o cabeçalho certo; string/FormData passam intactos.
  if (init.body && typeof init.body === 'object' && !(init.body instanceof FormData) && !(init.body instanceof Blob)) {
    init.body = JSON.stringify(init.body);
    init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  }
  const res = await fetchImpl(url, init);
  const data = await readBody(res);
  if (!res.ok) {
    const message = (data && typeof data.error === 'string' && data.error.trim()) || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// Texto de aviso a partir de um erro de `apiJson` (ou de rede), com um prefixo
// que diz O QUE falhou. A queda de rede do navegador ("Failed to fetch") não
// ajuda ninguém: vira uma frase em português.
export function apiErrorMessage(error, prefix) {
  const raw = error?.message || '';
  const detail = /failed to fetch|networkerror|load failed/i.test(raw) ? 'sem conexão com o servidor' : raw;
  if (!prefix) return detail || 'Algo deu errado.';
  return detail ? `${prefix}: ${detail}` : prefix;
}
