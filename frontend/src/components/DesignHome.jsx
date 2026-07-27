import React from 'react';
import { Layout, Presentation, FileText, Plus, Trash2, Palette, Sparkles } from 'lucide-react';
import { outputTypeMeta, formatWhen } from '../design/designCore.js';

const TYPE_ICON = { web: Layout, slides: Presentation, document: FileText };

// Lista de projetos de design. O estado VAZIO é a primeira coisa que quase todo
// usuário vê — por isso ele explica o que o modo faz e leva direto à ação, em
// vez de mostrar só "nenhum projeto".
export function DesignHome({ projects, loading, onNew, onOpen, onDelete, onOpenSystems }) {
  return (
    <div className="dsHome">
      <header className="dsHomeHead">
        <div>
          <h2>Modo Design</h2>
          <p>Descreva um site, uma apresentação ou um documento e refine o resultado conversando.</p>
        </div>
        <div className="dsHomeActions">
          <button type="button" className="dsGhost" onClick={onOpenSystems}><Palette size={15} /> Minha marca</button>
          <button type="button" className="dsPrimary" onClick={onNew}><Plus size={16} /> Novo projeto</button>
        </div>
      </header>

      {loading && !projects.length && <div className="dsEmpty"><span className="spin" /> Carregando seus projetos…</div>}

      {!loading && !projects.length && (
        <div className="dsEmpty dsEmptyRich">
          <span className="dsEmptyIcon"><Sparkles size={26} /></span>
          <b>Nenhum projeto de design ainda</b>
          <p>
            No Modo Design a IA devolve um rascunho <strong>visual e renderizado</strong> — não um bloco de código para
            você montar. Cada pedido de mudança vira uma versão nova, e dá para voltar atrás a qualquer momento.
          </p>
          <button type="button" className="dsPrimary" onClick={onNew}><Plus size={16} /> Criar o primeiro</button>
        </div>
      )}

      {!!projects.length && (
        <ul className="dsGrid">
          {projects.map(project => {
            const meta = outputTypeMeta(project.outputType);
            const Icon = TYPE_ICON[project.outputType] || Layout;
            return (
              <li key={project.id}>
                <button type="button" className="dsCard" onClick={() => onOpen(project.id)}>
                  <span className="dsCardTop">
                    <span className="dsCardIcon"><Icon size={16} /></span>
                    <span className="dsCardType">{meta.short}</span>
                  </span>
                  <b className="dsCardTitle">{project.title}</b>
                  <span className="dsCardMeta">
                    {project.versionCount
                      ? `v${project.currentVersionNumber || project.versionCount} · ${project.versionCount} ${project.versionCount === 1 ? 'versão' : 'versões'}`
                      : 'Sem versão ainda'}
                    {' · '}{formatWhen(project.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="dsCardDel"
                  title="Apagar projeto"
                  aria-label={`Apagar ${project.title}`}
                  onClick={() => onDelete(project)}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
