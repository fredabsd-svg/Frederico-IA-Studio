import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  NEAR_BOTTOM_THRESHOLD,
  followDecision,
  isNearBottom,
  keyPausesFollowing,
  scrollBehavior,
  shouldResumeFollowing,
  touchPausesFollowing,
  wheelPausesFollowing
} from '../chatScroll.js';

// Smart Auto-scroll: acompanha o streaming SEM sequestrar a rolagem de quem
// subiu para reler algo. As regras (limiares, decisões, chave de conteúdo) vivem
// em `chatScroll.js`, testadas em isolamento; aqui elas são ligadas ao elemento.
//
// Quatro estados, separados de propósito:
//   isNearBottom        — o fim está visível agora (mede o DOM);
//   isFollowing         — o efeito de crescimento deve descer (ref, alta frequência);
//   userPausedFollowing — o usuário demonstrou intenção de subir (ref);
//   hasNewContentBelow  — cresceu conteúdo enquanto pausado (acende o botão).
//
// `isFollowing`/`userPausedFollowing` são REFS porque são lidos a cada delta do
// stream: como state, cada leitura viria de um render atrasado — e um render
// atrasado é exatamente o que faz o chat "brigar" com o usuário.
export function useSmartAutoScroll({ containerRef, conversationId = null, contentKey = '', threshold = NEAR_BOTTOM_THRESHOLD }) {
  const [nearBottom, setNearBottom] = useState(true);
  const [hasNewContentBelow, setHasNewContentBelow] = useState(false);

  const followingRef = useRef(true);
  const pausedByUserRef = useRef(false);
  const previousConversationRef = useRef(conversationId);
  const touchStartRef = useRef(null);
  // Última posição vista: dá a DIREÇÃO do movimento a cada evento de rolagem.
  const lastTopRef = useRef(0);

  const reducedMotion = () => {
    try { return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); }
    catch { return false; }
  };

  const jumpToBottom = useCallback(({ behavior = 'auto', resume = true } = {}) => {
    const element = containerRef.current;
    if (!element) return;
    if (resume) {
      followingRef.current = true;
      pausedByUserRef.current = false;
    }
    // scrollTo no CONTÊINER (nunca window.scrollTo nem scrollIntoView): é o
    // elemento com overflow que rola, e mexer na janela deslocaria o layout
    // inteiro — cabeçalho, terminal e compositor incluídos.
    element.scrollTo({ top: element.scrollHeight, behavior });
    // Destino da rolagem (o maior `scrollTop` possível), não a altura total: é
    // contra este valor que o próximo evento calcula a DIREÇÃO do movimento.
    lastTopRef.current = Math.max(0, element.scrollHeight - element.clientHeight);
    setNearBottom(true);
    setHasNewContentBelow(false);
  }, [containerRef]);

  // Retoma o acompanhamento por ação EXPLÍCITA (clique/teclado no botão).
  const resumeFollowing = useCallback(() => {
    jumpToBottom({ behavior: scrollBehavior({ explicit: true, reducedMotion: reducedMotion() }), resume: true });
  }, [jumpToBottom]);

  // Força o acompanhamento uma vez, sem animação: usado ao ENVIAR uma mensagem
  // (a pessoa acabou de agir; a interação nova tem de aparecer).
  const forceFollowing = useCallback(() => {
    jumpToBottom({ behavior: 'auto', resume: true });
  }, [jumpToBottom]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const pauseFollowing = () => {
      followingRef.current = false;
      pausedByUserRef.current = true;
    };

    const onWheel = (event) => { if (wheelPausesFollowing(event.deltaY)) pauseFollowing(); };
    const onKeyDown = (event) => { if (keyPausesFollowing(event.key)) pauseFollowing(); };
    const onTouchStart = (event) => { touchStartRef.current = event.touches?.[0]?.clientY ?? null; };
    const onTouchMove = (event) => {
      const start = touchStartRef.current;
      const current = event.touches?.[0]?.clientY;
      if (start != null && touchPausesFollowing(start, current)) pauseFollowing();
    };
    const onTouchEnd = () => { touchStartRef.current = null; };
    const onScroll = () => {
      const top = element.scrollTop;
      // Direção do movimento: é ela que distingue "o usuário voltou ao fim" de
      // "o usuário está subindo e ainda não saiu dos 80 px finais".
      const movedDown = top > lastTopRef.current + 1;
      lastTopRef.current = top;
      const atBottom = isNearBottom(element, threshold);
      setNearBottom(atBottom);
      // Voltar ao fim (por rolagem manual, arraste da barra ou fim de gesto)
      // religa o acompanhamento — é o "retoma quando chegar perto do fim".
      if (shouldResumeFollowing({ atBottom, movedDown, pausedByUser: pausedByUserRef.current })) {
        followingRef.current = true;
        pausedByUserRef.current = false;
        setHasNewContentBelow(false);
      }
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    onScroll();
    return () => {
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
    };
  }, [containerRef, threshold]);

  // Cresceu conteúdo: decide entre descer e apenas avisar. `useLayoutEffect`
  // porque a medição tem de acontecer ANTES da pintura — depois dela o usuário
  // já veria um salto.
  useLayoutEffect(() => {
    const conversationChanged = previousConversationRef.current !== conversationId;
    previousConversationRef.current = conversationId;
    const decision = followDecision({
      conversationChanged,
      following: followingRef.current,
      pausedByUser: pausedByUserRef.current
    });
    if (decision === 'notify') {
      setHasNewContentBelow(true);
      return undefined;
    }
    // Um quadro de espera para a altura já refletir o conteúdo novo (markdown
    // recém-renderizado, cartão de arquivo, mudança de altura do terminal).
    const frame = requestAnimationFrame(() => {
      // REAVALIAÇÃO DENTRO DO QUADRO. A decisão foi tomada no efeito; o quadro
      // roda alguns milissegundos depois, e nesse intervalo o usuário pode ter
      // girado a roda para cima. Sem esta conferência, o quadro já agendado
      // descia mesmo assim — e o efeito visível era o pior possível: o gesto
      // funcionava, a pausa valia dali para frente, mas o usuário levava um
      // "puxão" de volta ao fim logo depois de subir. Medido com navegador real
      // (a trilha de rolagem mostrava exatamente um salto, 16 ms após o gesto).
      if (decision !== 'jump' && pausedByUserRef.current) {
        setHasNewContentBelow(true);
        return;
      }
      jumpToBottom({ behavior: 'auto', resume: decision === 'jump' });
    });
    return () => cancelAnimationFrame(frame);
  }, [contentKey, conversationId, jumpToBottom]);

  return {
    isNearBottom: nearBottom,
    hasNewContentBelow,
    jumpToBottom,
    resumeFollowing,
    forceFollowing
  };
}
