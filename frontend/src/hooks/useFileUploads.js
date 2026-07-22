import { useRef, useState } from 'react';
import { API } from '../constants.js';

// Upload de anexos (botão, arrastar-e-soltar, colar e câmera) + exclusão.
// Recebe as dependências do App por parâmetro e devolve { estado, ações }.
export function useFileUploads({ current, ensureConversation, loadFiles, showToast, askConfirm }) {
  const [dragActive, setDragActive] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [scanOk, setScanOk] = useState(false); // "✓ verificado pelo antivírus" após upload escaneado
  const dragDepth = useRef(0);
  const pendingUploads = useRef(new Set());

  async function deleteFile(f) {
    if (!current) return;
    const confirmed = await askConfirm({
      title: 'Excluir arquivo?',
      message: `"${f.name}" será removido desta conversa.`,
      confirmLabel: 'Excluir arquivo',
      destructive: true
    });
    if (!confirmed) return;
    try {
      const encoded = f.path.split('/').map(encodeURIComponent).join('/');
      await fetch(`${API}/api/conversations/${current.id}/files/${encoded}`, { method: 'DELETE' });
      await loadFiles();
    } catch {
      showToast('Não foi possível excluir o arquivo.');
    }
  }

  async function uploadSelectedFiles(selected, source = 'input') {
    const filesToUpload = [...(selected || [])].filter(Boolean);
    if (!filesToUpload.length) return;
    const task = (async () => {
      let conv = current;
      if (!conv) { conv = await ensureConversation(); if (!conv) return []; }
      const fd = new FormData();
      filesToUpload.forEach(f => fd.append('files', f));
      const res = await fetch(`${API}/api/conversations/${conv.id}/upload`, { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      await loadFiles(conv.id);
      if (d.rejected?.length) {
        showToast(`🛡️ Antivírus: ${d.rejected.length} arquivo(s) recusado(s) por conter ameaça: ${d.rejected.map(r => r.name).join(', ')}`);
      } else if (source !== 'input') {
        showToast(`${filesToUpload.length} arquivo(s) anexado(s)${d.scanned ? ' e verificado(s) pelo antivírus ✓' : ''}.`, 'ok');
      }
      if (d.scanned && !d.rejected?.length) {
        setScanOk(true);
        setTimeout(() => setScanOk(false), 5000);
      }
      return d.files || [];
    })();
    pendingUploads.current.add(task);
    setUploadingFiles(true);
    try {
      return await task;
    } catch (err) {
      showToast(err?.message || 'Falha no envio do arquivo. Verifique o tamanho (máx. 50 MB) e tente de novo.');
      return [];
    } finally {
      pendingUploads.current.delete(task);
      setUploadingFiles(pendingUploads.current.size > 0);
    }
  }

  // O envio da mensagem chama esta barreira antes do POST /chat. Mesmo se o
  // clique/Enter acontecer no mesmo frame em que o upload começou, a conversa
  // só segue depois que todos os arquivos foram gravados e relidos do backend.
  async function waitForUploads(conversationId) {
    while (pendingUploads.current.size) {
      await Promise.allSettled([...pendingUploads.current]);
    }
    return conversationId ? (await loadFiles(conversationId) || []) : [];
  }

  async function uploadFiles(e) {
    await uploadSelectedFiles(e.target.files, 'input');
    e.target.value = '';
  }

  function hasDraggedFiles(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
  }
  function onDragEnter(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }
  function onDragOver(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }
  async function onDrop(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    await uploadSelectedFiles(e.dataTransfer.files, 'drop');
  }
  async function onPasteFiles(e) {
    const pasted = Array.from(e.clipboardData?.files || []);
    if (!pasted.length) return;
    e.preventDefault();
    await uploadSelectedFiles(pasted, 'paste');
  }

  return {
    dragActive, uploadingFiles, scanOk,
    deleteFile, uploadSelectedFiles, uploadFiles, waitForUploads,
    onDragEnter, onDragOver, onDragLeave, onDrop, onPasteFiles
  };
}
