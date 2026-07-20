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

// Escaneia um Buffer no clamd. Resolve { clean:true } ou { clean:false, virus }.
// Rejeita a Promise se o daemon estiver inacessível ou responder ERROR.
export function scanBuffer(buffer, opts = {}) {
  const { host, port, timeoutMs } = { ...config(), ...opts };
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let response = '';
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; socket.destroy(); reject(err); } };

    socket.setTimeout(timeoutMs, () => fail(new Error(`clamd não respondeu em ${timeoutMs}ms`)));
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const chunk = buffer.subarray(i, i + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.from([0, 0, 0, 0])); // bloco vazio = fim do arquivo
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

// Escaneia um lote de arquivos do multer (memoryStorage). Devolve:
//   clean    → arquivos aprovados (para o chamador salvar)
//   rejected → [{ file, virus }] recusados por infecção
//   scanned  → true se TODOS os aprovados passaram de fato pelo antivírus
// Se o clamd estiver fora do ar: com CLAMAV_REQUIRED=true lança erro (o
// chamador devolve 503); sem, aceita os arquivos com scanned=false e loga.
export async function scanUploadBatch(files) {
  const { host, required } = config();
  const all = files || [];
  if (!host) return { scanned: false, clean: all, rejected: [] };
  const clean = [];
  const rejected = [];
  let scanned = true;
  for (const file of all) {
    try {
      const r = await scanBuffer(file.buffer);
      if (r.clean) clean.push(file);
      else rejected.push({ file, virus: r.virus });
    } catch (err) {
      if (required) {
        const e = new Error('O serviço de antivírus está indisponível no momento e a verificação é obrigatória (CLAMAV_REQUIRED=true). Tente novamente em alguns minutos.');
        e.status = 503;
        throw e;
      }
      console.warn(`[clamav] indisponível (${err.message}) — arquivo aceito sem verificação`);
      scanned = false;
      clean.push(file);
    }
  }
  return { scanned, clean, rejected };
}
