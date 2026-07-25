// Visão multimodal: monta as imagens dos uploads como partes image_url (base64)
// e anexa/remove essas partes nas mensagens enviadas ao modelo.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import fs from 'fs';
import path from 'path';
import { workspaceFor } from '../sandbox.js';

const IMAGE_UPLOAD_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const VISION_MAX_IMAGES = 4;
const VISION_MAX_BYTES = 8 * 1024 * 1024; // ignora imagens acima de 8 MB no envio direto

// VISÃO MULTIMODAL: monta as imagens dos uploads como partes image_url (base64)
// para enviar direto ao modelo — só usado quando o modelo TEM visão. As mais
// recentes primeiro, com limites de quantidade e tamanho.
export function imageUploadParts(userId, conversationId) {
  let dir;
  try { dir = workspaceFor(conversationId, userId).uploads; } catch { return []; }
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter(n => IMAGE_UPLOAD_RE.test(n))
      .map(n => { const p = path.join(dir, n); let mt = 0, size = 0; try { const s = fs.statSync(p); mt = s.mtimeMs; size = s.size; } catch {} return { n, p, mt, size }; })
      .filter(f => f.size > 0 && f.size <= VISION_MAX_BYTES)
      .sort((a, b) => b.mt - a.mt)
      .slice(0, VISION_MAX_IMAGES);
  } catch { return []; }
  const parts = [];
  for (const f of entries) {
    try {
      const ext = path.extname(f.n).slice(1).toLowerCase().replace('jpg', 'jpeg');
      const b64 = fs.readFileSync(f.p).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:image/${ext};base64,${b64}` } });
    } catch {}
  }
  return parts;
}

// Anexa as imagens à ÚLTIMA mensagem do usuário (formato multimodal). Retorna
// true se anexou algo. Modelos sem visão não passam por aqui (usam OCR).
export function attachImagesToLastUserMessage(messages, imageParts) {
  if (!imageParts.length) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const txt = typeof messages[i].content === 'string' ? messages[i].content : '';
      messages[i] = { role: 'user', content: [{ type: 'text', text: txt || 'Analise a(s) imagem(ns) enviada(s).' }, ...imageParts] };
      return true;
    }
  }
  return false;
}

// Remove as imagens anexadas (volta o conteúdo do usuário para texto puro),
// usado no fallback quando o modelo recusa imagem.
export function stripImagePartsFromMessages(messages) {
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      m.content = m.content.find(p => p?.type === 'text')?.text || '';
    }
  }
}
