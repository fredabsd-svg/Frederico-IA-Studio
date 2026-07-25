import React, { useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../constants.js';
import { Drawer, Modal } from '../components.jsx';
import { PROMPT_ACTIONS, buildCoachMessage } from '../promptCoach.js';
import {
  MessageSquare, FolderOpen, Send, Trash2, Eraser, Bell,
  FileText, Download, Eye, X, Wand2,
} from 'lucide-react';
import { NinoAvatar, NINO_CAPTION } from './NinoAvatar.jsx';

const DOC_KIND_LABEL = {
  texto: 'Nota', texto_revisado: 'Texto revisado', log: 'Registro', print: 'Captura', relatorio: 'Relatório',
};

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; }
}
function fmtSize(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} B`;
  return `${Math.ceil(b / 1024)} KB`;
}

// O espaço PRÓPRIO do copiloto: aberto pelo avatar, com duas abas — Chat (com
// contexto isolado do chat principal) e Documentos (a caixa própria dele).
// O cabeçalho agora traz o personagem e a legenda do estado ao vivo, em vez de
// um ícone genérico.
export function CopilotWorkspace({ copilot, companion, state = 'aguardando', onClose }) {
  const [tab, setTab] = useState('chat');
  const name = companion?.settings?.characterName || 'Nino';
  const quiet = companion?.settings?.animationLevel === 'nenhum';
  const unread = useMemo(
    () => (companion?.events || []).filter(e => e.status === 'novo' || e.status === 'visto'),
    [companion?.events]
  );

  useEffect(() => { copilot.loadChat(); }, []); // eslint-disable-line
  useEffect(() => { if (tab === 'docs') copilot.loadDocuments(); }, [tab]); // eslint-disable-line

  const face = <span className="cwHeadFace"><NinoAvatar state={state} name={name} quiet={quiet} /></span>;

  return (
    <Drawer title={name} icon={face} onClose={onClose} className="cwDrawer">
      <div className="cwCaption">{NINO_CAPTION[state] || NINO_CAPTION.aguardando}</div>

      <div className="cwTabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          <MessageSquare size={14} /> Conversa
        </button>
        <button role="tab" aria-selected={tab === 'docs'} className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>
          <FolderOpen size={14} /> Documentos {copilot.documents.length > 0 && <span className="cwCount">{copilot.documents.length}</span>}
        </button>
      </div>

      {tab === 'chat'
        ? <ChatTab copilot={copilot} companion={companion} name={name} unread={unread} quiet={quiet} />
        : <DocsTab copilot={copilot} name={name} quiet={quiet} />}
    </Drawer>
  );
}

function ChatTab({ copilot, companion, name, unread, quiet }) {
  const { messages, sending, loading, error, send, clearChat } = copilot;
  const [text, setText] = useState('');
  const [tools, setTools] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  function submit(e) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    send(t);
    setText('');
  }
  function runTool(actionId) {
    const draft = text.trim();
    if (!draft) return;
    const msg = buildCoachMessage(actionId, draft);
    if (msg) { send(msg); setText(''); setTools(false); }
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
              <button className="cwLink" onClick={() => companion.dismissEvent(e.id)}>Dispensar</button>
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
            <span>Este é o nosso canto — separado do chat principal. Me use para revisar textos, lapidar prompts, organizar ideias ou tirar dúvidas do Studio.</span>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`cwMsg ${m.role} ${m.pending ? 'pending' : ''}`}>
            {m.role === 'assistant' && <span className="cwMsgFace"><NinoAvatar state="aguardando" name={name} quiet={quiet} /></span>}
            <div className="cwBubble">{m.content}</div>
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

      <form className="cwComposer" onSubmit={submit}>
        <button type="button" className={`cwToolBtn ${tools ? 'on' : ''}`} title="Ferramentas de prompt" aria-label="Ferramentas de prompt" onClick={() => setTools(t => !t)}>
          <Wand2 size={16} />
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
        <button className="cwClear" onClick={clearChat}><Eraser size={12} /> Limpar histórico</button>
      )}
    </div>
  );
}

function DocsTab({ copilot, name, quiet }) {
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
