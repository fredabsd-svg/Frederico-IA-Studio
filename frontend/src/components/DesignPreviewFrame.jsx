import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Tablet, Smartphone, ExternalLink, RefreshCw, MousePointerClick } from 'lucide-react';
import { PREVIEW_MESSAGES, isPreviewMessage } from '../design/designCore.js';

// Prévia ao vivo do artefato de design.
//
// SEGURANÇA — o atributo `sandbox` sem `allow-same-origin` é obrigatório aqui.
// O HTML lá dentro é código gerado por IA a partir de um pedido em linguagem
// natural; com `allow-same-origin` ele passaria a compartilhar a origem do app
// e teria acesso ao cookie de sessão, ao localStorage e ao DOM da interface. A
// resposta do backend também carimba `Content-Security-Policy: sandbox`, então
// as duas pontas restringem — esquecer uma não abre o buraco sozinha.
// Ver docs/DESIGN_STUDIO.md §Segurança.
const SANDBOX = 'allow-scripts';

// Consequência prática desse isolamento: daqui de fora NÃO dá para tocar o
// documento (`contentDocument` é null). Toda conversa com a prévia — selecionar
// um elemento, aplicar um ajuste ao vivo — passa por `postMessage` e pelo
// script-ponte que o backend injeta (backend/src/design/bridge.js).
const WIDTHS = [
  { id: 'full', label: 'Tela cheia', width: '100%', Icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: '768px', Icon: Tablet },
  { id: 'mobile', label: 'Celular', width: '390px', Icon: Smartphone },
];

export function DesignPreviewFrame({
  src, versionId, outputType, busy,
  selecting = false, onToggleSelect, onSelect, liveCss = '', canSelect = true,
}) {
  const [width, setWidth] = useState('full');
  const [loaded, setLoaded] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const frameRef = useRef(null);
  // A ponte só existe depois que o documento carrega e avisa. Mandar antes é
  // perder a mensagem em silêncio — por isso o modo e o CSS ao vivo são
  // reenviados quando o "pronto" chega.
  const [bridgeReady, setBridgeReady] = useState(false);

  const send = useCallback((tipo, dados) => {
    const frame = frameRef.current;
    if (!frame || !frame.contentWindow) return;
    // targetOrigin '*' porque a origem do iframe é OPACA — não existe origem
    // específica para mirar. O que trafega é modo de seleção e CSS de ajuste;
    // nada de sessão, nada de token.
    frame.contentWindow.postMessage({ tipo, ...dados }, '*');
  }, []);

  // Trocar de versão (ou reverter) mantém a MESMA URL de preview — ela serve
  // sempre "a versão atual". A âncora (#hash) NÃO recarrega o iframe: o
  // navegador trata como navegação no mesmo documento, o onLoad não dispara e
  // a prévia ficava eternamente com opacity:0 (classe .ready nunca voltava).
  // Por isso a versão vai na QUERY e o key remonta o iframe.
  const frameSrc = useMemo(() => {
    if (!src) return undefined;
    const joiner = src.includes('?') ? '&' : '?';
    return `${src}${joiner}_v=${encodeURIComponent(versionId || 'v0')}&_r=${reloadNonce}`;
  }, [src, versionId, reloadNonce]);

  useEffect(() => {
    setLoaded(false);
    setBridgeReady(false);
  }, [frameSrc]);

  useEffect(() => {
    function onMessage(event) {
      if (!isPreviewMessage(event, frameRef.current)) return;
      const dados = event.data;
      if (dados.tipo === PREVIEW_MESSAGES.pronto) setBridgeReady(true);
      else if (dados.tipo === PREVIEW_MESSAGES.selecionado) onSelect?.(dados.alvo);
      else if (dados.tipo === PREVIEW_MESSAGES.limparSelecao) onSelect?.(null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelect]);

  useEffect(() => {
    if (bridgeReady) send(PREVIEW_MESSAGES.modo, { selecao: selecting });
  }, [selecting, bridgeReady, send]);

  useEffect(() => {
    if (bridgeReady) send(PREVIEW_MESSAGES.ajustes, { css: liveCss });
  }, [liveCss, bridgeReady, send]);

  const current = WIDTHS.find(w => w.id === width) || WIDTHS[0];
  // Só a saída `web` é responsiva; slides e documento têm tamanho fixo por
  // natureza, então oferecer larguras de celular ali seria um controle que
  // promete algo que o artefato não faz.
  const showWidths = outputType === 'web';

  return (
    <div className="dsPreview">
      <div className="dsPreviewBar">
        {showWidths ? (
          <div className="dsWidths" role="group" aria-label="Largura da prévia">
            {WIDTHS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={width === id ? 'on' : ''}
                onClick={() => setWidth(id)}
                title={label}
                aria-pressed={width === id}
              >
                <Icon size={14} /><span>{label}</span>
              </button>
            ))}
          </div>
        ) : <span className="dsPreviewHint">Prévia ao vivo</span>}
        <div className="dsPreviewActions">
          {canSelect && (
            <button
              type="button"
              className={`dsSelectBtn ${selecting ? 'on' : ''}`}
              onClick={() => onToggleSelect?.(!selecting)}
              aria-pressed={selecting}
              title={selecting ? 'Sair do modo de seleção' : 'Clicar num elemento para editar só ele'}
            >
              <MousePointerClick size={14} /><span>{selecting ? 'Selecionando…' : 'Editar elemento'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => { setLoaded(false); setBridgeReady(false); setReloadNonce(n => n + 1); }}
            title="Recarregar a prévia"
            disabled={!src}
          >
            <RefreshCw size={14} /><span>Recarregar</span>
          </button>
          <a href={src} target="_blank" rel="noopener noreferrer" title="Abrir a prévia numa aba nova">
            <ExternalLink size={14} /><span>Abrir</span>
          </a>
        </div>
      </div>

      <div className="dsPreviewStage">
        <div className="dsPreviewFrame" style={{ width: current.width }}>
          {!src && <div className="dsPreviewLoading">Sem URL de prévia neste projeto.</div>}
          {src && !loaded && <div className="dsPreviewLoading"><span className="spin" /> Carregando a prévia…</div>}
          {src && (
            <iframe
              key={frameSrc}
              ref={frameRef}
              title="Prévia do design"
              src={frameSrc}
              sandbox={SANDBOX}
              onLoad={() => setLoaded(true)}
              className={loaded ? 'ready' : ''}
            />
          )}
        </div>
        {selecting && (
          <div className="dsPreviewTip" role="status">
            Clique no elemento que você quer mudar — <kbd>Esc</kbd> cancela.
          </div>
        )}
        {busy && (
          <div className="dsPreviewBusy" role="status">
            <span className="spin" /> Gerando uma versão nova…
          </div>
        )}
      </div>
    </div>
  );
}
