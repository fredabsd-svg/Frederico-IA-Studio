// Reparos e retentativas da resposta: avisos padronizados do sistema, detecção
// de entrega/execução incompleta, protocolo textual de ferramenta, saída
// degenerada e materialização de um arquivo de texto prometido.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import fs from 'fs';
import path from 'path';
import { workspaceFor } from '../sandbox.js';
import { mentionsOutputPath, referencedOutputFiles, fileSignature } from './outputs.js';
import { PROVIDER_TIMEOUT_NOTICE } from './provider.js';

export const OUTPUT_DELIVERY_REPAIR_NOTE = `O texto anterior afirmou que existe um arquivo para download, mas o sistema verificou que nenhum arquivo correspondente foi criado em /workspace/outputs. Corrija isso agora: use uma chamada NATIVA de ferramenta para criar o arquivo real e confira que ele existe. Não escreva código, XML, JSON, <tool_call>, <function> ou argumentos de ferramenta na resposta visível. Não diga que há download até o arquivo existir de verdade.`;
export const MISSING_OUTPUT_NOTICE = '\n\n**O arquivo não foi gerado nesta tentativa.** Nenhum download foi criado. Use **Reenviar** para tentar novamente; se o problema persistir, escolha outro modelo marcado com **Ferramentas**.';
export const EXECUTION_COMPLETION_REPAIR_NOTE = `A resposta anterior ficou apenas no plano, em código ilustrativo ou em próximos passos. O pedido do usuário exige execução real nesta conversa. Use as ferramentas disponíveis agora para realizar o trabalho. Não entregue instruções para um “assistente principal”, não deixe itens como pendentes e não encerre até verificar o resultado da ferramenta. Se o pedido for gerar um arquivo, crie o arquivo real em /workspace/outputs e confira que ele existe.
ATENÇÃO: se o usuário pediu para GERAR/SALVAR um PROGRAMA ou arquivo de código (ex.: um .py, .js, projeto), o objetivo é ENTREGAR o arquivo — NÃO basta executar o código. Escreva o conteúdo COMPLETO no caminho pedido em /workspace/outputs (use write_file, ou em run_python abra o arquivo e grave com open(...,'w')). Rodar o script no sandbox NÃO cria o arquivo de entrega; salve-o de verdade e confirme com list_files que ele existe em outputs.`;
export const EXECUTION_INCOMPLETE_NOTICE = '\n\n**Não consegui concluir esta execução.** Nenhum resultado verificável foi produzido. Use **Reenviar** para tentar novamente.';
export const TOOL_PROTOCOL_REPAIR_NOTE = `A resposta anterior tentou ESCREVER uma chamada de ferramenta como texto. Isso não executa a ferramenta. Tente novamente agora usando exclusivamente a chamada nativa disponibilizada pela API. Não mostre <tool_call>, <function>, <parameter>, JSON de argumentos nem o código da ferramenta ao usuário.`;
export const TOOL_PROTOCOL_FAILURE_NOTICE = '\n\n**Não consegui executar a ferramenta nesta tentativa.** O modelo devolveu a chamada em um formato inválido e nenhum resultado foi criado. Use **Reenviar** ou escolha outro modelo marcado com **Ferramentas**.';
export const RESPONSE_TRUNCATED_REPAIR_NOTE = 'A resposta anterior foi cortada pelo limite de tamanho antes de ser concluida. Continue exatamente de onde parou, sem repetir o que ja foi dito. Termine o trabalho de forma verificavel antes de responder ao usuario.';
export const RESPONSE_TRUNCATED_NOTICE = '\n\n_Nota: a resposta foi interrompida pelo limite do modelo antes de terminar. Tente continuar com uma nova mensagem ou escolha um modelo com saida maior._';
const DEFERRED_EXECUTION_RE = /\b(?:proximo passo|pendente|a executar|executar o script|assistente principal|deve(?:ria)?\s+(?:executar|criar|gerar|verificar)|responsavel|aguarde|vou\s+(?:criar|gerar|executar))\b/i;
export const EXECUTION_CONTRACT_NOTE = `Este pedido precisa de uma ação de verdade, não só de um plano. Use as ferramentas da conversa, confira o resultado e só então responda — nada de entregar código ilustrativo, uma lista de "próximos passos" ou a tarefa pela metade. Se o pedido é um arquivo, ele precisa existir mesmo em /workspace/outputs antes de você dizer que está pronto. Exceção: se faltar uma DECISÃO do usuário para continuar (escopo, opção A ou B, permissão), termine a resposta com a pergunta e PARE — não decida por ele nem continue executando.`;
// Pedidos de macro VBA: o ambiente (openpyxl/xlsxwriter) NÃO gera um
// vbaProject.bin funcional — não dá para criar uma macro que roda de verdade.
// Sem este aviso, o modelo salvava um .xlsm "com macro" que na prática não
// executa nada e afirmava sucesso. Aqui a limitação é dita com franqueza e são
// oferecidas alternativas reais.
export const MACRO_REQUEST_RE = /\b(macros?|vba|\.xlsm|xlsm|worksheet_open|thisworkbook|auto_?open|application\.ontime)\b/i;
export const MACRO_LIMITATION_NOTE = `LIMITAÇÃO IMPORTANTE — MACROS VBA: neste ambiente você NÃO consegue gerar uma macro VBA que funcione de verdade (não há como criar/compilar um vbaProject.bin executável com openpyxl/xlsxwriter). NÃO diga que entregou um .xlsm com macro funcional — isso seria falso. Seja honesto sobre isso e ofereça a melhor alternativa real para o que a pessoa quer: (a) resolver com FÓRMULAS e formatação/ordenação já aplicadas na planilha (a ordenação/filtro pode ser feita no Python antes de salvar); (b) entregar um .xlsm com o código VBA num módulo de texto MAIS instruções claras de como colar/ativar no Excel; ou (c) automatizar a tarefa em Python e entregar o resultado já pronto. Explique o trade-off em uma frase e faça a opção mais útil.`;

// Remove os avisos padronizados do sistema (anexados ao final da resposta) para
// que eles não acabem gravados dentro de um .md/.txt materializado. A lista é
// montada em tempo de CHAMADA (não no carregamento do módulo) porque parte dos
// avisos — ex.: PROVIDER_TIMEOUT_NOTICE — era declarada mais adiante no
// agent.js original (hoje é importada de provider.js).
export function withoutSystemNotices(text) {
  let out = String(text || '');
  for (const notice of [MISSING_OUTPUT_NOTICE, EXECUTION_INCOMPLETE_NOTICE, RESPONSE_TRUNCATED_NOTICE, TOOL_PROTOCOL_FAILURE_NOTICE, PROVIDER_TIMEOUT_NOTICE]) {
    if (notice) out = out.split(notice).join('');
  }
  return out.trim();
}

export function shouldRepairOutputDelivery(text, outputsBefore, outputsAfter) {
  if (!mentionsOutputPath(text)) return false;
  const createdThisTurn = outputsAfter.some(file => outputsBefore.get(file.path) !== fileSignature(file));
  return !createdThisTurn && referencedOutputFiles(text, outputsAfter).length === 0;
}

// A resposta TERMINA com uma pergunta para o usuário? Então o turno acabou:
// o app deve ENTREGAR a pergunta e esperar a resposta. Sem isto, o reparo de
// execução via tool_choice='required' forçava o modelo a continuar — ele
// "respondia a própria pergunta" e decidia sozinho (bug relatado: o app não
// parava para o usuário responder). Conservador de propósito: só considera a
// pergunta se ela for o FINAL da resposta (pergunta retórica no meio do texto
// seguida de conclusão não conta).
export function endsAwaitingUserReply(text) {
  const s = withoutSystemNotices(String(text || ''));
  if (!s) return false;
  // Ignora enfeites de fechamento comuns depois do "?": markdown (** _ ` ~),
  // aspas, parênteses/colchetes e pontuação de lista.
  const tail = s.replace(/[\s*_`>\)\]"'~]+$/, '');
  return tail.endsWith('?');
}

// Uma resposta CONCLUSIVA: tem corpo substancial e não está adiando o trabalho
// ("vou gerar...", "próximo passo..."). Usada para não descartar uma resposta
// legítima só porque nenhuma ferramenta foi chamada numa tarefa que a heurística
// de palavras marcou como "de execução".
export function answerLooksConclusive(text) {
  const s = withoutSystemNotices(String(text || '')).trim();
  if (s.length < 600) return false;                 // curta demais p/ ser entrega final
  if (DEFERRED_EXECUTION_RE.test(s)) return false;  // está prometendo/adiando trabalho
  return true;
}

export function shouldRepairExecution({ requiresExecution, requiresOutput, toolsAvailable, executedToolCalls, outputsBefore, outputsAfter, responseText }) {
  if (!requiresExecution || !toolsAvailable) return false;
  const createdOutput = outputsAfter.some(file => outputsBefore.get(file.path) !== fileSignature(file));
  // Arquivo genuinamente esperado e não criado → repara (garantia de entrega).
  if (requiresOutput && !createdOutput) return true;
  // Sem arquivo esperado: se o modelo entregou uma resposta conclusiva e
  // substancial (sem prometer fazer depois), respeita — não descarta o texto só
  // porque nenhuma ferramenta foi chamada. Evita o "a resposta some e reaparece".
  if (answerLooksConclusive(responseText)) return false;
  if (!executedToolCalls) return true;
  return DEFERRED_EXECUTION_RE.test(String(responseText || ''));
}

export function shouldContinueAfterTruncation(finishReason, attempts = 0) {
  return String(finishReason || '').toLowerCase() === 'length' && attempts < 2;
}

// Detecta saída DEGENERADA — o modelo trava repetindo o mesmo trecho (ex.: eco
// do prompt em loop, como visto na consulta de CNPJ em produção). É conservador
// para nunca pegar conteúdo legítimo: só dispara quando um trecho idêntico de
// 80 caracteres reaparece 6+ vezes numa cauda longa (>4k chars). Uma tabela ou
// lista normal não repete o MESMO bloco exato tantas vezes.
export function looksDegenerate(text) {
  const s = String(text || '');
  if (s.length < 4000) return false;
  const tail = s.slice(-2400);
  const probe = tail.slice(-80);
  if (probe.replace(/\s+/g, '').length < 40) return false; // cauda quase em branco
  let count = 0, idx = 0;
  while ((idx = tail.indexOf(probe, idx)) !== -1) { count += 1; idx += probe.length; }
  return count >= 6;
}
export const DEGEN_CHECK_STEP = 1500; // reavalia a cada ~1500 chars novos (barato)

export function textOutputPathFromClaim(text) {
  const match = /(?:sandbox:)?(?:\/workspace\/|\/mnt\/user-data\/)?outputs\/([^\s"'<>\]\)]+?\.(?:md|markdown|txt))(?:[.,;:!?]+)?/i.exec(String(text || ''));
  if (!match) return null;
  let relative = `outputs/${match[1].trim().replace(/[.,;:!?]+$/, '').replaceAll('\\', '/')}`;
  try { relative = decodeURI(relative); } catch {}
  relative = path.posix.normalize(relative).replace(/^\.\//, '');
  return relative.startsWith('outputs/') ? relative : null;
}

export function materializeTextOutput(conversationId, text) {
  const relative = textOutputPathFromClaim(text);
  if (!relative) return null;
  if (path.posix.dirname(relative) !== 'outputs') return null;
  const ws = workspaceFor(conversationId);
  const outputRoot = path.resolve(ws.outputs);
  const target = path.resolve(ws.base, ...relative.split('/'));
  if (!target.startsWith(outputRoot + path.sep) || fs.existsSync(target)) return null;
  const body = withoutSystemNotices(text);
  if (!body) return null;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
    try { fs.chownSync(target, 1000, 1000); } catch {}
    return relative;
  } catch {
    return null;
  }
}
