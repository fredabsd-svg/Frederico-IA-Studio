// Rotas de connectors — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { db } from '../db.js';
import { getGithubConnection, testGithubToken, listGithubRepos, listGithubBranches, saveGithubConnection, githubOAuthConfig, githubOAuthAuthorizeUrl, createGithubOAuthState, consumeGithubOAuthState, exchangeGithubOAuthCode } from '../connectors/github.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

// ---- Conectores de serviços externos (GitHub é o primeiro) ----
// O token fica cifrado (mesma ENCRYPTION_KEY do BYOK) e NUNCA volta em texto
// claro — o GET devolve só o estado e a conta conectada.
router.get('/connectors', async (req, res) => {
  const conn = await getGithubConnection(req.userId);
  res.json([{ provider: 'github', connected: !!conn, login: conn?.login || '', name: conn?.name || '', oauth: !!githubOAuthConfig() }]);
});

// PUT valida o token no GitHub antes de salvar; token '' desconecta.
router.put('/connectors/github', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  try {
    if (!token) {
      await db.prepare("DELETE FROM user_connectors WHERE user_id=? AND provider='github'").run(req.userId);
      return res.json({ ok: true, connected: false });
    }
    const saved = await saveGithubConnection(req.userId, token);
    if (!saved.ok) return res.status(400).json({ ok: false, error: saved.error });
    res.json({ ok: true, connected: true, login: saved.login, name: saved.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Não foi possível salvar. Verifique se a ENCRYPTION_KEY está configurada no servidor.' });
  }
});

// ---- Conexão em 1 clique (OAuth): botão → GitHub → autorizar → conectado ----
// Página curta devolvida ao navegador no fim do fluxo (popup ou aba inteira).
function githubOAuthResultPage(ok, message) {
  const title = ok ? 'GitHub conectado!' : 'Não deu para conectar o GitHub';
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ee">
<div style="text-align:center;max-width:420px;padding:24px">
<div style="font-size:42px">${ok ? '✅' : '⚠️'}</div>
<h2 style="margin:12px 0 8px">${title}</h2>
<p style="margin:0 0 16px;color:#9aa1ad">${message}</p>
<a href="/" style="color:#7ab7ff">Voltar ao Frederico AI Studio</a>
</div>
<script>try{if(window.opener){window.opener.postMessage({type:'fred-github-connected',ok:${ok ? 'true' : 'false'}},window.location.origin);setTimeout(function(){window.close()},900);}}catch(e){}</script>
</body></html>`;
}

router.get('/connectors/github/start', (req, res) => {
  if (!githubOAuthConfig()) {
    return res.status(400).json({ error: 'A conexão em 1 clique não está configurada neste servidor (GITHUB_CONNECTOR_CLIENT_ID/SECRET). Use a conexão por token.' });
  }
  const url = githubOAuthAuthorizeUrl(createGithubOAuthState(req.userId));
  res.redirect(url);
});

router.get('/connectors/github/callback', async (req, res) => {
  const finish = (ok, message) => res.status(ok ? 200 : 400).type('html').send(githubOAuthResultPage(ok, message));
  try {
    if (!consumeGithubOAuthState(req.query.state, req.userId)) {
      return finish(false, 'A autorização expirou ou veio de outra sessão. Volte ao app e clique em "Conectar com GitHub" de novo.');
    }
    if (!req.query.code) {
      return finish(false, String(req.query.error_description || 'A autorização foi cancelada no GitHub.'));
    }
    const exchanged = await exchangeGithubOAuthCode(String(req.query.code));
    if (!exchanged.ok) return finish(false, exchanged.error);
    const saved = await saveGithubConnection(req.userId, exchanged.token);
    if (!saved.ok) return finish(false, saved.error);
    return finish(true, `Conta @${saved.login} conectada. Pode fechar esta janela e voltar ao app.`);
  } catch {
    return finish(false, 'Algo deu errado ao concluir a conexão. Tente de novo em instantes.');
  }
});

router.delete('/connectors/github', async (req, res) => {
  await db.prepare("DELETE FROM user_connectors WHERE user_id=? AND provider='github'").run(req.userId);
  res.json({ ok: true });
});

// Testa a conexão salva (ou um token recém-digitado, ainda não salvo).
router.post('/connectors/github/test', async (req, res) => {
  const typed = String(req.body?.token || '').trim();
  const token = typed || (await getGithubConnection(req.userId))?.token;
  if (!token) return res.status(400).json({ ok: false, error: 'Nenhum token do GitHub configurado.' });
  res.json(await testGithubToken(token));
});

// Repositórios e branches da conta conectada (para o painel do modo desenvolvedor).
router.get('/connectors/github/repos', async (req, res) => {
  const conn = await getGithubConnection(req.userId);
  if (!conn) return res.status(400).json({ error: 'GitHub não conectado.' });
  const r = await listGithubRepos(conn.token);
  if (r.error) return res.status(502).json({ error: r.error });
  res.json(r.repos);
});

router.get('/connectors/github/branches', async (req, res) => {
  const conn = await getGithubConnection(req.userId);
  if (!conn) return res.status(400).json({ error: 'GitHub não conectado.' });
  const r = await listGithubBranches(conn.token, String(req.query.repo || ''));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r.branches);
});

export default router;
