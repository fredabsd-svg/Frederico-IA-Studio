import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, History, MessageSquare, Download, RotateCcw, Check, Pencil, Eye } from 'lucide-react';
import { API } from '../constants.js';
import { DesignPreviewFrame } from './DesignPreviewFrame.jsx';
import { outputTypeMeta, exportFormatsFor, exportUrl, formatWhen, versionLabel, canSubmit, modelLabel } from '../design/designCore.js';

// Tela principal de um projeto: prévia à esquerda, refinamento à direita.
//
// A conversa e o histórico dividem a mesma coluna por abas em vez de empilhar:
// os dois competem pela mesma pergunta ("como está agora?"), e empilhados
// nenhum dos dois teria altura suficiente para ser útil.
export function DesignEditor({ project, busy, error, model, onBack, onGenerate, onRevert, onRename }) {
  const [tab, setTab] = useState('chat');
  const [mobileView, setMobileView] = useState('preview');
  const [prompt, setPrompt] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);
  const chatEndRef = useRef(null);

  const meta = outputTypeMeta(project.outputType);
  const messages = project.messages || [];
  const versions = project.versions || [];
  const hasVersion = Boolean(project.currentVersion);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, busy]);
  useEffect(() => { setTitleDraft(project.title); }, [project.title]);

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit(prompt, busy)) return;
    const text = prompt.trim();
    setPrompt('');
    setMobileView('preview');
    await onGenerate(text);
  }

  function saveTitle() {
    const value = titleDraft.trim();
    setRenaming(false);
    if (value && value !== project.title) onRename(value);
    else setTitleDraft(project.title);
  }

  return (
    <div className="dsEditor">
      <header className="dsEditorBar">
        <button type="button" className="dsBack" onClick={onBack}><ArrowLeft size={15} /> Projetos</button>

        <div className="dsEditorTitle">
          {renaming ? (
            <input
              value={titleDraft}
              autoFocus
              maxLength={120}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') { setTitleDraft(project.title); setRenaming(false); }
              }}
              aria-label="Nome do projeto"
            />
          ) : (
            <button type="button" onClick={() => setRenaming(true)} title="Renomear projeto">
              <b>{project.title}</b><Pencil size={13} />
            </button>
          )}
          <span className="dsBadge">{meta.short}</span>
        </div>

        <div className="dsExports">
          {exportFormatsFor(project.outputType).map(format => (
            <a
              key={format.id}
              className={`dsGhost ${hasVersion ? '' : 'disabled'}`}
              href={hasVersion ? exportUrl(API, project.id, format.id) : undefined}
              onClick={e => { if (!hasVersion) e.preventDefault(); }}
              aria-disabled={!hasVersion}
              title={hasVersion ? `Baixar ${format.label}` : 'Gere uma versão antes de exportar'}
            >
              <Download size={14} /> {format.label}
            </a>
          ))}
        </div>
      </header>

      <div className="dsMobileTabs" role="group" aria-label="Alternar entre prévia e conversa">
        <button type="button" className={mobileView === 'preview' ? 'on' : ''} onClick={() => setMobileView('preview')}>
          <Eye size={14} /> Prévia
        </button>
        <button type="button" className={mobileView === 'chat' ? 'on' : ''} onClick={() => setMobileView('chat')}>
          <MessageSquare size={14} /> Refinar
        </button>
      </div>

      <div className={`dsEditorBody view-${mobileView}`}>
        <section className="dsEditorStage" aria-label="Prévia do design">
          <DesignPreviewFrame
            src={project.previewUrl}
            versionId={project.currentVersionId}
            outputType={project.outputType}
            busy={busy}
          />
        </section>

        <aside className="dsSide" aria-label="Refinamento do projeto">
          <div className="dsTabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
              <MessageSquare size={14} /> Conversa
            </button>
            <button type="button" role="tab" aria-selected={tab === 'versions'} className={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>
              <History size={14} /> Versões {versions.length ? <span className="dsCount">{versions.length}</span> : null}
            </button>
          </div>

          {tab === 'chat' ? (
            <div className="dsChat">
              <div className="dsChatList">
                {!messages.length && (
                  <p className="dsChatEmpty">
                    Peça uma mudança em linguagem natural — “deixe o cabeçalho mais escuro”, “troque o texto do
                    botão”, “adicione uma seção de perguntas frequentes”. Cada pedido gera uma versão nova.
                  </p>
                )}
                {messages.map(message => (
                  <div key={message.id} className={`dsBubble ${message.role}`}>
                    {message.content}
                    {message.versionId && <span className="dsBubbleMeta">{formatWhen(message.createdAt)}</span>}
                  </div>
                ))}
                {busy && <div className="dsBubble assistant working"><span className="spin" /> Reescrevendo o design…</div>}
                <div ref={chatEndRef} />
              </div>

              {error && <div className="dsError" role="alert">{error}</div>}

              <form className="dsComposer" onSubmit={submit}>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder={hasVersion ? 'O que você quer mudar?' : 'Descreva o design que você quer gerar…'}
                  rows={2}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit(e); }}
                />
                <button type="submit" className="dsSend" disabled={!canSubmit(prompt, busy)} title="Enviar (Enter)" aria-label="Enviar pedido">
                  <ArrowUp size={17} />
                </button>
              </form>
              <small className="dsHint">Enter envia · Shift+Enter quebra a linha{model ? ` · modelo: ${modelLabel(model)}` : ''}</small>
            </div>
          ) : (
            <div className="dsVersions">
              {!versions.length && <p className="dsChatEmpty">Nenhuma versão ainda. O primeiro pedido cria a versão 1.</p>}
              {versions.map(version => {
                const current = version.id === project.currentVersionId;
                return (
                  <div key={version.id} className={`dsVersion ${current ? 'on' : ''}`}>
                    <div className="dsVersionTop">
                      <b>{versionLabel(version, project.currentVersionId)}</b>
                      <span>{formatWhen(version.createdAt)}</span>
                    </div>
                    {version.promptUsed && <p className="dsVersionPrompt">{version.promptUsed}</p>}
                    <div className="dsVersionActions">
                      {current ? (
                        <span className="dsVersionCurrent"><Check size={13} /> Em exibição</span>
                      ) : (
                        <button type="button" onClick={() => onRevert(version.id)} disabled={busy}>
                          <RotateCcw size={13} /> Voltar para esta
                        </button>
                      )}
                      <a href={exportUrl(API, project.id, exportFormatsFor(project.outputType)[0].id, version.id)} title="Baixar esta versão">
                        <Download size={13} /> Baixar
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
