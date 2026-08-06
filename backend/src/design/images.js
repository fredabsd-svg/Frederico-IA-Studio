// Geração e leitura de imagens do Modo Design.
//
// O que este módulo faz:
//   1) gera uma imagem via OpenRouter (modalities: ['image','text']) usando a
//      MESMA política de escolha de credencial do `generate_image` do chat
//      (resolveImageProvider) — a chave é da conta do usuário, escolhida por
//      capacidade, não por antiguidade;
//   2) grava o binário no banco (BYTEA), com teto por imagem e por projeto;
//   3) serve a imagem por id, com sessão OU com o token de preview do projeto
//      (o iframe roda em origem opaca e não envia cookie).
//
// O que este módulo NÃO faz:
//   - não edita imagens (a entrada `input_image` do generate_image do chat não
//     está exposta aqui — o Design não tem upload de imagem de origem);
//   - não gera mais de uma imagem por chamada (uma por vez é o que o botão
//     "Inserir imagem" da interface pede; múltiplas é frente futura);
//   - não persiste a referência no artefato — quem faz isso é a interface,
//     reescrevendo o HTML/JSON com `<img src="/api/design/images/:id">`.

import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { resolveImageProvider } from '../imageProvider.js';
import { compressIfWorthy } from './compress.js';

// Limites. O teto por imagem é o que o OpenRouter costuma devolver; o teto por
// projeto impede que um usuário gere 200 imagens de 5 MB e infle o banco.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;        // 5 MB
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;     // 50 MB
const MAX_PROMPT_CHARS = 1000;
const FETCH_TIMEOUT_MS = 120_000;

// Mimes que aceitamos do provedor. O OpenRouter devolve image/png ou image/jpeg
// na prática; webp aparece em alguns modelos. Aceitar e gravar o que veio é
// melhor do que converter do lado do app (e mais barato).
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function clampPrompt(value) {
  return String(value || '').trim().slice(0, MAX_PROMPT_CHARS);
}

// Soma os bytes já guardados para um projeto. Usado ANTES de gravar uma nova
// imagem para garantir que o teto por projeto não foi ultrapassado.
async function projectBytesUsed(projectId) {
  const row = await db.prepare(
    'SELECT COALESCE(SUM(byte_size),0) AS total FROM design_images WHERE project_id=?'
  ).get(projectId);
  return Number(row?.total || 0);
}

// Decodifica a imagem devolvida pelo OpenRouter. O formato é o mesmo do
// `generate_image` do chat: `data:image/<mime>;base64,<...>` em
// `choices[0].message.images[].image_url.url`. Reaproveitar o caminho evita
// divergir do que o chat já faz — uma mudança no provedor cai nos dois.
// Exportada para teste: o caminho de decodificação é o ponto onde um mime
// novo do provedor viraria 502 sem motivo — vale a pena guardar.
export function decodeProviderImage(data) {
  const images = data?.choices?.[0]?.message?.images || [];
  for (const img of images) {
    const url = img?.image_url?.url || img?.url || '';
    const m = /^data:image\/(\w+);base64,(.+)$/s.exec(url);
    if (!m) continue;
    const mime = `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`;
    if (!ALLOWED_MIMES.has(mime)) continue;
    return { mime, buffer: Buffer.from(m[2], 'base64') };
  }
  return null;
}

// Faz a chamada ao provedor. Devolve `{ ok, buffer, mime, model, usage }` ou
// `{ ok:false, error, code, status }`. Nunca lança — o chamador decide o que
// devolver ao usuário.
async function callImageProvider(provider, model, prompt, signal) {
  const base = String(provider.baseURL || '').replace(/\/$/, '');
  if (!base) return { ok: false, error: 'Provedor sem URL base configurada.', code: 'IMAGE_SEM_BASE_URL' };
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason || 'aborted');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort('timeout'), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        modalities: ['image', 'text'],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = String(data?.error?.message || data?.message || '').slice(0, 200);
      const nome = provider.providerName || provider.providerType || 'provedor';
      if (r.status === 401 || r.status === 403) {
        return { ok: false, error: `A chave do ${nome} foi recusada ao gerar imagem (HTTP ${r.status}).${detail ? ' ' + detail : ''}`, code: 'IMAGE_CHAVE_RECUSADA', status: r.status };
      }
      if (r.status === 402) {
        return { ok: false, error: `Créditos insuficientes no ${nome} para gerar imagem.${detail ? ' ' + detail : ''}`, code: 'IMAGE_SEM_CREDITO', status: r.status };
      }
      return { ok: false, error: `Geração de imagem falhou no ${nome} (HTTP ${r.status}) com o modelo "${model}".${detail ? ' ' + detail : ''}`, code: 'IMAGE_FALHA_PROVEDOR', status: r.status };
    }
    const decoded = decodeProviderImage(data);
    if (!decoded) {
      const text = String(data?.choices?.[0]?.message?.content || '').slice(0, 200);
      return { ok: false, error: `O modelo "${model}" não retornou imagem. Resposta: ${text}`, code: 'IMAGE_SEM_RETORNO' };
    }
    return {
      ok: true,
      buffer: decoded.buffer,
      mime: decoded.mime,
      model: data?.model || model,
      usage: data?.usage || null,
    };
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      return { ok: false, error: 'A geração de imagem foi cancelada.', code: 'IMAGE_CANCELADA' };
    }
    return { ok: false, error: `Não consegui falar com o provedor de imagem agora. ${err?.message || ''}`.trim(), code: 'IMAGE_REDE' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Gera uma imagem para um projeto do Design. Devolve `{ ok, id, mime, src }` ou
// `{ ok:false, error, code, status }`. `src` é o caminho RELATIVO que a
// interface usa no `<img src>` — o iframe está em origem opaca e não envia
// cookie, então a URL precisa ser absoluta (com o host do backend) para o
// navegador resolver.
export async function generateDesignImage({ userId, projectId, prompt, model = '', signal }) {
  const cleanPrompt = clampPrompt(prompt);
  if (!cleanPrompt) return { ok: false, error: 'Descreva a imagem que você quer.', code: 'IMAGE_PROMPT_VAZIO' };

  // Confirma que o projeto é do usuário. Sem isso, um userId válido + projectId
  // de outro usuário geraria uma imagem na conta alheia.
  const project = await db.prepare('SELECT id FROM design_projects WHERE id=? AND user_id=?').get(projectId, userId);
  if (!project) return { ok: false, error: 'Projeto de design não encontrado.', code: 'NOT_FOUND', status: 404 };

  const choice = await resolveImageProvider(userId, model);
  if (choice.error) return { ok: false, error: choice.error, code: choice.code, status: 400 };

  const used = await projectBytesUsed(projectId);
  if (used >= MAX_PROJECT_BYTES) {
    return {
      ok: false,
      error: `Este projeto já tem ${(used / 1024 / 1024).toFixed(1)} MB de imagens (teto: ${MAX_PROJECT_BYTES / 1024 / 1024} MB). Apague uma imagem do histórico para liberar espaço.`,
      code: 'IMAGE_PROJETO_CHEIO',
      status: 413,
    };
  }

  const result = await callImageProvider(choice.provider, choice.model, cleanPrompt, signal);
  if (!result.ok) return { ok: false, error: result.error, code: result.code, status: result.status || 502 };

  // Compressão transparente. Roda ANTES da checagem de cota: o teto vale sobre
  // o que vai para o banco, e o que vai para o banco pode ser menor que o que
  // o provedor devolveu. Falha do compressor = input intacto (não perdemos a
  // imagem por causa da otimização).
  const compression = await compressIfWorthy(result.buffer, result.mime);
  const finalBuffer = compression.buffer;
  const finalMime = compression.mime;

  if (finalBuffer.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `A imagem devolvida pelo modelo tem ${(finalBuffer.length / 1024 / 1024).toFixed(1)} MB, acima do teto de ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Tente um pedido mais simples.`,
      code: 'IMAGE_MUITO_GRANDE',
      status: 413,
    };
  }
  if (used + finalBuffer.length > MAX_PROJECT_BYTES) {
    return {
      ok: false,
      error: `Esta imagem lotaria o espaço do projeto (${((used + finalBuffer.length) / 1024 / 1024).toFixed(1)} MB de ${MAX_PROJECT_BYTES / 1024 / 1024} MB). Apague uma imagem do histórico antes de gerar outra.`,
      code: 'IMAGE_PROJETO_CHEIO',
      status: 413,
    };
  }

  const id = nanoid();
  const t = now();
  const orig = compression.original;
  await db.prepare(
    `INSERT INTO design_images (id,user_id,project_id,prompt,mime,byte_size,data,model,created_at,original_mime,original_size,original_data,compressed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, userId, projectId, cleanPrompt, finalMime, finalBuffer.length, finalBuffer, result.model || null, t,
    orig ? orig.mime : null,
    orig ? orig.size : null,
    orig ? orig.data : null,
    orig ? t : null,
  );

  if (result.usage) {
    await db.prepare(
      `INSERT INTO usage (id,user_id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(nanoid(), userId, null, null, result.model || choice.model, 'design_image',
      result.usage.prompt_tokens || 0, result.usage.completion_tokens || 0, result.usage.total_tokens || 0, t);
  }

  return {
    ok: true,
    id,
    mime: finalMime,
    byteSize: finalBuffer.length,
    prompt: cleanPrompt,
    model: result.model || choice.model,
    createdAt: t,
    compression: compression.changed
      ? {
          saved: compression.bytesSaved || 0,
          originalMime: orig.mime,
          originalSize: orig.size,
          reason: compression.reason,
        }
      : { changed: false, reason: compression.reason },
  };
}

// Lê uma imagem. Aceita sessão do dono OU o token de preview do projeto (o
// iframe é origem opaca e não envia cookie). Devolve `{ ok, mime, buffer }` ou
// `{ ok:false, status, error }`.
export async function readDesignImage({ imageId, userId = '', previewToken = '' }) {
  if (!imageId) return { ok: false, status: 400, error: 'Imagem não informada.' };

  // Caminho com sessão: o dono (ou alguém da mesma conta) lê a imagem.
  if (userId) {
    const row = await db.prepare(
      'SELECT mime, data, user_id, project_id FROM design_images WHERE id=? AND user_id=?'
    ).get(imageId, userId);
    if (!row) return { ok: false, status: 404, error: 'Imagem não encontrada.' };
    return { ok: true, mime: row.mime, buffer: row.data };
  }

  // Caminho com token: o iframe do preview. O token precisa ser válido E
  // apontar para o projeto DONO da imagem — sem essa segunda cláusula, um
  // token de preview de um projeto A leria imagens do projeto B.
  if (previewToken) {
    if (previewToken.length < 16) return { ok: false, status: 404, error: 'Imagem não encontrada.' };
    const row = await db.prepare(
      `SELECT i.mime, i.data
         FROM design_images i
         JOIN design_projects p ON p.id = i.project_id
        WHERE i.id=? AND p.preview_token=?`
    ).get(imageId, previewToken);
    if (!row) return { ok: false, status: 404, error: 'Imagem não encontrada.' };
    return { ok: true, mime: row.mime, buffer: row.data };
  }

  return { ok: false, status: 401, error: 'Sessão ou token de preview necessário.' };
}

// Lista as imagens de um projeto (sem o binário — só metadados). Usado pela
// interface para mostrar o histórico e permitir apagar.
export async function listDesignImages(userId, projectId) {
  const project = await db.prepare('SELECT id FROM design_projects WHERE id=? AND user_id=?').get(projectId, userId);
  if (!project) return [];
  const rows = await db.prepare(
    `SELECT id, prompt, mime, byte_size, model, created_at,
            original_mime, original_size, compressed_at
       FROM design_images WHERE project_id=? ORDER BY created_at DESC`
  ).all(projectId);
  return rows.map(row => {
    const out = {
      id: row.id,
      prompt: row.prompt,
      mime: row.mime,
      byteSize: Number(row.byte_size || 0),
      model: row.model || null,
      createdAt: row.created_at,
    };
    if (row.compressed_at) {
      out.originalMime = row.original_mime || null;
      out.originalSize = Number(row.original_size || 0);
      out.compressedAt = row.compressed_at;
    }
    return out;
  });
}

// Apaga uma imagem do projeto. Só o dono.
export async function deleteDesignImage(userId, imageId) {
  const r = await db.prepare('DELETE FROM design_images WHERE id=? AND user_id=?').run(imageId, userId);
  return r.changes > 0;
}

export const DESIGN_IMAGE_LIMITS = Object.freeze({
  maxImageBytes: MAX_IMAGE_BYTES,
  maxProjectBytes: MAX_PROJECT_BYTES,
  maxPromptChars: MAX_PROMPT_CHARS,
  // Tamanho que o compressor tenta garantir como limite prático de cada
  // imagem (sem ser regra rígida: imagens pequenas ficam intactas, e a
  // checagem final ainda usa maxImageBytes). Exposto para a UI mostrar
  // "comprimido para ~1 MB" no diálogo de geração.
  compressionTargetBytes: 1 * 1024 * 1024,
});
