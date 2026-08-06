// Regras puras do Smart Auto-scroll do chat.
//
// O DEFEITO QUE ISTO CORRIGE: o efeito de rolagem dependia da identidade do
// array `messages` e chamava `scrollIntoView({ behavior: 'smooth' })`. Durante o
// streaming, CADA delta troca o array — então a animação suave era reiniciada
// dezenas de vezes por segundo, o navegador continuava tentando descer e quem
// subia para reler algo era arrastado de volta. A verificação de "distância do
// fim" existia, mas não bastava: sem estado explícito de acompanhamento, a
// intenção do usuário de subir só era percebida depois de ele já ter se afastado
// mais de 120 px — e a animação em curso já o tinha trazido de volta antes disso.
//
// A lógica vive aqui, sem DOM e sem React, para ser testável de verdade
// (`node --test`). O hook `hooks/useSmartAutoScroll.js` só liga estas regras aos
// eventos do elemento rolável.

// Limite (px) para considerar que o usuário está "no fim". Entre 64 e 96: menor
// que isso e um respiro do layout já desliga o acompanhamento; maior e o botão
// "Ir para o final" aparece com o fim ainda visível.
export const NEAR_BOTTOM_THRESHOLD = 80;

// Teclas que revelam intenção de subir/navegar o histórico.
export const PAUSE_KEYS = Object.freeze(['ArrowUp', 'PageUp', 'Home']);

// Deslocamento vertical (px) de um gesto de toque que já conta como intenção de
// subir. Pequeno de propósito: esperar o usuário se afastar seria tarde.
export const TOUCH_PAUSE_DELTA = 6;

export function distanceFromBottom(element) {
  if (!element) return 0;
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export function isNearBottom(element, threshold = NEAR_BOTTOM_THRESHOLD) {
  if (!element) return true;
  return distanceFromBottom(element) <= threshold;
}

// A roda do mouse para CIMA é intenção de subir — não importa a distância.
export function wheelPausesFollowing(deltaY) {
  return Number(deltaY) < 0;
}

export function keyPausesFollowing(key) {
  return PAUSE_KEYS.includes(String(key));
}

// Toque: o dedo desce na tela quando o conteúdo sobe. `startY` é onde o dedo
// tocou; `currentY`, onde está agora.
export function touchPausesFollowing(startY, currentY, delta = TOUCH_PAUSE_DELTA) {
  if (!Number.isFinite(startY) || !Number.isFinite(currentY)) return false;
  return currentY - startY > delta;
}

// O acompanhamento deve VOLTAR neste evento de rolagem?
//
// Não basta "está perto do fim". Um gesto de roda para cima começa DENTRO dos 80
// px do fim: se qualquer rolagem perto do fim religasse o seguimento, o primeiro
// quadro do próprio gesto do usuário desligaria a pausa que ele acabou de pedir —
// e o delta seguinte o traria de volta ao fim. Medido com navegador real: a roda
// para cima simplesmente não saía do lugar durante o streaming.
//
// Depois de uma pausa explícita, só uma rolagem PARA BAIXO que chega ao fim
// retoma. Sem pausa, perto do fim basta (é o caso de quem nunca saiu de lá).
export function shouldResumeFollowing({ atBottom = false, movedDown = false, pausedByUser = false } = {}) {
  if (!atBottom) return false;
  return pausedByUser ? movedDown : true;
}

// O que fazer quando o conteúdo cresce. Três resultados possíveis:
//   'jump'   — ir ao fim sem animação (conversa nova, ou acompanhando);
//   'follow' — acompanhar (mesma coisa que jump, mas sem religar o seguimento);
//   'notify' — não mexer na rolagem e acender o "Nova resposta abaixo".
export function followDecision({ conversationChanged = false, following = true, pausedByUser = false } = {}) {
  if (conversationChanged) return 'jump';
  if (following && !pausedByUser) return 'follow';
  return 'notify';
}

// Comportamento da rolagem. Durante o streaming é SEMPRE 'auto': animação suave
// reiniciada a cada token é exatamente o que fazia a posição oscilar. 'smooth'
// fica para o clique explícito no botão — e nem nele, se a pessoa pediu menos
// movimento no sistema.
export function scrollBehavior({ explicit = false, reducedMotion = false } = {}) {
  return explicit && !reducedMotion ? 'smooth' : 'auto';
}

// CHAVE DE CONTEÚDO: identifica "o que cresceu" sem depender da identidade do
// array. Sem ela, o efeito rodava a cada render (inclusive no tique do relógio,
// que não muda uma vírgula do conteúdo) e não rodava quando só o tamanho do
// texto da última mensagem mudava mantendo a mesma referência de array.
export function chatContentKey(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  const blocks = last?.blocks || [];
  const lastBlock = blocks[blocks.length - 1];
  return [
    list.length,
    last?.id || last?._key || '',
    (last?.content || '').length,
    blocks.length,
    // Progresso da ferramenta em execução: o cartão/terminal cresce sem o texto
    // da mensagem mudar, e o chat precisa acompanhar isso também.
    (lastBlock?.progress?.texto || '').length,
    lastBlock?.status || '',
    last?.execution?.state || '',
    last?.execution?.updatedAt || '',
    last?.inputRequest?.id || ''
  ].join(':');
}
