import React, { useEffect, useRef, useState } from 'react';
import { Monitor, Tablet, Smartphone, ExternalLink, RefreshCw } from 'lucide-react';

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

const WIDTHS = [
  { id: 'full', label: 'Tela cheia', width: '100%', Icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: '768px', Icon: Tablet },
  { id: 'mobile', label: 'Celular', width: '390px', Icon: Smartphone },
];

export function DesignPreviewFrame({ src, versionId, outputType, busy }) {
  const [width, setWidth] = useState('full');
  const [loaded, setLoaded] = useState(false);
  const frameRef = useRef(null);

  // Trocar de versão (ou reverter) mantém a MESMA URL de preview — ela serve
  // sempre "a versão atual". Sem recarregar de propósito, o iframe continuaria
  // exibindo o HTML anterior e pareceria que a geração não fez nada.
  useEffect(() => {
    setLoaded(false);
    if (frameRef.current && src) frameRef.current.src = `${src}#${versionId || 'v0'}`;
  }, [src, versionId]);

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
          <button
            type="button"
            onClick={() => { if (frameRef.current) frameRef.current.src = `${src}#r${Date.now()}`; }}
            title="Recarregar a prévia"
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
          {!loaded && <div className="dsPreviewLoading"><span className="spin" /> Carregando a prévia…</div>}
          <iframe
            ref={frameRef}
            title="Prévia do design"
            sandbox={SANDBOX}
            onLoad={() => setLoaded(true)}
            className={loaded ? 'ready' : ''}
          />
        </div>
        {busy && (
          <div className="dsPreviewBusy" role="status">
            <span className="spin" /> Gerando uma versão nova…
          </div>
        )}
      </div>
    </div>
  );
}
