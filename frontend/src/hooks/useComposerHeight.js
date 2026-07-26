import { useCallback, useEffect, useRef } from 'react';

// Publica a altura do compositor na variável CSS `--composer-h` (no elemento
// raiz), para quem flutua por cima da tela conseguir desviar dele.
//
// Existe por um motivo concreto, medido com navegador real: o personagem do
// copiloto é `position: fixed` no canto inferior direito e pousava EM CIMA do
// botão de enviar. Em 1280px a sobreposição era de 23px; de 1100px para baixo o
// botão ficava inteiramente coberto — no celular, tocar em "enviar" acertava o
// mascote, não o botão.
//
// Por que medir em vez de fixar um valor no CSS: o compositor cresce conforme o
// texto digitado (a textarea vai até 160px) e muda de altura entre os modos de
// trabalho e as faixas de largura. Qualquer número escrito à mão erraria em
// algum desses casos — e erraria em silêncio.
//
// Devolve um **callback ref**: assim a medição acompanha o elemento mesmo
// quando ele é montado e desmontado (troca de modo de trabalho, painel em tela
// cheia), sem depender de acertar a lista de dependências de um efeito.
export function useComposerHeight() {
  const observadorRef = useRef(null);

  const limpar = useCallback(() => {
    if (observadorRef.current) {
      observadorRef.current.disconnect();
      observadorRef.current = null;
    }
    document.documentElement.style.removeProperty('--composer-h');
  }, []);

  // Some com a variável ao desmontar: deixá-la para trás faria o personagem
  // flutuar alto numa tela que nem tem compositor.
  useEffect(() => limpar, [limpar]);

  return useCallback((elemento) => {
    limpar();
    if (!elemento) return;

    const medir = () => {
      const altura = Math.round(elemento.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--composer-h', `${altura}px`);
    };
    medir();

    if (typeof ResizeObserver === 'undefined') return; // navegador antigo: fica a medida inicial
    observadorRef.current = new ResizeObserver(medir);
    observadorRef.current.observe(elemento);
  }, [limpar]);
}
