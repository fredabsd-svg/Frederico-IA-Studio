import React from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { tokenValue } from '../design/designCore.js';

// Controles de ajuste fino — os "sliders".
//
// A lista é DERIVADA do artefato: o backend devolve, em `tokens`, as variáveis
// CSS que este design declarou (ver backend/src/design/tokens.js). Um design
// que expõe só as duas cores mostra dois controles; um artefato antigo, gerado
// antes do contrato, mostra zero — e a tela diz isso, em vez de oferecer
// controles que não fazem nada.
//
// Mexer num controle NÃO chama a IA e NÃO cria versão: o efeito é imediato no
// iframe (CSS aplicado por postMessage) e só vira gravação quando o usuário
// solta o controle. É a diferença entre "ajustar" e "pedir uma versão nova".
export function DesignAdjustments({ tokens, adjustments, onPreview, onCommit, onReset, saving }) {
  const ajustados = Object.keys(adjustments || {}).length;

  if (!tokens?.length) {
    return (
      <div className="dsAdjust">
        <p className="dsChatEmpty">
          Este design não expõe variáveis de ajuste. Isso acontece com projetos criados antes destes
          controles, ou quando o modelo não seguiu o padrão. Peça no chat <em>“use variáveis CSS
          --fred-* para cores, tipografia e espaçamento”</em> e a próxima versão traz os controles.
        </p>
      </div>
    );
  }

  return (
    <div className="dsAdjust">
      <div className="dsAdjustHead">
        <span><SlidersHorizontal size={14} /> Muda na hora, sem gastar uma geração</span>
        {!!ajustados && (
          <button type="button" onClick={onReset} disabled={saving} title="Voltar aos valores do design">
            <RotateCcw size={13} /> Restaurar
          </button>
        )}
      </div>

      <div className="dsAdjustList">
        {tokens.map(token => {
          const valor = tokenValue(token, adjustments);
          const tocado = adjustments?.[token.id] !== undefined && adjustments?.[token.id] !== null;
          return (
            <label key={token.id} className={`dsAdjustItem ${tocado ? 'on' : ''}`}>
              <span className="dsAdjustTop">
                <b>{token.label}</b>
                <span>{token.kind === 'cor' ? valor : `${valor}${token.unit || ''}`}</span>
              </span>

              {token.kind === 'cor' ? (
                <span className="dsAdjustControl">
                  <input
                    type="color"
                    value={valor}
                    aria-label={token.label}
                    onChange={e => onPreview(token.id, e.target.value)}
                    // `change` no seletor de cor já é o "soltei"; `input` dispara
                    // a cada movimento e serve para o efeito ao vivo.
                    onBlur={e => onCommit(token.id, e.target.value)}
                  />
                  <input
                    type="text"
                    className="dsAdjustHex"
                    value={valor}
                    maxLength={7}
                    aria-label={`${token.label} em hexadecimal`}
                    onChange={e => onPreview(token.id, e.target.value)}
                    onBlur={e => onCommit(token.id, e.target.value)}
                  />
                </span>
              ) : (
                <input
                  type="range"
                  min={token.min}
                  max={token.max}
                  step={token.step}
                  value={valor}
                  aria-label={token.label}
                  onChange={e => onPreview(token.id, Number(e.target.value))}
                  // Gravar a cada pixel do arrasto encheria o servidor de
                  // requisições; a gravação acontece quando o controle é solto.
                  onPointerUp={e => onCommit(token.id, Number(e.target.value))}
                  onKeyUp={e => onCommit(token.id, Number(e.target.value))}
                />
              )}
              <small>{token.hint}</small>
            </label>
          );
        })}
      </div>

      <p className="dsHint">
        Os ajustes valem para o projeto inteiro e acompanham o que você exportar — o
        arquivo baixado sai igual ao que está na tela.
      </p>
    </div>
  );
}
