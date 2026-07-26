// Apoio dos testes E2E: cria conta, liga o provedor falso e entrega o app
// já aberto e logado.
//
// Por que cada teste ganha uma CONTA NOVA: o app é multiusuário e tem teto de
// execuções simultâneas POR USUÁRIO (MAX_ACTIVE_RUNS_PER_USER). Compartilhar
// conta faria um teste esbarrar no outro e produziria falha intermitente —
// exatamente o tipo de teste que ninguém confia e todo mundo desliga.
import { test as base, expect } from '@playwright/test';

const PORTA_PROVEDOR = Number(process.env.E2E_PORTA_PROVEDOR || 4599);

let sequencia = 0;
function emailNovo() {
  // Único por processo E por execução: o banco de E2E não é limpo entre rodadas.
  sequencia += 1;
  return `e2e-${process.pid}-${sequencia}-${Math.floor(performance.now())}@teste.local`;
}

const SENHA = 'senha-de-teste-12345';

// Seletores da interface, num lugar só. Todos são acessíveis (rótulo, papel,
// placeholder) — se um deles quebrar, é porque a interface perdeu o rótulo, e
// isso é uma regressão de acessibilidade que vale ser apontada.
export const ui = {
  campoMensagem: /Peça para analisar arquivos|Pesquisa na internet ativada|Ouvindo/,
  botaoEnviar: 'Enviar',
  // Por CSS, e não por texto: uma conversa recém-criada também se chama "Nova
  // conversa" até ganhar título da primeira mensagem, e aí o texto casa com
  // dois elementos (o botão da barra lateral e a conversa na lista).
  botaoNovaConversa: '.sidebar button.new',
  mensagensAssistente: '.msg.assistant',
  mensagensUsuario: '.msg.user',
  conversaProcessando: '[aria-label="Conversa processando"]',
  itemConversa: '.convOpen'
};

// Cria a conta pela API e cadastra o provedor falso.
// `modelo` escolhe o COMPORTAMENTO do provedor (ver fixtures/provedorFalso.mjs);
// o catálogo fica com esse modelo só, então o app o seleciona sozinho e o teste
// não precisa operar o seletor de modelos.
export async function criarConta(request, { modelo = 'eco' } = {}) {
  const email = emailNovo();

  const cadastro = await request.post('/api/auth/sign-up/email', {
    data: { email, password: SENHA, name: 'Teste E2E' }
  });
  expect(cadastro.ok(), `falha ao criar a conta: ${cadastro.status()} ${await cadastro.text()}`).toBeTruthy();

  // Conta nova cai no portão de consentimento (LGPD) antes de qualquer coisa.
  // Aqui aceitamos pela API: o portão em si tem teste próprio (consentimento.spec.js);
  // nos demais ele seria só um clique repetido no caminho.
  const aceite = await request.post('/api/consent');
  expect(aceite.ok(), `falha ao registrar o consentimento: ${aceite.status()}`).toBeTruthy();

  const provedor = await request.post('/api/providers', {
    data: {
      providerType: 'custom',
      name: 'Provedor E2E',
      base_url: `http://127.0.0.1:${PORTA_PROVEDOR}/apenas/${modelo}/v1`,
      apiKey: 'chave-de-teste',
      model: modelo
    }
  });
  expect(provedor.ok(), `falha ao cadastrar o provedor: ${provedor.status()} ${await provedor.text()}`).toBeTruthy();
  const { provider } = await provedor.json();
  const modelRef = `${provider.id}::${modelo}`;

  // Fixa o modelo NO ASSISTENTE. Sem isto, os assistentes padrão nascem com
  // `deepseek/deepseek-chat` (id sem prefixo `<provedor>::`, gravado pelo
  // seed.js), o app manda esse id no chat e o provedor falso recebe um modelo
  // que não é o pedido pelo teste — foi assim que o teste da chave inválida
  // recebeu um eco normal em vez do 401.
  //
  // Vale registrar: esse default sem prefixo é a causa-raiz que CONTINUIDADE.md
  // lista como ainda aberta (o `rows[0]` de getUserProvider). O teste não a
  // corrige; só deixa de depender dela.
  // Atenção: GET /api/assistants devolve um ARRAY puro (não `{ assistants }`).
  // Os assistentes padrão são semeados sob demanda, na primeira requisição
  // autenticada (ensureUserSeeded) — o POST /api/consent acima já a fez.
  const lista = await request.get('/api/assistants');
  expect(lista.ok(), `falha ao listar assistentes: ${lista.status()}`).toBeTruthy();
  const assistants = await lista.json();
  expect(Array.isArray(assistants) && assistants.length, 'a conta nova deveria vir com assistentes padrão').toBeTruthy();

  for (const assistente of assistants) {
    const salvo = await request.put(`/api/assistants/${assistente.id}`, {
      data: {
        name: assistente.name,
        emoji: assistente.emoji || 'bot',
        color: assistente.color || null,
        model: modelRef,
        system_prompt: assistente.system_prompt || '',
        tools: assistente.tools || [],
        personality: assistente.personality || {}
      }
    });
    expect(salvo.ok(), `falha ao fixar o modelo do assistente: ${salvo.status()} ${await salvo.text()}`).toBeTruthy();
  }

  return { email, senha: SENHA, modelo, provedorId: provider.id, modelRef };
}

// Leva os cookies de sessão da API para o navegador e abre o app já logado.
export async function abrirLogado(page, request, conta) {
  const estado = await request.storageState();
  await page.context().addCookies(estado.cookies);
  await page.goto('/');
  // O app só monta depois de resolver a sessão; o compositor é o sinal de que
  // chegamos na tela de conversa (e não na landing).
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });
  return conta;
}

// Manda uma mensagem no compositor.
//
// Envia com Enter, e não com clique no botão, por dois motivos: é o caminho
// principal de quem usa ("Enter envia · Shift+Enter quebra linha", escrito
// embaixo do campo) e, a 1280px de largura, o avatar do Nino fica POR CIMA do
// botão de enviar — o Playwright recusa o clique porque o mascote intercepta o
// ponteiro. A sobreposição é um defeito de layout de verdade, anotado em
// CONTINUIDADE.md; usar Enter aqui não o esconde, só evita amarrar o teste a ele.
export async function enviar(page, texto) {
  const campo = page.getByPlaceholder(ui.campoMensagem);
  await campo.click();
  await campo.fill(texto);
  await campo.press('Enter');
}

// Texto da última resposta do assistente (vazio se ainda não há nenhuma).
export async function ultimaRespostaDoAssistente(page) {
  const balões = page.locator(ui.mensagensAssistente);
  if (await balões.count() === 0) return '';
  return (await balões.last().innerText()).trim();
}

export { base as test, expect };
