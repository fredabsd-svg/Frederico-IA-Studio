// Captura de foto pela câmera (web). No notebook abre a webcam (getUserMedia);
// no celular abre a câmera traseira. Se a permissão for negada ou não houver
// câmera, oferece enviar uma foto da galeria/arquivos. A imagem é comprimida
// (canvas → JPEG) antes de virar anexo, para ficar leve e boa para OCR.
import React, { useEffect, useRef, useState } from 'react';
import { X, RotateCcw, RefreshCw, ImageUp, Check, Camera } from 'lucide-react';
import { useDialogFocus } from './components.jsx';

const MAX_DIM = 2000;        // maior lado da imagem (px) — leve e legível
const JPEG_QUALITY = 0.85;

// Desenha uma fonte (vídeo ou imagem) num canvas reduzido ao maior lado MAX_DIM.
function drawScaled(source, srcW, srcH, maxDim = MAX_DIM) {
  let width = srcW, height = srcH;
  const longest = Math.max(width, height);
  if (longest > maxDim) {
    const s = maxDim / longest;
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  return canvas;
}

function canvasToFile(canvas, name) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(new File([blob], name, { type: 'image/jpeg' })) : reject(new Error('sem blob')),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

// Comprime uma imagem escolhida da galeria/arquivos (reduz e converte para JPEG).
export async function compressImageFile(file) {
  if (!file || !/^image\//i.test(file.type)) return file; // só imagens
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('imagem inválida'));
      i.src = url;
    });
    const canvas = drawScaled(img, img.naturalWidth, img.naturalHeight);
    const base = (file.name || 'foto').replace(/\.[^.]+$/, '') || 'foto';
    return await canvasToFile(canvas, `${base}.jpg`);
  } catch {
    return file; // se algo falhar, envia o original
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const capturedRef = useRef(null);
  const dialogRef = useRef(null);
  // Número da abertura de câmera em curso. O getUserMedia pode demorar (a
  // pessoa ainda está decidindo no aviso de permissão): se o modal fechar ou
  // "Refazer" pedir outra câmera nesse meio-tempo, o fluxo que chegar atrasado
  // não é mais o atual e precisa desligar o próprio fluxo — senão a luz da
  // câmera ficava acesa depois de o modal sumir.
  const startSeq = useRef(0);
  const [stage, setStage] = useState('loading'); // loading | live | review | error
  const [errorMsg, setErrorMsg] = useState('');
  const [preview, setPreview] = useState(null);

  function stopStream() {
    const s = streamRef.current;
    if (s) { s.getTracks().forEach(t => { try { t.stop(); } catch {} }); streamRef.current = null; }
  }

  async function start(facingMode = 'environment') {
    const seq = ++startSeq.current;
    stopStream();
    setStage('loading'); setErrorMsg('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setStage('error');
      setErrorMsg('Seu navegador não abre a câmera aqui. Você pode enviar uma foto da galeria ou dos arquivos.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
      if (seq !== startSeq.current) {
        stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStage('live');
    } catch (err) {
      if (seq !== startSeq.current) return; // fechado/reaberto enquanto esperava
      setStage('error');
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setErrorMsg('Permissão da câmera negada. Para liberar: toque no cadeado/ícone à esquerda do endereço → Permissões → Câmera → Permitir, e tente de novo. Ou envie uma foto da galeria/arquivos abaixo.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setErrorMsg('Não encontrei uma câmera disponível neste aparelho. Você pode enviar uma foto da galeria/arquivos.');
      } else {
        setErrorMsg('Não consegui abrir a câmera agora. Você pode enviar uma foto da galeria/arquivos.');
      }
    }
  }

  // Inicia uma vez; ao fechar, invalida a abertura pendente e encerra o fluxo.
  useEffect(() => {
    start('environment');
    return () => { startSeq.current++; stopStream(); };
  }, []);
  // Esc fecha, Tab fica dentro e o foco volta a quem abriu a câmera.
  useDialogFocus(dialogRef, onClose);

  async function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    try {
      const canvas = drawScaled(video, video.videoWidth, video.videoHeight);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const file = await canvasToFile(canvas, `foto-${stamp}.jpg`);
      capturedRef.current = file;
      setPreview(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      stopStream();               // congela a foto (para a luz da câmera)
      setStage('review');
    } catch {
      setErrorMsg('Não consegui capturar a foto. Tente novamente.');
      setStage('error');
    }
  }

  function usar() {
    if (capturedRef.current) onCapture(capturedRef.current);
  }

  async function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const compressed = await compressImageFile(file);
    onCapture(compressed);
  }

  return (
    <div className="camOverlay">
      <div ref={dialogRef} className="camModal" role="dialog" aria-modal="true" aria-label="Tirar foto" tabIndex={-1}>
        <div className="camHead">
          <span className="camTitle"><Camera size={18} /> Tirar foto</span>
          <button className="camX" onClick={onClose} aria-label="Fechar a câmera" title="Fechar"><X size={18} /></button>
        </div>

        <div className="camBody">
          {stage === 'loading' && (
            <div className="camMsg"><span className="spin" /> <span>Abrindo a câmera…</span></div>
          )}

          {stage === 'error' && (
            <div className="camMsg camError">
              <p>{errorMsg}</p>
            </div>
          )}

          {(stage === 'live' || stage === 'loading') && (
            <video ref={videoRef} className="camVideo" autoPlay playsInline muted
              style={{ display: stage === 'live' ? 'block' : 'none' }} />
          )}

          {stage === 'review' && preview && (
            <img className="camVideo" src={preview} alt="Foto capturada" />
          )}
        </div>

        <div className="camControls">
          {stage === 'live' && (
            <button className="camBtn camPrimary" onClick={capture}>
              <Camera size={18} /> Capturar
            </button>
          )}
          {stage === 'review' && (
            <>
              <button className="camBtn" onClick={() => start('environment')}>
                <RotateCcw size={16} /> Refazer
              </button>
              <button className="camBtn camPrimary" onClick={usar}>
                <Check size={18} /> Usar foto
              </button>
            </>
          )}
          {stage === 'error' && (
            <button className="camBtn" onClick={() => start('environment')}>
              <RefreshCw size={16} /> Tentar a câmera de novo
            </button>
          )}

          {/* Reserva sempre disponível: enviar da galeria/arquivos */}
          {stage !== 'review' && (
            <button className="camBtn" onClick={() => fileRef.current?.click()}>
              <ImageUp size={16} /> Enviar da galeria
            </button>
          )}
        </div>
      </div>
      {/* Fora do diálogo de propósito: o <input> oculto entraria na volta do Tab. */}
      <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} style={{ display: 'none' }} />
    </div>
  );
}
