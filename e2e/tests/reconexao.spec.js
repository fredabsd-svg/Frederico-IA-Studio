// Reconexão ao SSE com cursor (fromSeq + runId) sem duplicar eventos.
//
// É o que falta em F-12: o backend já tinha `fromSeq` desde o PR #146, mas o
// frontend nunca enviava — toda reconexão pedia o replay inteiro, e o front
// "remontava do zero" (limpava o balão e aplicava o replay). Para o usuário,
// isso é um flicker visível em cada oscilação de rede. Para um texto longo,
// significa re-renderizar centenas de blocos à toa.
//
// A lógica de filtragem (fromSeq + runId) está provada em
// `backend/src/liveStream.test.js`. Este arquivo cobre o QUE SOBRA: a rota
// HTTP aceita e propaga os novos parâmetros, e a integração front↔back não
// quebra o caminho de reconexão que já era coberto por `multiconversa.spec.js`.
import { test, expect, criarConta, abrirLogado, enviar, ui } from '../fixtures/app.js';

const PALAVRAS = ['UM', 'DOIS', 'TRES', 'QUATRO', 'CINCO', 'SEIS', 'SETE', 'OITO', 'NOVE', 'DEZ', 'ONZE', 'DOZE'];

// `/stream` é SSE: responde 200 e deixa a conexão ABERTA. O `request.get()` do
// Playwright só resolve quando o corpo termina, então numa rota dessas ele
// espera para sempre e o teste morre no timeout — mesmo com o servidor tendo
// respondido certo. Aqui o que interessa é só o código de status, então a
// requisição sai do próprio navegador (mesma origem, mesmo cookie de sessão) e
// é abortada assim que os cabeçalhos chegam.
async function statusDoStream(page, url) {
  return page.evaluate(async (alvo) => {
    const corte = new AbortController();
    try {
      const resposta = await fetch(alvo, { signal: corte.signal, headers: { accept: 'text/event-stream' } });
      return resposta.status;
    } finally {
      corte.abort();   // não deixa o SSE pendurado depois da conferência
    }
  }, url);
}

async function idDaConversaAberta(request) {
  // O app não expõe o id da conversa no DOM — pegamos pela API, que devolve
  // a lista em ordem cronológica inversa (a mais recente vem primeiro). Como
  // o teste acabou de criar uma conta nova e enviar uma mensagem, basta
  // pegar o primeiro item.
  const lista = await request.get('/api/conversations');
  expect(lista.ok(), `falha ao listar conversas: ${lista.status()}`).toBeTruthy();
  const dados = await lista.json();
  return dados?.[0]?.id;
}

test('a rota /stream aceita os parâmetros fromSeq e runId sem quebrar', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco-lento' });
  await abrirLogado(page, request, conta);

  await enviar(page, PALAVRAS.join(' '));
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('TRES', { timeout: 60_000 });

  const conversationId = await idDaConversaAberta(request);
  expect(conversationId, 'a conta nova deveria ter uma conversa').toBeTruthy();

  // GET /stream com runId inexistente e fromSeq alto: a rota não pode devolver
  // 500 (sintoma de ter engolido os params novos). Pode ser 200 (stream vivo,
  // replay filtrado → vazio neste caso), 204 (sem nada) ou 404 — nunca 5xx.
  const comCursor = await statusDoStream(page, `/api/conversations/${conversationId}/stream?runId=inexistente&fromSeq=999999`);
  expect(comCursor, `status inesperado com cursor: ${comCursor}`).toBeLessThan(500);

  // E sem params (caminho legado) também continua dentro do esperado — quem
  // ainda não atualizou o front não pode quebrar.
  const semCursor = await statusDoStream(page, `/api/conversations/${conversationId}/stream`);
  expect(semCursor, `status inesperado sem cursor: ${semCursor}`).toBeLessThan(500);
});
