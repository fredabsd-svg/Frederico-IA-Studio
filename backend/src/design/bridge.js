// Ponte entre a prévia (dentro do iframe) e a interface do Modo Design.
//
// ─────────────────────────────────────────────────────────────────────────────
// Por que existe uma "ponte" e não acesso direto ao DOM
//
// O iframe da prévia roda em ORIGEM OPACA (`sandbox="allow-scripts"` sem
// `allow-same-origin`, mais o CSP `sandbox` na resposta). Isso é o que impede o
// HTML gerado pela IA de enxergar a sessão do usuário — e é inegociável. O
// preço é que a interface TAMBÉM não enxerga o documento: `iframe.contentDocument`
// é `null`, `querySelector` não existe do lado de fora.
//
// Então a conversa é por `postMessage`, e este script é a única coisa nossa
// que roda lá dentro. Ele faz duas coisas:
//
//   1. SELEÇÃO — realça o elemento sob o cursor e, no clique, manda para fora um
//      DESCRITOR dele (tag, classes, texto, caminho e um trecho do outerHTML).
//      É esse descritor que permite ao modelo achar o elemento no HTML que ele
//      já recebe inteiro, sem precisar instrumentar o artefato guardado.
//   2. AJUSTES AO VIVO — recebe a folha de sobreposição das variáveis CSS e a
//      aplica na hora, enquanto o usuário arrasta o slider. É isso que torna o
//      ajuste instantâneo e sem chamada à IA: nada vai ao servidor até o
//      usuário soltar o controle.
//
// O script é injetado APENAS na prévia. O que é exportado (.html, .pdf, .pptx)
// sai limpo — nem a ponte, nem `data-fred-id`, nem o realce.
//
// Sobre `postMessage(..., '*')`: a origem do iframe é opaca ("null"), então não
// existe origem específica para mirar dos dois lados. O que trafega é CSS de
// ajuste e descritor de elemento — nada de sessão, nada de token. Do lado de
// fora, a interface confere `event.source === iframe.contentWindow` antes de
// aceitar qualquer mensagem, que é a checagem que vale aqui.
// ─────────────────────────────────────────────────────────────────────────────

export const BRIDGE_STYLE_ID = 'fred-ponte-estilo';
export const ADJUSTMENTS_LIVE_STYLE_ID = 'fred-ajustes-vivo';

// Tipos de mensagem, num lugar só (o outro lado está em
// frontend/src/design/designCore.js — mudou aqui, muda lá).
export const BRIDGE_MESSAGES = {
  pronto: 'fred-preview-pronto',
  selecionado: 'fred-preview-selecionado',
  modo: 'fred-preview-modo',
  ajustes: 'fred-preview-ajustes',
  limparSelecao: 'fred-preview-limpar',
};

const MAX_TEXTO = 240;
const MAX_HTML = 1200;

// O script é uma constante — nada do usuário é interpolado aqui. Um trecho
// montado por template com dados de fora viraria injeção de script dentro da
// própria prévia.
const SCRIPT = `
(function(){
  var MSG = ${JSON.stringify(BRIDGE_MESSAGES)};
  var MAX_TEXTO = ${MAX_TEXTO};
  var MAX_HTML = ${MAX_HTML};
  var IGNORAR = { HTML:1, HEAD:1, SCRIPT:1, STYLE:1, META:1, LINK:1, TITLE:1, BASE:1, BR:1 };
  var modoSelecao = false;
  var alvo = null;

  function envia(tipo, dados){
    try { parent.postMessage(Object.assign({ tipo: tipo }, dados || {}), '*'); } catch (e) {}
  }

  // Caminho CSS curto até o elemento. Não precisa ser único no sentido estrito
  // — serve de pista para o modelo, junto do trecho de HTML.
  function caminho(el){
    var partes = [];
    var atual = el;
    while (atual && atual.nodeType === 1 && atual.tagName !== 'BODY' && partes.length < 6) {
      var nome = atual.tagName.toLowerCase();
      var pai = atual.parentElement;
      if (pai) {
        var irmaos = Array.prototype.filter.call(pai.children, function(c){ return c.tagName === atual.tagName; });
        if (irmaos.length > 1) nome += ':nth-of-type(' + (irmaos.indexOf(atual) + 1) + ')';
      }
      partes.unshift(nome);
      atual = pai;
    }
    return partes.join(' > ');
  }

  // Numa apresentação o que o modelo edita é o JSON de slides, não o HTML do
  // deck (que é montado por nós). Por isso o descritor carrega o NÚMERO do
  // slide clicado: é o que permite dizer "mude só o slide 3" em vez de mandar
  // ao modelo um HTML que ele não deve tocar.
  function slideDe(el){
    var atual = el;
    while (atual && atual.nodeType === 1) {
      var n = atual.getAttribute && atual.getAttribute('data-slide');
      if (n) return Number(n) || null;
      atual = atual.parentElement;
    }
    return null;
  }

  function descritor(el){
    var texto = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    var html = el.outerHTML || '';
    return {
      tag: el.tagName.toLowerCase(),
      classes: (el.getAttribute('class') || '').slice(0, 200),
      id: (el.getAttribute('id') || '').slice(0, 100),
      caminho: caminho(el),
      slide: slideDe(el),
      texto: texto.slice(0, MAX_TEXTO),
      html: html.slice(0, MAX_HTML),
      truncado: html.length > MAX_HTML
    };
  }

  function selecionavel(el){
    return el && el.nodeType === 1 && !IGNORAR[el.tagName];
  }

  function realca(el){
    if (alvo === el) return;
    if (alvo) alvo.removeAttribute('data-fred-alvo');
    alvo = el;
    if (alvo) alvo.setAttribute('data-fred-alvo', '1');
  }

  document.addEventListener('mouseover', function(e){
    if (!modoSelecao) return;
    if (selecionavel(e.target)) realca(e.target);
  }, true);

  // Captura: o próprio artefato pode ter handlers de clique (um menu, um
  // formulário). Em modo de seleção, o clique é NOSSO e não chega a eles.
  document.addEventListener('click', function(e){
    if (!modoSelecao) return;
    if (!selecionavel(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    realca(e.target);
    envia(MSG.selecionado, { alvo: descritor(e.target) });
  }, true);

  document.addEventListener('keydown', function(e){
    if (modoSelecao && e.key === 'Escape') envia(MSG.limparSelecao, {});
  }, true);

  window.addEventListener('message', function(e){
    var dados = e.data || {};
    if (dados.tipo === MSG.modo) {
      modoSelecao = !!dados.selecao;
      document.documentElement.setAttribute('data-fred-modo', modoSelecao ? 'selecao' : '');
      if (!modoSelecao) realca(null);
    } else if (dados.tipo === MSG.ajustes) {
      var estilo = document.getElementById('${ADJUSTMENTS_LIVE_STYLE_ID}');
      if (!estilo) {
        estilo = document.createElement('style');
        estilo.id = '${ADJUSTMENTS_LIVE_STYLE_ID}';
        document.documentElement.appendChild(estilo);
      }
      estilo.textContent = String(dados.css || '');
    } else if (dados.tipo === MSG.limparSelecao) {
      realca(null);
    }
  });

  envia(MSG.pronto, { titulo: (document.title || '').slice(0, 120) });
})();
`;

// O realce fica num <style> próprio, com seletor de atributo, para não colidir
// com o CSS do artefato. `outline` (e não `border`) de propósito: borda mudaria
// o tamanho do elemento e o layout dançaria a cada passada do mouse.
const STYLE = `
html[data-fred-modo="selecao"] *{cursor:crosshair!important}
[data-fred-alvo]{outline:2px solid #4f8cff!important;outline-offset:1px!important;
background-color:rgba(79,140,255,.10)!important}
`;

// Trecho injetado na prévia (e SÓ nela).
export function bridgeSnippet() {
  return `<style id="${BRIDGE_STYLE_ID}">${STYLE}</style><script>${SCRIPT}</script>`;
}
