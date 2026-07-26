import React, { useState } from 'react';
import { Layout, Presentation, FileText, Sparkles, ArrowLeft, Palette } from 'lucide-react';
import { DESIGN_OUTPUT_TYPES, outputTypeMeta, canSubmit } from '../design/designCore.js';

const TYPE_ICON = { web: Layout, slides: Presentation, document: FileText };

// Tela inicial do Modo Design: descrever e ver.
//
// Uma tela, uma prioridade — o campo de texto é o elemento principal. Título e
// marca são opcionais e ficam depois do botão de gerar, porque exigir um nome
// antes de existir qualquer coisa é o tipo de atrito que faz a pessoa desistir
// na primeira tela. Sem título, o backend usa o próprio pedido como nome.
export function DesignNewProject({ systems = [], busy, onCreate, onCancel, error }) {
  const [outputType, setOutputType] = useState('web');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [designSystemId, setDesignSystemId] = useState('');

  const meta = outputTypeMeta(outputType);
  const ready = canSubmit(prompt, busy);

  function submit(e) {
    e.preventDefault();
    if (!ready) return;
    onCreate({ outputType, prompt: prompt.trim(), title: title.trim() || undefined, designSystemId: designSystemId || null });
  }

  return (
    <form className="dsNew" onSubmit={submit}>
      <button type="button" className="dsBack" onClick={onCancel}><ArrowLeft size={15} /> Voltar</button>

      <header className="dsNewHead">
        <h2>O que você quer criar?</h2>
        <p>Descreva com suas palavras. A IA devolve um primeiro rascunho visual, que você refina conversando.</p>
      </header>

      <div className="dsTypes" role="radiogroup" aria-label="Tipo de saída">
        {DESIGN_OUTPUT_TYPES.map(type => {
          const Icon = TYPE_ICON[type.id] || Layout;
          const on = outputType === type.id;
          return (
            <button
              key={type.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`dsTypeCard ${on ? 'on' : ''}`}
              onClick={() => setOutputType(type.id)}
            >
              <span className="dsTypeIcon"><Icon size={20} /></span>
              <b>{type.label}</b>
              <span>{type.desc}</span>
            </button>
          );
        })}
      </div>

      <label className="dsField">
        <span className="dsFieldLabel">Descreva o que precisa</span>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={meta.placeholder}
          rows={5}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }}
        />
        <small className="dsHint">Ctrl+Enter para gerar. Quanto mais concreto (público, seções, tom), melhor o primeiro rascunho.</small>
      </label>

      <div className="dsNewRow">
        <label className="dsField">
          <span className="dsFieldLabel">Nome do projeto <em>(opcional)</em></span>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Sem nome, usamos o seu pedido" maxLength={120} />
        </label>
        <label className="dsField">
          <span className="dsFieldLabel"><Palette size={13} /> Marca <em>(opcional)</em></span>
          <select value={designSystemId} onChange={e => setDesignSystemId(e.target.value)}>
            <option value="">Sem marca definida</option>
            {systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="dsError" role="alert">{error}</div>}

      <div className="dsNewActions">
        <button type="submit" className="dsPrimary" disabled={!ready}>
          {busy ? <><span className="spin" /> Gerando…</> : <><Sparkles size={16} /> Gerar rascunho</>}
        </button>
        {busy && <span className="dsHint">Isso costuma levar de 20 a 60 segundos — a IA está escrevendo o arquivo inteiro.</span>}
      </div>
    </form>
  );
}
