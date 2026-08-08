// Servidor de pré-visualização efêmero (Fase 38 — validação por navegador).
//
// POR QUE ISTO EXISTE. Para validar no navegador uma página que a tarefa
// construiu, o Chromium do backend precisa alcançá-la. Os dois caminhos óbvios
// estão fechados, cada um por um bom motivo:
//
//   * o servidor que o agente sobe DENTRO do sandbox não é alcançável de fora
//     do container (ele nasce com `NetworkDisabled` e sem publicação de portas,
//     e abrir isso seria desfazer uma fronteira de segurança para ganhar
//     conveniência);
//   * navegar em `file://` colocaria o disco do backend ao alcance de um HTML
//     escrito pelo MODELO — e o `page.route()` do Playwright não intercepta
//     sub-requisições `file://` de forma confiável, então a guarda não valeria
//     justamente onde ela é necessária.
//
// A saída é um terceiro caminho, mais estreito que os dois: um servidor HTTP
// estático, **só de leitura**, atado a 127.0.0.1 numa porta efêmera, com raiz
// no workspace DESTA conversa e vida útil de uma validação. Ele fala HTTP — que
// o `route()` intercepta de verdade — e não expõe nada além da árvore que o
// agente já pode ler e escrever.
//
// Contenção: o caminho pedido é resolvido e conferido contra a raiz; `..`,
// caminho absoluto e link simbólico que aponte para fora são RECUSADOS (404,
// sem revelar o que existe fora). Nenhum método além de GET/HEAD responde.
import fs from 'fs';
import http from 'http';
import path from 'path';

// Tipos suficientes para uma página web real. Desconhecido vai como binário —
// nunca como HTML, para o navegador não executar o que não deve.
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}));

export function mimeFor(filePath) {
  return MIME.get(path.extname(String(filePath || '')).toLowerCase()) || 'application/octet-stream';
}

// Caminho pedido pela URL → arquivo real dentro da raiz, ou null.
// PURO o bastante para ser testado sem subir servidor: só toca o disco para
// resolver link simbólico e conferir que é arquivo.
export function resolveWithinRoot(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(String(urlPath || '').split('?')[0].split('#')[0]); }
  catch { return null; }                                     // percent-encoding inválido
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  if (!rel) return null;
  // `..` é recusado antes de qualquer normalização: normalizar esconderia a
  // intenção de quem pediu (mesma régua do diffView e do handoff).
  if (rel.split('/').includes('..')) return null;
  const rootReal = fs.realpathSync(root);
  const target = path.resolve(rootReal, rel);
  if (target !== path.join(rootReal, rel)) return null;
  if (!target.startsWith(rootReal + path.sep)) return null;
  let real;
  try { real = fs.realpathSync(target); } catch { return null; }
  // Depois de seguir o link simbólico, o destino ainda precisa estar na raiz.
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
  return real;
}

// Sobe o servidor e devolve { origin, port, close() }. `root` precisa existir.
export function startPreviewServer(root, { host = '127.0.0.1' } = {}) {
  const rootReal = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      return res.end('Método não permitido.');
    }
    const file = resolveWithinRoot(rootReal, req.url || '');
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado.');
    }
    let data;
    try { data = fs.readFileSync(file); } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado.');
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(file),
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      // A página validada é código gerado por IA: não pode ser embutida em
      // lugar nenhum nem virar referência para outra origem.
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  // Conexão pendurada não pode segurar o processo nem o `close()`.
  server.on('connection', socket => { socket.unref?.(); });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://${host}:${port}`,
        root: rootReal,
        close: () => new Promise(done => {
          server.closeAllConnections?.();
          server.close(() => done());
        })
      });
    });
  });
}
