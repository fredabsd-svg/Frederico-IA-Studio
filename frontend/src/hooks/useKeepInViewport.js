import { useLayoutEffect } from 'react';

// Quanto um painel ancorado à ESQUERDA do gatilho precisa andar para a esquerda
// para caber na janela (com margem). PURA, testável. Nunca empurra para além da
// borda esquerda: se o painel é maior que a janela, prioriza o começo dele.
export function overflowShift(rect, viewportWidth, margin = 12) {
  if (!rect) return 0;
  const excess = rect.right - (viewportWidth - margin);
  if (excess <= 0) return 0;
  return Math.max(0, Math.min(excess, rect.left - margin));
}

// Mantém um painel flutuante (position:absolute, left:0 no gatilho) dentro da
// janela. Com a barra lateral e os seletores mudando de largura, o painel de
// 680px do seletor de contexto passava da borda direita e cortava as abas.
// No celular o painel é position:fixed e já ocupa a largura — nada a fazer.
export function useKeepInViewport(ref, open) {
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      el.style.left = '';
      if (getComputedStyle(el).position !== 'absolute') return;
      const shift = overflowShift(el.getBoundingClientRect(), window.innerWidth);
      if (shift) el.style.left = `${-shift}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [ref, open]);
}
