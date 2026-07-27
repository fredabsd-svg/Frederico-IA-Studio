import React, { useState } from 'react';
import { ArrowLeft, Plus, Trash2, Check } from 'lucide-react';

// Configuração de marca (design system): cores e fontes que entram no prompt de
// TODO projeto que a escolher.
//
// Deliberadamente enxuta. Cor e fonte são o que o modelo consegue aplicar com
// fidelidade a partir de uma instrução em texto; um editor de componentes de
// referência prometeria uma consistência que uma chamada de LLM não sustenta.
const EMPTY = { name: '', primaryColor: '#1f3b8a', secondaryColor: '#e8523f', fontHeading: '', fontBody: '', notes: '' };

export function DesignSystemSettings({ systems, onBack, onSave, onDelete, error }) {
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState('');
  const [saved, setSaved] = useState(false);

  function edit(system) {
    setEditing(system.id);
    setForm({
      name: system.name || '',
      primaryColor: system.primaryColor || '#1f3b8a',
      secondaryColor: system.secondaryColor || '#e8523f',
      fontHeading: system.fontHeading || '',
      fontBody: system.fontBody || '',
      notes: system.notes || '',
    });
    setSaved(false);
  }

  async function submit(e) {
    e.preventDefault();
    const result = await onSave(form, editing);
    if (result) {
      setSaved(true);
      setEditing('');
      setForm(EMPTY);
      setTimeout(() => setSaved(false), 2500);
    }
  }

  const set = (key) => (e) => setForm(prev => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="dsSystems">
      <button type="button" className="dsBack" onClick={onBack}><ArrowLeft size={15} /> Projetos</button>

      <header className="dsHomeHead">
        <div>
          <h2>Minha marca</h2>
          <p>Cores e fontes que a IA vai seguir nos projetos que usarem esta marca.</p>
        </div>
      </header>

      {!!systems.length && (
        <ul className="dsSystemList">
          {systems.map(system => (
            <li key={system.id} className={editing === system.id ? 'on' : ''}>
              <button type="button" className="dsSystemItem" onClick={() => edit(system)}>
                <span className="dsSwatches">
                  <i style={{ background: system.primaryColor || 'transparent' }} />
                  <i style={{ background: system.secondaryColor || 'transparent' }} />
                </span>
                <b>{system.name}</b>
                <span>{[system.fontHeading, system.fontBody].filter(Boolean).join(' · ') || 'fontes padrão'}</span>
              </button>
              <button type="button" className="dsCardDel" onClick={() => onDelete(system.id)} aria-label={`Apagar ${system.name}`}>
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="dsSystemForm" onSubmit={submit}>
        <h3>{editing ? 'Editar marca' : 'Nova marca'}</h3>

        <label className="dsField">
          <span className="dsFieldLabel">Nome</span>
          <input value={form.name} onChange={set('name')} placeholder="Ex.: Frederico Assessoria" maxLength={80} />
        </label>

        <div className="dsNewRow">
          <label className="dsField">
            <span className="dsFieldLabel">Cor primária</span>
            <span className="dsColorRow">
              <input type="color" value={form.primaryColor} onChange={set('primaryColor')} aria-label="Cor primária" />
              <input value={form.primaryColor} onChange={set('primaryColor')} maxLength={7} />
            </span>
          </label>
          <label className="dsField">
            <span className="dsFieldLabel">Cor secundária</span>
            <span className="dsColorRow">
              <input type="color" value={form.secondaryColor} onChange={set('secondaryColor')} aria-label="Cor secundária" />
              <input value={form.secondaryColor} onChange={set('secondaryColor')} maxLength={7} />
            </span>
          </label>
        </div>

        <div className="dsNewRow">
          <label className="dsField">
            <span className="dsFieldLabel">Fonte de títulos</span>
            <input value={form.fontHeading} onChange={set('fontHeading')} placeholder="Ex.: Playfair Display" maxLength={60} />
          </label>
          <label className="dsField">
            <span className="dsFieldLabel">Fonte de corpo</span>
            <input value={form.fontBody} onChange={set('fontBody')} placeholder="Ex.: Inter" maxLength={60} />
          </label>
        </div>

        <label className="dsField">
          <span className="dsFieldLabel">Observações da marca <em>(opcional)</em></span>
          <textarea
            value={form.notes}
            onChange={set('notes')}
            rows={3}
            maxLength={2000}
            placeholder="Ex.: tom sóbrio, cantos retos, nada de gradiente. Sempre usar o CNPJ no rodapé."
          />
        </label>

        {error && <div className="dsError" role="alert">{error}</div>}

        <div className="dsNewActions">
          <button type="submit" className="dsPrimary" disabled={!form.name.trim()}>
            {editing ? <><Check size={16} /> Salvar alterações</> : <><Plus size={16} /> Criar marca</>}
          </button>
          {editing && (
            <button type="button" className="dsGhost" onClick={() => { setEditing(''); setForm(EMPTY); }}>Cancelar</button>
          )}
          {saved && <span className="dsSaved"><Check size={14} /> Marca salva</span>}
        </div>
      </form>
    </div>
  );
}
