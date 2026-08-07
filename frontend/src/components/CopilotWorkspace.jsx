import React, { useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../constants.js';
import { Drawer, Modal } from '../components.jsx';
import { PROMPT_ACTIONS, buildCoachMessage } from '../promptCoach.js';
import {
  MessageSquare, FolderOpen, Send, Trash2, Eraser, Bell,
  FileText, Download, Eye, X, Wand2, Brain, Link2, Copy,
  BookmarkPlus, ArrowUpToLine, Pin, PinOff, Plus, ScrollText, Check, Link2Off,
  ShieldCheck, Gauge, SearchCheck, Sparkles,
} from 'lucide-react';
import { NinoAvatar, NINO_CAPTION } from './NinoAvatar.jsx';
import { actionForCompanionEvent } from '../companionEventActions.js';

const DOC_KIND_LABEL = {
  texto: 'Nota', texto_revisado: 'Texto revisado', log: 'Registro', print: 'Captura', relatorio: 'Relatório',
};
const NOTE_KIND_LABEL = {
  preferencia: 'Preferência', tema: 'Tema', lembrete: 'Lembrete', fato: 'Fato',
};
const CONTEXT_LABEL = {
  nunca: 'Nunca ler o chat principal',
  perguntar: 'Só quando eu marcar na mensagem',
  sempre: 'Sempre levar o contexto (padrão)',
};
const STYLE_LABEL = { curto: 'Curtas', equilibrado: 'Equilibradas', detalhado: 'Detalhadas' };
const TONE_LABEL = { direto: 'Direto', amigavel: 'Amigável', formal: 'Formal' };

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; }
}
function fmtSize(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} B`;
  return `${Math.ceil(b / 1024)} KB`;
}

// O espaço PRÓPRIO do copiloto: aberto pelo avatar, com três abas — Conversa
// (leva o contexto da conversa principal aberta, e o botão do compositor
// dispensa isso quando o usuário quiser), Memória (as preferências e as notas
// que ele mantém entre conversas) e Documentos (a caixa própria dele).
export function CopilotWorkspace({
  copilot, companion, state = 'aguardando', onClose,
  conversationId = null, conversationTitle = '', onApplyDraft, onEventAction, showToast,
}) {
  const [tab, setTab] = useState('chat');
  const name = companion?.settings?.characterName || 'Nino';
  const quiet = companion?.settings?.animationLevel === 'nenhum';
  const unread = useMemo(
    () => (companion?.events || []).filter(e => e.status === 'novo' || e.status === 'visto'),
    [companion?.events]
  );

  // As preferências são carregadas junto com a conversa: é delas que sai o
  // estado do botão de contexto no compositor.
  useEffect(() => { copilot.loadChat(); copilot.loadMemory(); }, []); // eslint-disable-line
  useEffect(() => { if (tab === 'docs') copilot.loadDocuments(); }, [tab]); // eslint-disable-line

  const face = <span className="cwHeadFace"><NinoAvatar state={state} name={name} quiet={quiet} /></span>;

  return (
    <Drawer title={name} icon={face} onClose={onClose} className="cwDrawer">
      <div className="cwCaption">{NINO_CAPTION[state] || NINO_CAPTION.aguardando}</div>

      <div className="cwTabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          <MessageSquare size={14} /> Conversa
        </button>
        <button role="tab" aria-selected={tab === 'memory'} className={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}>
          <Brain size={14} /> Memória {copilot.notes.length > 0 && <span className="cwCount">{copilot.notes.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'docs'} className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>
          <FolderOpen size={14} /> Documentos {copilot.documents.length > 0 && <span className="cwCount">{copilot.documents.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'actions'} className={tab === 'actions' ? 'on' : ''} onClick={() => setTab('actions')}>
          <Sparkles size={14} /> Ações
        </button>
      </div>

      {tab === 'chat' && (
        <ChatTab
          copilot={copilot} companion={companion} name={name} unread={unread} quiet={quiet}
          conversationId={conversationId} conversationTitle={conversationTitle}
          onApplyDraft={onApplyDraft} onEventAction={onEventAction} showToast={showToast}
        />
      )}
      {tab === 'memory' && <MemoryTab copilot={copilot} name={name} quiet={quiet} showToast={showToast} />}
      {tab === 'docs' && <DocsTab copilot={copilot} name={name} quiet={quiet} showToast={showToast} />}
      {tab === 'actions' && <ExecutiveActionsTab copilot={copilot} name={name} quiet={quiet} />}
    </Drawer>
  );
}

// ---- Conversa ----------------------------------------------------------------

function ChatTab({ copilot, companion, name, unread, quiet, conversationId, conversationTitle, onApplyDraft, onEventAction, showToast }) {
  const { messages, sending, loading, error, send, clearChat, prefs } = copilot;
  const [text, setText] = useState('');
  const [tools, setTools] = useState(false);
  // null = segue a preferência; true/false = decisão só desta mensagem.
  const [shareOverride, setShareOverride] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [eventWorking, setEventWorking] = useState(null);
  const scrollRef = useRef(null);

  const access = prefs?.contextAccess || 'sempre';
  const canShare = access !== 'nunca' && !!conversationId;
  const byPreference = access === 'sempre';
  const willShare = canShare && (shareOverride == null ? byPreference : shareOverride);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  function submit(e) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    send(t, { shareContext: willShare, conversationId });
    setText('');
    setShareOverride(null); // a decisão valia só para aquela mensagem
  }
  function runTool(actionId) {
    const draft = text.trim();
    if (!draft) return;
    const msg = buildCoachMessage(actionId, draft);
    if (msg) {
      send(msg, { shareContext: willShare, conversationId });
      setText(''); setTools(false); setShareOverride(null);
    }
  }
  async function summarize() {
    setSummarizing(true);
    const r = await copilot.summarizeChat();
    setSummarizing(false);
    if (r?.document) showToast?.('Resumo guardado em Documentos.');
  }
  async function confirmEvent(event, action) {
    if (!action || eventWorking) return;
    setEventWorking(event.id);
    await onEventAction?.(event, action);
    setEventWorking(null);
  }

  return (
    <div className="cwChat">
      {unread.length > 0 && (
        <div className="cwAlerts">
          <div className="cwAlertsHead">
            <span><Bell size={13} /> {unread.length} aviso{unread.length > 1 ? 's' : ''}</span>
            <button className="cwLink" onClick={companion.dismissAll}>Limpar</button>
          </div>
          {unread.slice(0, 3).map(e => (
            <div key={e.id} className={`cwAlert level-${e.level}`}>
              <div className="cwAlertTitle">{e.title}</div>
              {e.detail && <div className="cwAlertDetail">{e.detail}</div>}
              <div className="cwAlertActions">
                {(() => {
                  const action = actionForCompanionEvent(e);
                  return action && (
                    <button className="cwAlertConfirm" onClick={() => confirmEvent(e, action)} disabled={!!eventWorking}>
                      {eventWorking === e.id ? <><span className="cmpBubbleSpin" /> {action.pendingLabel}</> : <><Check size={13} /> {action.label}</>}
                    </button>
                  );
                })()}
                <button className="cwLink" onClick={() => companion.dismissEvent(e.id)} disabled={!!eventWorking}>Dispensar</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="cwMessages" ref={scrollRef}>
        {loading && messages.length === 0 && <div className="cwLoading">Carregando conversa…</div>}
        {!loading && messages.length === 0 && (
          <div className="cwEmpty">
            <span className="cwEmptyFace"><NinoAvatar state="observando" name={name} quiet={quiet} /></span>
            <b>Oi! Eu sou o {name}.</b>
            <span>Este é o nosso canto executivo — separado do chat principal. Posso planejar, questionar premissas, auditar entregas, proteger seus dados e otimizar o uso dos modelos.</span>
            {canShare && byPreference && <span className="cwEmptyHint">Já acompanho o que está na conversa aberta. Se preferir sigilo numa pergunta, desligue o <Link2 size={12} /> antes de enviar.</span>}
            {canShare && !byPreference && <span className="cwEmptyHint">Quando precisar que eu veja do que se trata lá no chat, ligue o <Link2 size={12} /> antes de enviar.</span>}
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`cwMsg ${m.role} ${m.pending ? 'pending' : ''}`}>
            {m.role === 'assistant' && <span className="cwMsgFace"><NinoAvatar state="aguardando" name={name} quiet={quiet} /></span>}
            <div className="cwBubbleWrap">
              <div className="cwBubble">{m.content}</div>
              {m.role === 'assistant' && (
                <>
                  <UsedBadges used={m.used} />
                  <MessageActions
                    content={m.content} copilot={copilot} onApplyDraft={onApplyDraft} showToast={showToast}
                  />
                </>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="cwMsg assistant">
            <span className="cwMsgFace"><NinoAvatar state="digitando" name={name} quiet={quiet} /></span>
            <div className="cwBubble cwTyping"><span /><span /><span /></div>
          </div>
        )}
      </div>

      {error && <div className="cwError" role="alert">{error}</div>}

      {tools && (
        <div className="cwTools">
          <div className="cwToolsHint">Aplico ao texto abaixo, preservando sua intenção:</div>
          <div className="cwToolsChips">
            {PROMPT_ACTIONS.map(a => (
              <button key={a.id} onClick={() => runTool(a.id)} disabled={!text.trim()}>{a.label}</button>
            ))}
          </div>
        </div>
      )}

      {canShare && (
        willShare ? (
          <div className="cwContextOn">
            <Link2 size={12} /> Vou ler as últimas {prefs?.contextMessages || 6} mensagens
            {conversationTitle ? ` de “${conversationTitle}”` : ' do chat principal'}
            <button type="button" className="cwLink" onClick={() => setShareOverride(false)}>não levar desta vez</button>
          </div>
        ) : (
          <div className="cwContextOff">
            <Link2Off size={12} /> Sem o contexto do chat principal nesta mensagem
            <button type="button" className="cwLink" onClick={() => setShareOverride(true)}>levar mesmo assim</button>
          </div>
        )
      )}

      <form className="cwComposer" onSubmit={submit}>
        <button type="button" className={`cwToolBtn ${tools ? 'on' : ''}`} title="Ferramentas de prompt" aria-label="Ferramentas de prompt" onClick={() => setTools(t => !t)}>
          <Wand2 size={16} />
        </button>
        <button
          type="button"
          className={`cwToolBtn ${willShare ? 'on' : ''}`}
          disabled={!canShare}
          aria-pressed={willShare}
          title={
            access === 'nunca' ? 'Leitura do chat principal desativada (mude em Memória)'
              : !conversationId ? 'Abra uma conversa no chat principal para poder compartilhá-la'
                : willShare ? 'Não levar o contexto nesta mensagem'
                  : 'Levar as últimas mensagens do chat principal nesta pergunta'
          }
          aria-label={willShare ? 'Não levar o contexto nesta mensagem' : 'Levar o contexto do chat principal'}
          onClick={() => setShareOverride(v => (v == null ? !byPreference : !v))}
        >
          {willShare ? <Link2 size={16} /> : <Link2Off size={16} />}
        </button>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={`Fala aí, o que você precisa…`}
          rows={1}
          aria-label={`Mensagem para o ${name}`}
        />
        <button type="submit" className="cwSend" disabled={!text.trim() || sending} aria-label="Enviar"><Send size={16} /></button>
      </form>
      {messages.length > 0 && (
        <div className="cwChatFoot">
          <button className="cwClear" onClick={clearChat}><Eraser size={12} /> Limpar histórico</button>
          <button className="cwClear" onClick={summarize} disabled={summarizing}>
            <ScrollText size={12} /> {summarizing ? 'Resumindo…' : 'Resumir em documento'}
          </button>
        </div>
      )}
    </div>
  );
}

// O que o copiloto realmente usou naquela resposta. Só aparece quando houve
// uso — nada de selo decorativo.
function UsedBadges({ used }) {
  if (!used) return null;
  const badges = [];
  if (used.context) {
    badges.push(
      <span key="ctx" className="cwUsed ctx" title={used.context.conversationTitle || 'chat principal'}>
        <Link2 size={11} /> {used.context.messages} msg do chat principal
      </span>
    );
  }
  if (used.notes > 0) badges.push(<span key="notes" className="cwUsed"><Brain size={11} /> memória</span>);
  for (const t of used.knowledge || []) badges.push(<span key={`k-${t}`} className="cwUsed"><BookmarkPlus size={11} /> {t}</span>);
  if (!badges.length) return null;
  return <div className="cwUsedRow">{badges}</div>;
}

// Ações do copiloto DENTRO do Studio — cada uma disparada por um clique do
// usuário sobre um conteúdo que ele está vendo, nunca pelo modelo sozinho.
function MessageActions({ content, copilot, onApplyDraft, showToast }) {
  const [done, setDone] = useState('');
  const flag = (what, msg) => { setDone(what); showToast?.(msg); setTimeout(() => setDone(''), 1600); };

  async function copy() {
    try { await navigator.clipboard.writeText(content); flag('copy', 'Copiado.'); } catch { showToast?.('Não consegui copiar.'); }
  }
  function toComposer() {
    onApplyDraft?.(content);
    flag('draft', 'Texto levado para o chat principal.');
  }
  async function asTemplate() {
    const name = content.trim().split('\n')[0].slice(0, 60) || 'Modelo do copiloto';
    if (await copilot.saveAsTemplate(name, content)) flag('tpl', 'Salvo nos modelos de pedido.');
  }
  async function asDocument() {
    const name = content.trim().split('\n')[0].slice(0, 60) || 'Nota do copiloto';
    if (await copilot.saveAsDocument(name, content)) flag('doc', 'Guardado em Documentos.');
  }
  async function asNote() {
    if (await copilot.addNote({ kind: 'preferencia', content: content.slice(0, 500), source: 'copiloto' })) {
      flag('note', 'Guardado na memória do copiloto.');
    }
  }

  return (
    <div className="cwMsgActions">
      <button onClick={copy} title="Copiar">{done === 'copy' ? <Check size={13} /> : <Copy size={13} />}</button>
      {onApplyDraft && (
        <button onClick={toComposer} title="Usar no chat principal">
          {done === 'draft' ? <Check size={13} /> : <ArrowUpToLine size={13} />}
        </button>
      )}
      <button onClick={asTemplate} title="Salvar como modelo de pedido">
        {done === 'tpl' ? <Check size={13} /> : <BookmarkPlus size={13} />}
      </button>
      <button onClick={asDocument} title="Guardar na caixa de documentos">
        {done === 'doc' ? <Check size={13} /> : <FileText size={13} />}
      </button>
      <button onClick={asNote} title="Guardar na memória do copiloto">
        {done === 'note' ? <Check size={13} /> : <Brain size={13} />}
      </button>
    </div>
  );
}

// ---- Memória e preferências ---------------------------------------------------

function MemoryTab({ copilot, name, quiet, showToast }) {
  const { notes, prefs, prefsOptions, memoryLoading, savePrefs, addNote, updateNote, deleteNote } = copilot;
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState('preferencia');

  if (memoryLoading && !prefs) return <div className="cwLoading">Carregando preferências…</div>;

  async function add(e) {
    e?.preventDefault();
    const content = draft.trim();
    if (!content) return;
    if (await addNote({ kind, content, source: 'manual' })) { setDraft(''); showToast?.('Anotado.'); }
  }

  const noteKinds = prefsOptions?.noteKinds || ['preferencia', 'tema', 'lembrete', 'fato'];

  return (
    <div className="cwMemory">
      <section className="cwPrefs">
        <h4>Preferências</h4>

        <label className="cwPrefLabel" htmlFor="cwCtxAccess">Acesso ao chat principal</label>
        <select
          id="cwCtxAccess"
          value={prefs?.contextAccess || 'sempre'}
          onChange={e => savePrefs({ contextAccess: e.target.value })}
        >
          {(prefsOptions?.contextAccess || ['sempre', 'perguntar', 'nunca']).map(v => (
            <option key={v} value={v}>{CONTEXT_LABEL[v] || v}</option>
          ))}
        </select>
        <p className="cwPrefHint">
          Por padrão o {name} acompanha a conversa principal aberta — é o que evita ter de copiar e colar
          contexto. O botão de contexto no compositor dispensa a leitura numa mensagem pontual, e toda
          leitura fica registrada na auditoria.
        </p>

        {prefs?.contextAccess !== 'nunca' && (
          <>
            <label className="cwPrefLabel" htmlFor="cwCtxMsgs">Quantas mensagens ele lê: {prefs?.contextMessages || 6}</label>
            <input
              id="cwCtxMsgs" type="range" min="2" max="20" step="1"
              value={prefs?.contextMessages || 6}
              onChange={e => savePrefs({ contextMessages: Number(e.target.value) })}
            />
          </>
        )}

        <label className="cwPrefLabel" htmlFor="cwStyle">Tamanho das respostas</label>
        <select id="cwStyle" value={prefs?.responseStyle || 'equilibrado'} onChange={e => savePrefs({ responseStyle: e.target.value })}>
          {(prefsOptions?.responseStyles || ['curto', 'equilibrado', 'detalhado']).map(v => (
            <option key={v} value={v}>{STYLE_LABEL[v] || v}</option>
          ))}
        </select>

        <label className="cwPrefLabel" htmlFor="cwTone">Tom</label>
        <select id="cwTone" value={prefs?.tone || 'direto'} onChange={e => savePrefs({ tone: e.target.value })}>
          {(prefsOptions?.tones || ['direto', 'amigavel', 'formal']).map(v => (
            <option key={v} value={v}>{TONE_LABEL[v] || v}</option>
          ))}
        </select>

        <label className="cwSwitch">
          <input type="checkbox" checked={prefs?.useNotes !== false} onChange={e => savePrefs({ useNotes: e.target.checked })} />
          Usar as anotações abaixo nas respostas
        </label>
        <label className="cwSwitch">
          <input type="checkbox" checked={prefs?.useKnowledge !== false} onChange={e => savePrefs({ useKnowledge: e.target.checked })} />
          Consultar a documentação do Studio quando a dúvida for sobre o aplicativo
        </label>
      </section>

      <section className="cwNotes">
        <h4>Anotações <span className="cwDim">— o que ele leva entre conversas</span></h4>

        <form className="cwNoteNew" onSubmit={add}>
          <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Tipo da anotação">
            {noteKinds.map(k => <option key={k} value={k}>{NOTE_KIND_LABEL[k] || k}</option>)}
          </select>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Ex.: prefiro respostas em tópicos curtos"
            maxLength={500}
            aria-label="Nova anotação"
          />
          <button type="submit" disabled={!draft.trim()} aria-label="Guardar anotação"><Plus size={15} /></button>
        </form>

        {notes.length === 0 && (
          <div className="cwEmpty notes">
            <span className="cwEmptyFace"><NinoAvatar state="duvida" name={name} quiet={quiet} /></span>
            <b>Minha memória está vazia</b>
            <span>Guarde aqui preferências e temas em andamento. Só entra o que você escrever — eu não anoto nada por conta própria.</span>
          </div>
        )}

        {notes.map(n => (
          <div className={`cwNote ${n.pinned ? 'pinned' : ''}`} key={n.id}>
            <span className="cwNoteKind">{NOTE_KIND_LABEL[n.kind] || n.kind}</span>
            <span className="cwNoteText">{n.content}</span>
            <div className="cwNoteActions">
              <button
                title={n.pinned ? 'Desafixar' : 'Fixar (entra sempre no contexto)'}
                aria-label={n.pinned ? 'Desafixar' : 'Fixar'}
                onClick={() => updateNote(n.id, { pinned: !n.pinned })}
              >
                {n.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
              <button title="Apagar" aria-label="Apagar" onClick={() => deleteNote(n.id)}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

// ---- Documentos ---------------------------------------------------------------

function DocsTab({ copilot, name, quiet, showToast }) {
  const { documents, docsLoading, deleteDocument } = copilot;
  const [view, setView] = useState(null);

  if (docsLoading && documents.length === 0) return <div className="cwLoading">Carregando documentos…</div>;
  if (!documents.length) {
    return (
      <div className="cwEmpty docs">
        <span className="cwEmptyFace"><NinoAvatar state="duvida" name={name} quiet={quiet} /></span>
        <b>Ainda não guardei nada por aqui</b>
        <span>Textos que eu revisar, registros de ações e notas ficam nesta caixa — separada dos arquivos das conversas.</span>
      </div>
    );
  }
  return (
    <div className="cwDocs">
      {documents.map(d => (
        <div className="cwDoc" key={d.id}>
          <span className="cwDocIcon"><FileText size={18} /></span>
          <div className="cwDocInfo">
            <b>{d.name}</b>
            <small><span className="cwDocKind">{DOC_KIND_LABEL[d.kind] || d.kind}</span> · {fmtDate(d.createdAt)} · {fmtSize(d.size)}</small>
          </div>
          <div className="cwDocActions">
            <button title="Auditar antes de baixar" aria-label="Auditar antes de baixar" onClick={async () => {
              const result = await copilot.runExecutiveTool('sandbox-audit', { documentId: d.id });
              if (result) showToast?.(result.status === 'aprovado' ? 'Documento aprovado na auditoria.' : `Auditoria: ${result.issues.length} ponto(s) para revisar.`);
            }}><ShieldCheck size={15} /></button>
            <button title="Visualizar" aria-label="Visualizar" onClick={() => setView(d)}><Eye size={15} /></button>
            <a title="Baixar" aria-label="Baixar" href={`${API}/api/copilot/documents/${encodeURIComponent(d.id)}/download`} target="_blank" rel="noreferrer"><Download size={15} /></a>
            <button title="Excluir" aria-label="Excluir" onClick={() => deleteDocument(d.id)}><Trash2 size={15} /></button>
          </div>
        </div>
      ))}
      {view && <DocViewer doc={view} onClose={() => setView(null)} />}
    </div>
  );
}

// ---- Ações executivas --------------------------------------------------------

function ExecutiveActionsTab({ copilot, name, quiet }) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);

  async function run(id) {
    if (id !== 'memory-review' && !content.trim()) return;
    setBusy(id); setResult(null);
    let data = null;
    if (id === 'logic-review' || id === 'optimize-prompt') data = await copilot.runExecutiveAction(id, content);
    else if (id === 'memory-review') data = await copilot.runExecutiveTool(id);
    else if (id === 'model-routing') data = await copilot.runExecutiveTool(id, { prompt: content });
    else data = await copilot.runExecutiveTool(id, { content, name: 'conteúdo colado.txt', mime: 'text/plain' });
    setResult(data); setBusy('');
  }

  const output = formatExecutiveResult(result);
  return (
    <div className="cwExecutive">
      <div className="cwEmpty actions">
        <span className="cwEmptyFace"><NinoAvatar state="analisando" name={name} quiet={quiet} /></span>
        <b>Planejar, auditar e proteger</b>
        <span>Cole um prompt, resposta ou conteúdo. As análises locais não registram os valores sensíveis encontrados.</span>
      </div>
      <textarea value={content} onChange={e => setContent(e.target.value)} rows={7} maxLength={200000} placeholder="Cole aqui o conteúdo que o Nino deve analisar…" aria-label="Conteúdo para ação executiva" />
      <div className="cwExecutiveGrid">
        <button onClick={() => run('sandbox-audit')} disabled={busy || !content.trim()}><ShieldCheck size={15} /> Auditar este documento</button>
        <button onClick={() => run('lgpd-check')} disabled={busy || !content.trim()}><ShieldCheck size={15} /> Verificar LGPD e segredos</button>
        <button onClick={() => run('model-routing')} disabled={busy || !content.trim()}><Gauge size={15} /> Recomendar modelo</button>
        <button onClick={() => run('logic-review')} disabled={busy || !content.trim()}><SearchCheck size={15} /> Buscar furos lógicos</button>
        <button onClick={() => run('optimize-prompt')} disabled={busy || !content.trim()}><Wand2 size={15} /> Otimizar meu prompt</button>
        <button onClick={() => run('memory-review')} disabled={busy}><Brain size={15} /> Resumir e limpar memória</button>
      </div>
      {busy && <div className="cwLoading">{name} está auditando…</div>}
      {output && <pre className="cwExecutiveResult">{output}</pre>}
      {result?.duplicates && <div className="cwDim">Nenhuma nota é apagada automaticamente; o relatório indica o que deve ser consolidado.</div>}
    </div>
  );
}

function formatExecutiveResult(result) {
  if (!result) return '';
  if (result.result) return result.result;
  if (result.tier) return [
    `Modelo recomendado: ${result.tier}`,
    `Complexidade estimada: ${result.complexityScore}/100`,
    ...(result.reasons || []).map(reason => `• ${reason}`),
    '', result.recommendation,
  ].join('\n');
  if (Array.isArray(result.issues)) return [
    `Resultado da auditoria: ${result.status}`,
    `Escopo verificado: ${result.scope}`,
    ...(result.issues.length ? result.issues.map(issue => `• ${issue.message}`) : ['• Nenhum problema evidente encontrado.']),
  ].join('\n');
  if (Array.isArray(result.findings)) return [
    `Resultado de privacidade: ${result.status}`,
    ...(result.findings.length ? result.findings.map(item => `• ${item.count} ocorrência(s) de ${item.label}`) : ['• Nenhum padrão evidente encontrado.']),
    '', result.recommendation,
  ].join('\n');
  if (Array.isArray(result.duplicates)) return [
    `Estado da memória: ${result.status}`,
    `Notas analisadas: ${result.totalNotes}`,
    `Grupos duplicados: ${result.duplicates.length}`,
    `Notas com dados sensíveis: ${result.sensitive?.length || 0}`,
    '', result.recommendation,
  ].join('\n');
  return 'Análise concluída.';
}

function DocViewer({ doc, onClose }) {
  const [content, setContent] = useState(doc.content ?? null);
  const [loading, setLoading] = useState(content == null);
  useEffect(() => {
    if (content != null) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API}/api/copilot/documents/${encodeURIComponent(doc.id)}`);
        if (r.ok && alive) { const d = await r.json(); setContent(d.content || ''); }
      } catch { if (alive) setContent(''); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [doc.id]); // eslint-disable-line

  return (
    <Modal title={doc.name} icon={<FileText size={18} />} onClose={onClose} className="cwDocModal">
      {loading ? <div className="cwLoading">Carregando…</div> : <pre className="cwDocContent">{content}</pre>}
      <div className="cwDocModalFoot">
        <a className="primary" href={`${API}/api/copilot/documents/${encodeURIComponent(doc.id)}/download`} target="_blank" rel="noreferrer"><Download size={14} /> Baixar</a>
        <button className="ghost" onClick={onClose}><X size={14} /> Fechar</button>
      </div>
    </Modal>
  );
}
