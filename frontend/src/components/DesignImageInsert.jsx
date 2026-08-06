// Botão "Inserir imagem" do Modo Design.
//
// Fluxo:
//   1) o usuário clica no botão (a barra acima da prévia);
//   2) abre um diálogo com campo de prompt + lista das imagens já geradas;
//   3) "Gerar imagem" chama a API; em sucesso, o registro (id, src) volta;
//   4) a interface REESCREVE o artefato (HTML ou JSON de slides) para incluir
//      um <img src="/api/design/images/:id"> no ponto certo, e pede uma nova
//      geração para o modelo "ver" o resultado.
//
// O passo 4 é o que conecta a imagem ao design. Antes desta frente, a
// geração de imagens existia só no chat — o Modo Design não a consumia.
//
// A imagem é servida por uma rota SEM SESSÃO (origin opaca do iframe não
// envia cookie); o `src` devolvido pela API já traz o token de preview.
import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Sparkles, Trash2, X, Loader2 } from 'lucide-react';

// Limite do prompt de imagem — é o que o backend aceita, e o que o campo
// da interface também respeita para o erro aparecer antes da requisição.
const MAX_PROMPT = 1000;

export function DesignImageInsert({ projectId, busy, model, onGenerate, onList, onRemove, onApply }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [pendingSrc, setPendingSrc] = useState(null);

  // Carrega a lista sempre que o diálogo abre — pode haver imagens de uma
  // sessão anterior que o usuário quer reaproveitar.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    onList(projectId).then(list => { if (alive) setImages(Array.isArray(list) ? list : []); });
    return () => { alive = false; };
  }, [open, projectId, onList]);

  async function submit(e) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || generating) return;
    setGenerating(true);
    setPendingSrc(null);
    try {
      const result = await onGenerate(projectId, text, model);
      if (result) {
        // O src volta com ?token=... — o iframe não envia cookie, o token é
        // a autorização. O backend aceita ambos os caminhos.
        setPendingSrc(result);
        setImages(prev => [{
          id: result.id,
          prompt: result.prompt || text,
          mime: result.mime,
          byteSize: result.byteSize,
          model: result.model,
          createdAt: result.createdAt,
          src: result.src,
        }, ...prev]);
        setPrompt('');
      }
    } finally {
      setGenerating(false);
    }
  }

  async function remove(image) {
    await onRemove(projectId, image.id);
    setImages(prev => prev.filter(i => i.id !== image.id));
    if (pendingSrc?.id === image.id) setPendingSrc(null);
  }

  function apply(image) {
    onApply(image);
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" className="dsGhost" onClick={() => setOpen(true)} title="Inserir uma imagem gerada por IA">
        <ImageIcon size={14} /> Imagem
      </button>
    );
  }

  return (
    <div className="dsImageDialog" role="dialog" aria-label="Inserir imagem">
      <div className="dsImageDialogHead">
        <h3><Sparkles size={14} /> Imagem por IA</h3>
        <button type="button" onClick={() => setOpen(false)} aria-label="Fechar"><X size={14} /></button>
      </div>
      <form className="dsImageForm" onSubmit={submit}>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value.slice(0, MAX_PROMPT))}
          placeholder="Descreva a imagem (estilo, cores, composição)…"
          rows={3}
          maxLength={MAX_PROMPT}
          disabled={generating}
          aria-label="Descrição da imagem"
        />
        <div className="dsImageFormRow">
          <small>{prompt.length}/{MAX_PROMPT}</small>
          <button type="submit" className="dsPrimary" disabled={!prompt.trim() || generating}>
            {generating ? <><Loader2 size={14} className="spin" /> Gerando…</> : <><Sparkles size={14} /> Gerar imagem</>}
          </button>
        </div>
      </form>
      {pendingSrc && (
        <div className="dsImagePreview">
          <img src={pendingSrc.src} alt={pendingSrc.prompt} />
          <div className="dsImagePreviewActions">
            <button type="button" className="dsPrimary" onClick={() => apply(pendingSrc)}>
              Inserir no design
            </button>
          </div>
        </div>
      )}
      {images.length > 0 && (
        <div className="dsImageList">
          <h4>Geradas neste projeto</h4>
          <ul>
            {images.map(image => (
              <li key={image.id}>
                <img src={image.src} alt={image.prompt} />
                <div className="dsImageMeta">
                  <p title={image.prompt}>{image.prompt}</p>
                  <small>{(image.byteSize / 1024).toFixed(1)} KB</small>
                </div>
                <div className="dsImageActions">
                  <button type="button" className="dsGhost" onClick={() => apply(image)}>Inserir</button>
                  <button type="button" className="dsGhost danger" onClick={() => remove(image)} aria-label="Apagar imagem">
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {busy && <p className="dsHint">A geração do design está em andamento — aguarde para gerar a imagem.</p>}
    </div>
  );
}
