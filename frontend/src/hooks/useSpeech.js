import { useRef, useState } from 'react';

// ---- Ditado por voz (Web Speech API) ----
// Recebe as dependências do App por parâmetro e devolve { estado, ações }.
export function useSpeech({ input, setInput, showToast }) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast('Seu navegador não suporta ditado por voz. Use o Google Chrome ou o Microsoft Edge.'); return; }
    if (listening) { recognitionRef.current?.stop(); return; }
    const rec = new SR();
    rec.lang = 'pt-BR';
    rec.interimResults = true;
    rec.continuous = true;
    let base = input;
    rec.onresult = (e) => {
      let finalT = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalT += t; else interim += t;
      }
      if (finalT) base = (base ? base + ' ' : '') + finalT.trim();
      setInput((base + (interim ? ' ' + interim : '')).trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }

  return { listening, recognitionRef, toggleMic };
}
