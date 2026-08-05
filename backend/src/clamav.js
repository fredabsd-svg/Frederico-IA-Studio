// Antivírus dos uploads: fala com o daemon ClamAV (clamd) pelo protocolo
// INSTREAM, direto por TCP — sem dependência nova. O arquivo é enviado em
// blocos para o clamd, que responde "OK" ou o nome do vírus encontrado.
//
// Configuração (variáveis de ambiente):
//   CLAMAV_HOST       host do clamd (ex.: "clamav" no docker compose).
//                     VAZIO/ausente = varredura DESLIGADA (uploads passam direto).
//   CLAMAV_PORT       porta do clamd (padrão 3310).
//   CLAMAV_TIMEOUT_MS tempo máximo por arquivo (padrão 30s).
//   CLAMAV_REQUIRED   "true" = se o antivírus estiver fora do ar, RECUSA o
//                     upload (fail-closed). Padrão: aceita sem verificar e
//                     registra aviso no log (fail-open) — assim o app não para
//                     enquanto o clamd baixa as assinaturas no primeiro boot.
//
// POLÍTICA EXPLÍCITA (auditoria 2026-07)
// O modo degradado (fail-open) é legítimo numa instalação PESSOAL e durante os
// primeiros minutos de um deploy, enquanto o clamd baixa as assinaturas. Ele
// deixa de ser aceitável num ambiente PÚBLICO/multiusuário: ali o arquivo de um
// usuário pode ser baixado por outro (equipe/cliente) e "aceito sem verificar"
// vira distribuição de malware. Duas mudanças:
//   1) o resultado agora carrega um `status` por lote — 'verificado',
//      'sem-antivirus' (recurso desligado) ou 'degradado' (clamd fora do ar) —
//      para a interface NUNCA apresentar como verificado um arquivo que não foi
//      analisado;
//   2) scanPolicy() expõe a decisão vigente para o /api/health, de modo que um
//      operador consiga alertar sobre um antivírus caído em vez de descobrir
//      pelo log.
import fs from 'node:fs';
import net from 'net';

const CHUNK = 64 * 1024; // blocos de 64 KB, tamanho usual para o INSTREAM

function config() {
  return {
    host: (process.env.CLAMAV_HOST || '').trim(),
    port: Number(process.env.CLAMAV_PORT || 3310),
    timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS || 30000),
    required: process.env.CLAMAV_REQUIRED === 'true',
  };
}

export function scanEnabled() {
  return !!config().host;
}

// Política vigente, para o health check e para a mensagem ao usuário.
export function scanPolicy() {
  const { host, required } = config();
  if (!host) return { enabled: false, mode: 'desligado', descricao: 'Antivírus desativado nesta instalação (CLAMAV_HOST vazio): nenhum arquivo é verificado.' };
  return {
    enabled: true,
    mode: required ? 'obrigatorio' : 'degradavel',
    descricao: required
      ? 'Antivírus obrigatório: se o clamd estiver fora do ar, o envio é recusado (fail-closed).'
      : 'Antivírus em modo degradável: se o clamd estiver fora do ar, o envio é aceito e marcado como NÃO VERIFICADO (fail-open). Recomendado CLAMAV_REQUIRED=true em ambiente público.'
  };
}

// Métricas simples de saúde do scanner (expostas em /api/health).
export const scanHealth = {
  ultimoErro: null,
  ultimoErroEm: null,
  arquivosVerificados: 0,
  arquivosNaoVerificados: 0,
  arquivosInfectados: 0,
  // F-11: contadores da quarentena. Não substituem arquivosVerificados/NaoVerificados
  // — o momento do escaneamento (na entrada) continua sendo contado lá. Estes
  // aqui refletem o resultado do RE-ESCANEAMENTO pós-recuperação.
  quarentenaTotal: 0,
  quarentenaLimpos: 0,
  quarentenaInfectados: 0
};

// Escaneia um Buffer no clamd. Resolve { clean:true } ou { clean:false, virus }.
// Rejeita a Promise se o daemon estiver inacessível ou responder ERROR.
export function scanBuffer(buffer, opts = {}) {
  return scanStream((write) => {
    for (let i = 0; i < buffer.length; i += CHUNK) write(buffer.subarray(i, i + CHUNK));
  }, opts);
}

// Escaneia um arquivo em DISCO, lendo em blocos — o arquivo nunca é carregado
// inteiro na memória do Node (era o que o multer.memoryStorage() forçava).
export function scanFilePath(filePath, opts = {}) {
  return scanStream((write) => {
    const fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.allocUnsafe(CHUNK);
    try {
      let read = 0;
      while ((read = fs.readSync(fd, chunk, 0, CHUNK, null)) > 0) write(Buffer.from(chunk.subarray(0, read)));
    } finally {
      fs.closeSync(fd);
    }
  }, opts);
}

// Núcleo do protocolo INSTREAM: `feed` recebe uma função write(chunk) e entrega
// o conteúdo em blocos, venha ele de um Buffer ou de um arquivo.
function scanStream(feed, opts = {}) {
  const { host, port, timeoutMs } = { ...config(), ...opts };
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let response = '';
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; socket.destroy(); reject(err); } };

    socket.setTimeout(timeoutMs, () => fail(new Error(`clamd não respondeu em ${timeoutMs}ms`)));
    socket.on('error', fail);
    socket.on('connect', () => {
      try {
        socket.write('zINSTREAM\0');
        feed((chunk) => {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        });
        socket.write(Buffer.from([0, 0, 0, 0])); // bloco vazio = fim do arquivo
      } catch (e) { fail(e); }
    });
    socket.on('data', (d) => { response += d.toString('utf8'); });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      const text = response.replace(/\0/g, '').trim(); // ex.: "stream: OK"
      const found = text.match(/^stream: (.+) FOUND$/);
      if (found) return resolve({ clean: false, virus: found[1] });
      if (/\bOK$/.test(text)) return resolve({ clean: true });
      reject(new Error(`resposta inesperada do clamd: "${text || '(vazia)'}"`));
    });
  });
}

// Escaneia um lote de arquivos do multer (diskStorage: cada `file` tem `.path`;
// aceita também `.buffer`, para quem ainda usar memória). Devolve:
//   clean    → arquivos aprovados (para o chamador mover para o destino)
//   rejected → [{ file, virus }] recusados por infecção
//   scanned  → true se TODOS os aprovados passaram de fato pelo antivírus
//   status   → 'verificado' | 'sem-antivirus' | 'degradado' (o que a interface
//              deve dizer ao usuário — nunca "verificado" sem verificação)
// Se o clamd estiver fora do ar: com CLAMAV_REQUIRED=true lança erro (o
// chamador devolve 503); sem, aceita os arquivos com scanned=false e loga.
export async function scanUploadBatch(files) {
  const { host, required } = config();
  const all = files || [];
  if (!host) return { scanned: false, status: 'sem-antivirus', clean: all, rejected: [] };
  const clean = [];
  const rejected = [];
  let scanned = true;
  for (const file of all) {
    try {
      const r = file.path ? await scanFilePath(file.path) : await scanBuffer(file.buffer);
      if (r.clean) { clean.push(file); scanHealth.arquivosVerificados++; }
      else { rejected.push({ file, virus: r.virus }); scanHealth.arquivosInfectados++; }
    } catch (err) {
      scanHealth.ultimoErro = String(err.message).slice(0, 200);
      scanHealth.ultimoErroEm = new Date().toISOString();
      if (required) {
        const e = new Error('O serviço de antivírus está indisponível no momento e a verificação é obrigatória (CLAMAV_REQUIRED=true). Tente novamente em alguns minutos.');
        e.status = 503;
        throw e;
      }
      console.warn(`[clamav] indisponível (${err.message}) — arquivo aceito SEM verificação (modo degradado)`);
      scanned = false;
      scanHealth.arquivosNaoVerificados++;
      clean.push(file);
    }
  }
  // F-11: se o scan passou EM ALGUM arquivo desta chamada (clamd voltou),
  // aproveita para reprocessar a fila de quarentena — é o melhor sinal que
  // temos de que o antivírus está saudável. Limitado a 10 por chamada para
  // não segurar a resposta do upload; o resto fica para a próxima.
  if (scanned) {
    try {
      const r = await reprocessQuarantine();
      if (r.processed) console.log(`[clamav] quarentena reprocessada: ${JSON.stringify(r)}`);
    } catch (e) { console.warn('[clamav] falha ao reprocessar quarentena:', e.message); }
  }
  return { scanned, status: scanned ? 'verificado' : 'degradado', clean, rejected };
}

// ---- Quarentena (F-11) -----------------------------------------------------
// Quando o clamd está fora do ar, o upload é aceito em modo degradado. Em vez
// de marcar como "verificado" (o que seria mentira), o arquivo vai para uma
// pasta `.quarantine/` e esta tabela rastreia o que precisa ser RE-ESCANEADO
// quando o antivírus voltar.
//
// O caminho é por design: deixar o arquivo em `uploads/` como se estivesse OK
// é exatamente o que a auditoria apontou como vetor (distribuição de malware
// com selo de verificado). Quarentena é separada para que o conjunto que o
// usuário consegue baixar/enviar para um agente seja só o que passou.

import path from 'node:path';
import { db, now } from './db.js';

// Pasta de quarentena dentro de uploads/. Não inventária aqui o caminho — quem
// chama é que conhece a raiz do workspace desta conversa.
export function quarantineDirFor(uploadsDir) {
  return path.join(uploadsDir, '.quarantine');
}

// Move o arquivo temporário do upload para a pasta de quarentena da conversa
// e registra a linha na tabela `quarantined_uploads`. NÃO muda a linha em
// `files` — a quarentena é uma camada por cima, não uma reescrita do upload.
// `files` continua apontando para o caminho em `.quarantine/` (que é onde o
// arquivo REAL está). Ao ser liberado (cleared), movemos o arquivo para
// `uploads/<name>` e ATUALIZAMOS o caminho em `files`.
export function quarantineUploadedFile({ conversationId, userId, srcPath, uploadsDir, name, mime, size, hash }) {
  const qdir = quarantineDirFor(uploadsDir);
  fs.mkdirSync(qdir, { recursive: true });
  // Mesmo nome opaco do `commitUploadedFile`: timestamp + nanoid, para não
  // vazar o nome original no caminho do arquivo em disco.
  const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}_${name.replace(/[^a-zA-Z0-9._ -]/g, '_')}`;
  const target = path.join(qdir, safeName);
  fs.renameSync(srcPath, target);
  try { fs.chownSync(target, 1000, 1000); } catch {}
  const relPath = path.relative(path.dirname(uploadsDir), target).replaceAll('\\', '/');
  return relPath; // ex.: "uploads/.quarantine/1717000000_abc_file.pdf"
}

// Lista arquivos em quarentena com status 'pending' ou 'stale' (pronto para
// nova tentativa). Limite padrão: 50 por chamada (a fila de re-escaneamento).
export async function listQuarantinedReady(limit = 50) {
  try {
    return await db.prepare(
      "SELECT id, conversation_id, user_id, storage_path, original_name, mime, size, hash, attempts, quarantined_at FROM quarantined_uploads WHERE status IN ('pending', 'stale') ORDER BY quarantined_at ASC LIMIT ?"
    ).all(limit);
  } catch {
    // Tabela ainda não migrada (instalação nova antes do migrate) ou DB
    // indisponível — devolve vazio em vez de derrubar o chamador. Reprocessar
    // quarentena não é caminho crítico no boot.
    return [];
  }
}

// Marca um item como 'processing' para evitar duas tentativas simultâneas no
// mesmo arquivo. Devolve true se reservou, false se outro worker já está nele.
export async function claimQuarantineItem(id) {
  try {
    const result = await db.prepare(
      "UPDATE quarantined_uploads SET status='processing', last_attempt_at=? WHERE id=? AND status IN ('pending', 'stale')"
    ).run(now(), id);
    return result.changes > 0;
  } catch { return false; }
}

// Fecha o ciclo de uma tentativa de re-escaneamento.
export async function markQuarantineResult(id, { clean, virus, error }) {
  try {
    if (clean === true) {
      await db.prepare("UPDATE quarantined_uploads SET status='cleared', cleared_at=?, last_error=NULL WHERE id=?")
        .run(now(), id);
      scanHealth.quarentenaLimpos += 1;
    } else if (clean === false) {
      await db.prepare("UPDATE quarantined_uploads SET status='infected', virus_name=?, cleared_at=?, last_error=NULL WHERE id=?")
        .run(virus || 'desconhecido', now(), id);
      scanHealth.quarentenaInfectados += 1;
    } else {
      // Erro de infra (clamd caiu de novo, timeout, I/O): mantém pending/stale
      // para tentar de novo depois. attempts++ para detectar loops travados.
      await db.prepare("UPDATE quarantined_uploads SET status='stale', attempts=attempts+1, last_attempt_at=?, last_error=? WHERE id=?")
        .run(now(), String(error || '').slice(0, 200), id);
    }
  } catch {}
}

// Re-escaneia a fila de quarentena. Chamado depois de um scan BEM-SUCEDIDO
// (sinal de que o clamd está vivo de novo). Limite conservador de 10 por
// chamada — o resto fica para a próxima. Devolve um resumo com o que fez.
export async function reprocessQuarantine() {
  if (!scanEnabled()) return { skipped: true, reason: 'av-desligado' };
  const items = await listQuarantinedReady(10);
  if (!items.length) return { skipped: true, reason: 'fila-vazia' };
  const result = { processed: 0, cleared: 0, infected: 0, stale: 0, errors: [] };
  for (const item of items) {
    if (!await claimQuarantineItem(item.id)) continue;
    result.processed += 1;
    try {
      const fullPath = path.join(path.dirname(path.dirname(item.storage_path)), item.storage_path);
      const r = await scanFilePath(fullPath);
      if (r.clean) {
        const target = path.join(path.dirname(path.dirname(fullPath)), 'uploads', path.basename(fullPath).replace(/^\d+_[a-z0-9]+_/, ''));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(fullPath, target);
        try { fs.chownSync(target, 1000, 1000); } catch {}
        const newRel = path.relative(path.dirname(path.dirname(target)), target).replaceAll('\\', '/');
        try { await db.prepare("UPDATE files SET path=? WHERE id=?").run(newRel, item.id); } catch {}
        await markQuarantineResult(item.id, { clean: true });
        result.cleared += 1;
      } else {
        try { fs.rmSync(fullPath, { force: true }); } catch {}
        await markQuarantineResult(item.id, { clean: false, virus: r.virus });
        result.infected += 1;
      }
    } catch (err) {
      await markQuarantineResult(item.id, { error: err.message });
      result.stale += 1;
      result.errors.push({ id: item.id, error: err.message });
    }
  }
  return result;
}
