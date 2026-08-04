// Provedor de modelo FALSO, compatível com a API da OpenAI.
//
// Existe para os testes E2E não dependerem de rede, de chave paga nem do
// humor do provedor de verdade: a resposta é determinística e o ritmo do
// streaming é controlado pelo teste. É o "provedor HTTP simulado" que a
// auditoria pedia (docs/AUDITORIA_2026-07.md §6, item 2).
//
// O COMPORTAMENTO É ESCOLHIDO PELO ID DO MODELO — não há endpoint de controle,
// então o servidor é sem estado e vários testes podem usá-lo ao mesmo tempo:
//
//   eco          → devolve o texto da última mensagem do usuário, token a token
//   eco-lento    → o mesmo, com pausa entre tokens (dá tempo de trocar de
//                  conversa/derrubar a conexão no meio do stream)
//   chave-ruim   → responde 401, como uma chave inválida
//   ferramentas  → responde com uma tool_call (bash echo) na primeira rodada e,
//                  quando recebe o resultado da ferramenta, devolve texto.
//                  Exercita o caminho de tool_calls no streaming e na conversa.
//   travado      → abre o stream, envia apenas o delta inicial e fica em silêncio.
//                  Força o watchdog do backend a detectar o stall e disparar a
//                  recuperação (aviso de provedor indisponível).
//
// O modelo `travado` é parametrizável: o teste define STREAM_STALL_TIMEOUT_MS
// baixo (em playwright.config.js) para que o watchdog encerre em ~2s em vez
// dos 180s padrão — uma espera dessas tornaria o teste E2E inviável.
//
// Ecoar a mensagem do usuário é o que permite provar que não há vazamento entre
// conversas: o teste manda "ALFA" numa e "BETA" noutra e cobra que cada uma só
// mostre o seu.
import http from 'node:http';

const MODELOS = ['eco', 'eco-lento', 'chave-ruim', 'ferramentas', 'travado', 'design-web', 'design-slides'];
const PAUSA_LENTA_MS = Number(process.env.E2E_PAUSA_TOKEN_MS || 250);

const dorme = (ms) => new Promise(r => setTimeout(r, ms));

// Respostas do Modo Design. Ele chama o provedor SEM streaming e espera um
// artefato pronto: documento HTML completo (web/document) ou JSON de slides.
// A resposta vem propositalmente "suja" — com conversa em volta e cerca de
// código —, que é como os modelos reais respondem: é justamente a limpeza que
// o teste precisa exercitar.
// O bloco `:root` com as variáveis `--fred-*` não é enfeite: é o contrato que o
// system prompt exige das saídas HTML e é dele que a interface deriva os
// controles de ajuste (backend/src/design/tokens.js). Sem ele aqui, o teste dos
// sliders não teria o que ajustar.
const HTML_DESIGN = [
  '<!DOCTYPE html>',
  '<html lang="pt-BR"><head><meta charset="utf-8"><title>Landing E2E</title>',
  '<style>',
  ':root{--fred-cor-primaria:#1f3b8a;--fred-cor-secundaria:#e8523f;--fred-fonte-base:16px;--fred-raio:12px}',
  'body{font-family:Arial,sans-serif;margin:0}',
  'h1{color:var(--fred-cor-primaria);padding:40px;font-size:calc(var(--fred-fonte-base) * 2.4)}',
  'p{padding:0 40px}',
  '</style>',
  '</head><body><h1 id="titulo-e2e">Contabilidade sem sustos</h1>',
  '<p id="texto-e2e">Fechamento em dois dias.</p></body></html>'
].join('\n');

const RESPOSTAS_DESIGN = {
  'design-web': `Claro! Segue a página:\n\n\`\`\`html\n${HTML_DESIGN}\n\`\`\`\n\nQualquer ajuste é só pedir.`,
  'design-slides': JSON.stringify({
    slides: [
      { layout: 'title', title: 'Proposta E2E', body: 'Frederico IA Studio', notes: '' },
      { layout: 'content', title: 'Escopo', body: '- Escrituração\n- Folha', notes: 'falar devagar' }
    ]
  })
};

function json(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texto) });
  res.end(texto);
}

function chaveDaRequisicao(req) {
  const cabecalho = String(req.headers.authorization || '');
  return cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
}

async function lerCorpo(req) {
  const partes = [];
  for await (const parte of req) partes.push(parte);
  if (!partes.length) return {};
  try { return JSON.parse(Buffer.concat(partes).toString('utf8')); } catch { return {}; }
}

// Último texto que o usuário mandou — é o que o eco devolve.
function ultimaMensagemDoUsuario(mensagens) {
  const lista = Array.isArray(mensagens) ? mensagens : [];
  for (let i = lista.length - 1; i >= 0; i--) {
    const m = lista[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    // Conteúdo multimodal: junta só as partes de texto.
    if (Array.isArray(m.content)) {
      return m.content.filter(p => p?.type === 'text').map(p => p.text).join(' ');
    }
  }
  return '';
}

function pedacoSSE(res, modelo, delta, finish = null) {
  const evento = {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: modelo,
    choices: [{ index: 0, delta, finish_reason: finish }]
  };
  res.write(`data: ${JSON.stringify(evento)}\n\n`);
}

async function responderStream(req, res, corpo) {
  const modelo = String(corpo.model || 'eco');
  const texto = ultimaMensagemDoUsuario(corpo.messages).trim() || 'sem texto';
  // Tokeniza preservando os espaços, para o texto remontado bater exatamente.
  const tokens = texto.match(/\S+\s*/g) || [texto];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });

  // Caminho "travado": emite o delta inicial (role) e fica em silêncio. O
  // watchdog do backend (guardStreamStall) tem de detectar a ausência de chunks
  // e disparar a recuperação. Mantemos o socket vivo sem encerrar, para o
  // watchdog medir TEMPO SEM DADOS, não fechamento de conexão — é o cenário
  // traiçoeiro que ele existe para cobrir (proxy engolindo resposta, upstream
  // congelado, rede móvel trocando de antena).
  if (modelo === 'travado') {
    pedacoSSE(res, modelo, { role: 'assistant', content: '' });
    return;
  }

  pedacoSSE(res, modelo, { role: 'assistant', content: '' });

  const lento = modelo === 'eco-lento';

  for (let i = 0; i < tokens.length; i++) {
    if (res.writableEnded || res.destroyed) return;
    pedacoSSE(res, modelo, { content: tokens[i] });
    if (lento) await dorme(PAUSA_LENTA_MS);
  }

  pedacoSSE(res, modelo, {}, 'stop');
  res.write(`data: [DONE]\n\n`);
  res.end();
}

// `ferramentas` simula um modelo que USA ferramentas no meio da conversa:
//   1ª chamada (última msg = user) → emite tool_calls para `bash echo ok-e2e-tool`
//                                    e termina com finish_reason='tool_calls'
//   2ª chamada (última msg = tool)  → emite texto, como uma resposta normal
// O id do tool_call precisa ser único por chamada — usamos um prefixo por
// requisição (contador monotônico) para evitar colisões se o teste repetir.
let contadorToolCall = 0;
async function responderStreamFerramentas(req, res, corpo) {
  const modelo = String(corpo.model || 'ferramentas');
  const mensagens = Array.isArray(corpo.messages) ? corpo.messages : [];
  const ultima = mensagens[mensagens.length - 1];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });

  pedacoSSE(res, modelo, { role: 'assistant', content: '' });

  // Volta do tool: resposta final em texto. O eco da mensagem anterior fica
  // pequeno de propósito — o que vale aqui é o caminho do tool_calls, não o
  // conteúdo criativo.
  if (ultima?.role === 'tool') {
    const tokens = ['ok-e2e-tool recebido'];
    for (const t of tokens) {
      if (res.writableEnded || res.destroyed) return;
      pedacoSSE(res, modelo, { content: t });
      await dorme(20);
    }
    pedacoSSE(res, modelo, {}, 'stop');
    res.write(`data: [DONE]\n\n`);
    return res.end();
  }

  // Primeira chamada: emite a tool_call em dois passos (id+name, depois args),
  // como chegam os deltas reais do OpenAI. O `index` mantém o estado entre os
  // chunks — é o que o backend usa para MESCLAR deltas do mesmo tool_call.
  contadorToolCall += 1;
  const toolCallId = `call_e2e_${contadorToolCall}`;
  pedacoSSE(res, modelo, {
    tool_calls: [{
      index: 0,
      id: toolCallId,
      type: 'function',
      function: { name: 'bash', arguments: '' }
    }]
  });
  pedacoSSE(res, modelo, {
    tool_calls: [{
      index: 0,
      function: { arguments: '{"command":"echo ok-e2e-tool"}' }
    }]
  });
  pedacoSSE(res, modelo, {}, 'tool_calls');
  res.write(`data: [DONE]\n\n`);
  res.end();
}

export function criarProvedorFalso() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://provedor.falso');
    let caminho = url.pathname.replace(/\/+$/, '') || '/';

    // Saúde: usada pelo runner para saber que o servidor subiu.
    if (caminho === '/saude') return json(res, 200, { ok: true, modelos: MODELOS });

    // Prefixo /apenas/<modelo>: o catálogo passa a ter SÓ aquele modelo.
    // Serve para o teste não precisar operar o seletor de modelos da interface
    // — com um modelo só, o app o escolhe sozinho (App.jsx cai em models[0]).
    // Cada teste cadastra o provedor apontando para o prefixo de que precisa.
    let catalogo = MODELOS;
    const restricao = caminho.match(/^\/apenas\/([^/]+)(\/.*)$/);
    if (restricao) {
      const pedido = decodeURIComponent(restricao[1]);
      if (!MODELOS.includes(pedido)) return json(res, 404, { error: { message: `Modelo não simulado: ${pedido}` } });
      catalogo = [pedido];
      caminho = restricao[2];
    }

    if (!chaveDaRequisicao(req)) {
      return json(res, 401, { error: { message: 'Faltou a chave de API.', type: 'invalid_request_error' } });
    }

    // Catálogo: é o que o backend chama ao cadastrar o provedor.
    if (caminho === '/v1/models' && req.method === 'GET') {
      return json(res, 200, { object: 'list', data: catalogo.map(id => ({ id, object: 'model', owned_by: 'e2e' })) });
    }

    if (caminho === '/v1/chat/completions' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      const pedido = String(corpo.model || '');
      // Falha ALTO se o modelo não é um dos nossos. Antes o provedor ecoava
      // qualquer coisa, e um teste que mandava o modelo errado (o default
      // `deepseek/deepseek-chat` do assistente) passava despercebido recebendo
      // uma resposta normal. Erro de configuração tem de aparecer.
      if (!catalogo.includes(pedido)) {
        return json(res, 404, {
          error: { message: `Modelo "${pedido}" não faz parte deste provedor falso (esperado: ${catalogo.join(', ')}).`, type: 'invalid_request_error' }
        });
      }
      if (pedido === 'chave-ruim') {
        return json(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      }
      if (pedido === 'ferramentas' && corpo.stream) return responderStreamFerramentas(req, res, corpo);
      if (corpo.stream) return responderStream(req, res, corpo);
      // Sem streaming: validação da chave ao cadastrar o provedor E o Modo
      // Design, que não usa streaming e espera o artefato pronto.
      return json(res, 200, {
        id: 'chatcmpl-e2e', object: 'chat.completion', created: 1700000000, model: String(corpo.model || 'eco'),
        choices: [{ index: 0, message: { role: 'assistant', content: RESPOSTAS_DESIGN[pedido] || 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    }

    json(res, 404, { error: { message: `Rota não simulada: ${req.method} ${caminho}` } });
  });
}

// Execução direta: `node fixtures/provedorFalso.mjs` (usado pelo webServer do
// Playwright). A porta vem de E2E_PORTA_PROVEDOR.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const porta = Number(process.env.E2E_PORTA_PROVEDOR || 4599);
  criarProvedorFalso().listen(porta, '127.0.0.1', () => {
    console.log(`[provedor-falso] ouvindo em http://127.0.0.1:${porta}`);
  });
}
