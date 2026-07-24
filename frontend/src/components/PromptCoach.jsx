import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, ChevronRight } from 'lucide-react';
import { analyzePrompt, PROMPT_ACTIONS, buildCoachMessage } from '../promptCoach.js';

// Assistente de prompts PROATIVO (seção 4): o copiloto OBSERVA o rascunho e, se
// perceber pontos a melhorar, oferece a revisão de forma discreta — sem botão
// fixo e sem interromper a digitação. Tudo LOCAL (não gasta tokens na análise).
// Respeita o modo do Companion: só sugere em Auxiliar/Proativo.
export function PromptCoach({ input, setInput, onSend, mode = 'auxiliar', disabled }) {
  const [open, setOpen] = useState(false);       // painel completo aberto
  const [debounced, setDebounced] = useState(''); // rascunho "estável" (após pausa)
  const dismissedRef = useRef('');               // texto dispensado pelo usuário
  const timer = useRef(null);

  // Espera uma pausa na digitação antes de analisar (não pisca a cada tecla).
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(input || ''), 700);
    return () => clearTimeout(timer.current);
  }, [input]);

  const analysis = useMemo(() => analyzePrompt(debounced), [debounced]);
  const proactiveMode = mode === 'auxiliar' || mode === 'proativo';
  const words = (debounced || '').trim().split(/\s+/).filter(Boolean).length;

  // A faixa aparece só quando: modo permite, há texto com substância, há pontos
  // a melhorar e o usuário não dispensou ESTE rascunho.
  const shouldHint = !disabled && proactiveMode && words >= 4 && analysis.issues.length > 0
    && dismissedRef.current !== debounced && !open;

  function dismiss() { dismissedRef.current = debounced; setOpen(false); }
  function applyAI(actionId) {
    const msg = buildCoachMessage(actionId, input);
    if (msg && onSend) { onSend(msg); setOpen(false); }
  }
  function scaffold() {
    const t = (input || '').trim();
    setInput(`Contexto:\n\nObjetivo:\n${t}\n\nRegras:\n- \n\nFormato de saída:\n`);
    setOpen(false);
  }

  if (!shouldHint && !open) return null;

  return (
    <div className="coachBar">
      {shouldHint && !open && (
        <div className="coachHint">
          <Sparkles size={15} />
          <span>Posso deixar seu prompt mais claro — {analysis.issues.length} ponto{analysis.issues.length > 1 ? 's' : ''} a melhorar.</span>
          <button className="coachHintSee" onClick={() => setOpen(true)}>Ver <ChevronRight size={13} /></button>
          <button className="coachHintX" onClick={dismiss} aria-label="Dispensar"><X size={13} /></button>
        </div>
      )}

      {open && (
        <div className="coachPanel" role="dialog" aria-label="Assistente de prompt">
          <div className="coachHead">
            <strong><Sparkles size={14} /> Assistente de prompt</strong>
            <button onClick={() => setOpen(false)} aria-label="Fechar"><X size={15} /></button>
          </div>

          <div className="coachMeta">
            <span className={`coachScore s${Math.floor(analysis.score / 34)}`}>Qualidade {analysis.score}/100</span>
            <span>~{analysis.tokens} tokens</span>
          </div>

          {analysis.issues.length > 0 ? (
            <ul className="coachIssues">
              {analysis.issues.map((i, k) => <li key={k}><b>{i.label}.</b> <span>{i.hint}</span></li>)}
            </ul>
          ) : <div className="coachOk">✓ O prompt está bem estruturado.</div>}

          <button className="coachScaffold" onClick={scaffold}>Estruturar (contexto · objetivo · regras · formato)</button>
          <div className="coachChipsLabel">Ou peça à IA para reescrever preservando sua intenção:</div>
          <div className="coachChips">
            {PROMPT_ACTIONS.filter(a => a.id !== 'estruturar').map(a => (
              <button key={a.id} onClick={() => applyAI(a.id)}>{a.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
