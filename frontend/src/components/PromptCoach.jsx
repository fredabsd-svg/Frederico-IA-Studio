import React, { useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { analyzePrompt, PROMPT_ACTIONS, buildCoachMessage } from '../promptCoach.js';

// Assistente de prompts (seção 4): botão discreto no compositor. Analisa o
// rascunho LOCALMENTE (sem gastar tokens) e oferece melhorias. Nunca altera o
// texto sozinho — a estruturação insere um preview no compositor (o usuário
// edita/aceita) e as demais ações pedem à IA a reescrita preservando a intenção.
export function PromptCoach({ input, setInput, onSend, disabled }) {
  const [open, setOpen] = useState(false);
  const analysis = useMemo(() => analyzePrompt(input || ''), [input]);
  const has = (input || '').trim().length > 0;
  const issueCount = analysis.issues.length;

  function applyAI(actionId) {
    const msg = buildCoachMessage(actionId, input);
    if (msg && onSend) { onSend(msg); setOpen(false); }
  }
  function scaffold() {
    // Estrutura local (preview no compositor) preservando o texto atual como objetivo.
    const t = (input || '').trim();
    setInput(`Contexto:\n\nObjetivo:\n${t}\n\nRegras:\n- \n\nFormato de saída:\n`);
    setOpen(false);
  }

  return (
    <div className="coachWrap">
      <button
        type="button"
        className={`coachBtn ${issueCount ? 'has-issues' : ''}`}
        title="Revisar/melhorar o prompt (análise local)"
        aria-label="Assistente de prompt"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
      >
        <Sparkles size={18} />
        {has && issueCount > 0 && <span className="coachBadge">{issueCount}</span>}
      </button>

      {open && (
        <div className="coachPanel" role="dialog" aria-label="Assistente de prompt">
          <div className="coachHead">
            <strong>Assistente de prompt</strong>
            <button onClick={() => setOpen(false)} aria-label="Fechar"><X size={14} /></button>
          </div>

          {!has ? (
            <div className="coachEmpty">Escreva um rascunho e eu analiso a clareza, a estrutura e os tokens — tudo localmente, sem enviar nada.</div>
          ) : (
            <>
              <div className="coachMeta">
                <span className={`coachScore s${Math.floor(analysis.score / 34)}`}>Qualidade: {analysis.score}/100</span>
                <span>~{analysis.tokens} tokens</span>
              </div>
              {issueCount > 0 ? (
                <ul className="coachIssues">
                  {analysis.issues.map((i, k) => (
                    <li key={k}><b>{i.label}.</b> <span>{i.hint}</span></li>
                  ))}
                </ul>
              ) : (
                <div className="coachOk">✓ O prompt está bem estruturado.</div>
              )}
            </>
          )}

          <div className="coachActions">
            <button className="coachScaffold" onClick={scaffold} disabled={!has}>Estruturar (contexto/objetivo/regras/formato)</button>
            <div className="coachChips">
              {PROMPT_ACTIONS.filter(a => a.id !== 'estruturar').map(a => (
                <button key={a.id} onClick={() => applyAI(a.id)} disabled={!has} title="A IA reescreve preservando sua intenção">{a.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
