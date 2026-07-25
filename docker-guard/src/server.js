// Guarda do Docker — o único processo que enxerga /var/run/docker.sock.
//
// O backend deixa de montar o socket e passa a falar HTTP com este serviço
// (DOCKER_HOST=tcp://docker-guard:2375). Como o dockerode fala o mesmo protocolo
// por TCP ou por socket, NADA muda no código de sandbox do backend — o que muda
// é que cada requisição agora passa por uma política (src/policy.js) antes de
// chegar ao daemon.
//
// Três garantias:
//   1) rota fora da allowlist → 403 (nem chega ao daemon);
//   2) POST /containers/create com Privileged, bind de "/" ou do próprio socket,
//      CapAdd, imagem estranha, sem endurecimento → 403;
//   3) operação sobre um container que NÃO tem a label do Frederico → 403
//      (um backend comprometido não derruba o Postgres nem lê outro container).
//
// Sem dependências: só http/net do Node. Menos superfície no processo que
// carrega o privilégio.
import http from 'node:http';
import net from 'node:net';
import { evaluateRequest, defaultLimits, APP_LABEL, APP_LABEL_VALUE } from './policy.js';

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PORT = Number(process.env.GUARD_PORT || 2375);
const HOST = process.env.GUARD_BIND || '0.0.0.0';
const MAX_BODY_BYTES = Number(process.env.GUARD_MAX_BODY_BYTES || 1024 * 1024);
const LOG_ALLOWED = process.env.GUARD_LOG_ALLOWED === 'true';
const limits = defaultLimits();

export const guardMetrics = { permitidas: 0, recusadas: 0, ultimaRecusa: null };

function logDenial(method, path, reason) {
  guardMetrics.recusadas++;
  guardMetrics.ultimaRecusa = { quando: new Date().toISOString(), method, path, reason };
  // Uma recusa é sempre notável: ou é bug de configuração, ou é o backend
  // pedindo algo que não deveria — nos dois casos o operador precisa ver.
  console.warn(`[guard] RECUSADO ${method} ${path} — ${reason}`);
}

// Chamada interna ao daemon (usada na checagem de posse). Sempre JSON pequeno.
function daemonJson(path) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCKET, path, method: 'GET' }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (raw.length < 256 * 1024) raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// A operação age sobre um recurso do Frederico? Fail-closed: se não dá para
// confirmar a label, recusa.
async function ownsResource(kind, id) {
  if (!kind) return true;
  let containerId = id;
  if (kind === 'exec') {
    const info = await daemonJson(`/exec/${encodeURIComponent(id)}/json`);
    containerId = info?.ContainerID;
    if (!containerId) return false;
  }
  const container = await daemonJson(`/containers/${encodeURIComponent(containerId)}/json`);
  const labels = container?.Config?.Labels || {};
  return labels[APP_LABEL] === APP_LABEL_VALUE;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('corpo grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function refuse(res, reason, status = 403) {
  const payload = JSON.stringify({ message: `bloqueado pelo guarda do Docker: ${reason}` });
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

// Cabeçalhos repassados ao daemon (sem hop-by-hop nem Host do cliente).
function forwardHeaders(headers, bodyLength) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'].includes(key)) continue;
    out[k] = v;
  }
  if (bodyLength !== undefined) out['content-length'] = String(bodyLength);
  return out;
}

export function createGuardServer() {
  const server = http.createServer(async (req, res) => {
    let body = Buffer.alloc(0);
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
    } catch (e) {
      return refuse(res, e.message, 413);
    }

    let parsed = null;
    if (body.length) {
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { parsed = null; } // corpo não-JSON: a política decide (create exige JSON)
    }

    const verdict = evaluateRequest({ method: req.method, path: req.url, body: parsed }, limits);
    if (!verdict.allow) {
      logDenial(req.method, req.url, verdict.reason);
      return refuse(res, verdict.reason);
    }
    if (verdict.ownership && !(await ownsResource(verdict.ownership, verdict.targetId))) {
      const reason = `o recurso ${verdict.targetId} não tem a label ${APP_LABEL}=${APP_LABEL_VALUE}`;
      logDenial(req.method, req.url, reason);
      return refuse(res, reason);
    }
    guardMetrics.permitidas++;
    if (LOG_ALLOWED) console.log(`[guard] ok ${req.method} ${req.url}`);

    const upstream = http.request(
      { socketPath: SOCKET, path: req.url, method: req.method, headers: forwardHeaders(req.headers, body.length) },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      console.error('[guard] falha ao falar com o daemon:', err.message);
      if (!res.headersSent) refuse(res, `daemon indisponível (${err.code || err.message})`, 502);
      else res.end();
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });

  // ---- hijack do exec ------------------------------------------------------
  // `POST /exec/<id>/start` do dockerode pede Upgrade: tcp e depois trafega o
  // protocolo de frames do Docker em cima da conexão crua. Aqui a conexão é
  // validada uma vez e então vira um túnel de bytes — sem isso, toda execução
  // de ferramenta pararia de funcionar.
  server.on('upgrade', async (req, clientSocket, head) => {
    const fail = (reason) => {
      logDenial(req.method, req.url, reason);
      try {
        clientSocket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ message: `bloqueado pelo guarda do Docker: ${reason}` })}`);
      } catch {}
      clientSocket.destroy();
    };

    const verdict = evaluateRequest({ method: req.method, path: req.url, body: null }, limits);
    if (!verdict.allow) return fail(verdict.reason);
    if (verdict.ownership && !(await ownsResource(verdict.ownership, verdict.targetId))) {
      return fail(`o recurso ${verdict.targetId} não tem a label ${APP_LABEL}=${APP_LABEL_VALUE}`);
    }
    guardMetrics.permitidas++;

    const daemon = net.connect(SOCKET, () => {
      const linhas = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) linhas.push(`${k}: ${v}`);
      daemon.write(`${linhas.join('\r\n')}\r\n\r\n`);
      if (head?.length) daemon.write(head);
      daemon.pipe(clientSocket);
      clientSocket.pipe(daemon);
    });
    const encerra = () => { try { daemon.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    daemon.on('error', (err) => { console.error('[guard] túnel do exec falhou:', err.message); encerra(); });
    clientSocket.on('error', encerra);
    clientSocket.on('close', encerra);
  });

  return server;
}

// Boot só quando executado diretamente (o teste importa e sobe o seu próprio).
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = createGuardServer();
  server.listen(PORT, HOST, () => {
    console.log(`[guard] guarda do Docker em ${HOST}:${PORT} → ${SOCKET}`);
    console.log(`[guard] imagem permitida: ${limits.allowedImage}`);
    console.log(`[guard] raiz de bind: ${limits.workspaceRoot}${limits.allowPcFolders ? ' (+ pastas do PC liberadas)' : ''}`);
  });
}
