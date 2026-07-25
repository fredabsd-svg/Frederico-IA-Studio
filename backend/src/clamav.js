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
  arquivosInfectados: 0
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
  return { scanned, status: scanned ? 'verificado' : 'degradado', clean, rejected };
}
