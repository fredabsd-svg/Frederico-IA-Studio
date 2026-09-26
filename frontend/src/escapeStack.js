// Pilha de camadas que o `Esc` fecha — UMA por tecla, sempre a mais interna.
//
// O defeito que motivou: o menu do seletor de modelo e o modal em volta dele
// escutavam `keydown` no `document`, os dois na fase de bolha. Apertar Esc para
// dispensar a LISTA fechava também o MODAL (e, no Modo Design, a tela inteira).
// O DesignPanel ganhou um remendo próprio; aqui a regra fica num lugar só.
//
// Como funciona: cada menu suspenso aberto empilha a sua função de fechar. Um
// único ouvinte na fase de CAPTURA do `document` — que roda antes de qualquer
// ouvinte de bolha (DialogShell, atalhos do App) — fecha só o topo da pilha e
// interrompe a propagação. Com a pilha vazia ele não faz nada, e o Esc segue
// para os modais como sempre. A ordem de abertura define quem é o mais interno:
// a lista de famílias abre DEPOIS do painel de modelos, então fecha primeiro.
//
// `createEscapeStack` não toca no DOM para poder ser testada no `node --test`.

export function createEscapeStack() {
  const layers = [];
  return {
    push(close) {
      const layer = { close };
      layers.push(layer);
      return () => {
        const index = layers.indexOf(layer);
        if (index !== -1) layers.splice(index, 1);
      };
    },
    size: () => layers.length,
    // Devolve true quando consumiu a tecla (havia camada aberta).
    handle(event) {
      if (event.key !== 'Escape' || !layers.length) return false;
      const top = layers[layers.length - 1];
      event.preventDefault?.();
      event.stopPropagation?.();
      top.close();
      return true;
    }
  };
}

const stack = createEscapeStack();
let installed = false;

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('keydown', event => { stack.handle(event); }, true);
}

// Registra uma camada aberta; devolve a função que a retira da pilha.
export function pushEscapeLayer(close) {
  install();
  return stack.push(close);
}
