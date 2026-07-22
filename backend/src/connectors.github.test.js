// Testes das funções PURAS do conector GitHub (validação de nomes, saneamento
// de segredos). As operações de rede/git são exercitadas manualmente — aqui o
// foco é o que protege contra injeção de argumento e vazamento de token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRepoFullName, isValidBranchName, repoDirName, scrubSecrets, GITHUB_WRITE_TOOLS, githubToolDefinitions, isDigestIgnored, digestFileScore, pickDigestFiles, serverConfigGitFailure } from './connectors/github.js';

test('isValidRepoFullName aceita nomes reais de owner/repo', () => {
  assert.equal(isValidRepoFullName('fredabsd-svg/Frederico-IA-Studio'), true);
  assert.equal(isValidRepoFullName('a/b'), true);
  assert.equal(isValidRepoFullName('user.name/repo_name.js'), true);
});

test('isValidRepoFullName rejeita formatos perigosos ou inválidos', () => {
  assert.equal(isValidRepoFullName(''), false);
  assert.equal(isValidRepoFullName('semBarra'), false);
  assert.equal(isValidRepoFullName('a/b/c'), false);
  assert.equal(isValidRepoFullName('../etc/passwd'), false);
  assert.equal(isValidRepoFullName('owner/..'), false);
  assert.equal(isValidRepoFullName('owner/repo com espaco'), false);
  assert.equal(isValidRepoFullName('-owner/repo'), false); // não pode virar flag do git
  assert.equal(isValidRepoFullName('owner/repo;rm -rf /'), false);
});

test('isValidBranchName aceita branches comuns e rejeita injeção de flag', () => {
  assert.equal(isValidBranchName('main'), true);
  assert.equal(isValidBranchName('feature/ajuste-login'), true);
  assert.equal(isValidBranchName('claude/app-connectors-github-18jnzm'), true);
  assert.equal(isValidBranchName(''), false);
  assert.equal(isValidBranchName('--force'), false);
  assert.equal(isValidBranchName('-x'), false);
  assert.equal(isValidBranchName('a b'), false);
  assert.equal(isValidBranchName('a..b'), false);
  assert.equal(isValidBranchName('fim/'), false);
  assert.equal(isValidBranchName('ref.lock'), false);
});

test('repoDirName usa só a parte do repositório, saneada', () => {
  assert.equal(repoDirName('fulano/meu-app'), 'meu-app');
  assert.equal(repoDirName('fulano/meu-app.git'), 'meu-app');
  assert.equal(repoDirName('fulano/estranho$nome'), 'estranho_nome');
  assert.equal(repoDirName(''), 'repo');
});

test('scrubSecrets remove o token e a sua forma base64 da saída', () => {
  const token = 'ghp_EXEMPLO123segredo';
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  const suja = `fatal: auth ${token} header Basic ${b64} fim`;
  const limpa = scrubSecrets(suja, token);
  assert.equal(limpa.includes(token), false);
  assert.equal(limpa.includes(b64), false);
  assert.equal(limpa.includes('***'), true);
  // sem token, o texto passa intacto
  assert.equal(scrubSecrets('texto normal', null), 'texto normal');
});

// ---- Extrato do repositório (buildRepoDigest) — seleção PURA de arquivos ----

test('isDigestIgnored pula dependências, binários e lockfiles; mantém código', () => {
  assert.equal(isDigestIgnored('node_modules/react/index.js'), true);
  assert.equal(isDigestIgnored('backend/dist/bundle.js'), true);
  assert.equal(isDigestIgnored('assets/logo.png'), true);
  assert.equal(isDigestIgnored('package-lock.json'), true);
  assert.equal(isDigestIgnored('.git/config'), true);
  assert.equal(isDigestIgnored('backend/src/agent/multiModel.js'), false);
  assert.equal(isDigestIgnored('README.md'), false);
  assert.equal(isDigestIgnored('frontend/src/App.jsx'), false);
});

test('digestFileScore prioriza README e manifestos acima do código comum', () => {
  const readme = digestFileScore('README.md', 2000);
  const pkg = digestFileScore('package.json', 1000);
  const src = digestFileScore('backend/src/util/helpers.js', 3000);
  const test = digestFileScore('backend/src/util/helpers.test.js', 3000);
  assert.ok(readme > pkg, 'README acima de manifesto');
  assert.ok(pkg > src, 'manifesto acima de código comum');
  assert.ok(src > test, 'código de produção acima de teste');
});

test('pickDigestFiles respeita limites e ignora binários/dependências', () => {
  const tree = [
    { type: 'blob', path: 'README.md', size: 1500 },
    { type: 'blob', path: 'package.json', size: 800 },
    { type: 'blob', path: 'node_modules/x/index.js', size: 500 },   // ignorado
    { type: 'blob', path: 'assets/foto.png', size: 40000 },         // ignorado
    { type: 'blob', path: 'src/index.js', size: 2000 },
    { type: 'blob', path: 'src/enorme.js', size: 999999 },          // grande demais
    { type: 'tree', path: 'src', size: 0 }                          // não é blob
  ];
  const picked = pickDigestFiles(tree, { maxFiles: 10, maxChars: 46000, maxFileChars: 5000, maxFileBytes: 120000 });
  const paths = picked.map(p => p.path);
  assert.ok(paths.includes('README.md') && paths.includes('package.json') && paths.includes('src/index.js'));
  assert.ok(!paths.includes('node_modules/x/index.js'));
  assert.ok(!paths.includes('assets/foto.png'));
  assert.ok(!paths.includes('src/enorme.js'), 'arquivo acima de maxFileBytes fica de fora');
  assert.ok(!paths.includes('src'), 'entradas do tipo tree não entram');
  // README vem primeiro (maior prioridade)
  assert.equal(paths[0], 'README.md');
});

test('pickDigestFiles corta pela quantidade máxima de arquivos', () => {
  const tree = Array.from({ length: 50 }, (_, i) => ({ type: 'blob', path: `src/mod${i}.js`, size: 300 }));
  const picked = pickDigestFiles(tree, { maxFiles: 5, maxChars: 999999, maxFileChars: 5000 });
  assert.equal(picked.length, 5);
});

test('serverConfigGitFailure reconhece falha de CA/TLS do git (bug do github_clone no Modo Desenvolvedor)', () => {
  // Erro clássico de ca-certificates ausente: o git do backend não confia no
  // certificado do github.com, enquanto o fetch do Node (CA embutido) funciona.
  assert.equal(serverConfigGitFailure("fatal: unable to access 'https://github.com/a/b.git/': server certificate verification failed. CAfile: none"), 'tls');
  assert.equal(serverConfigGitFailure('fatal: unable to get local issuer certificate'), 'tls');
  assert.equal(serverConfigGitFailure('SSL certificate problem: unable to get local issuer certificate'), 'tls');
});

test('serverConfigGitFailure reconhece git ausente e ignora falhas comuns (rede/auth/conflito)', () => {
  assert.equal(serverConfigGitFailure('O git não está instalado no servidor.'), 'git-missing');
  assert.equal(serverConfigGitFailure('spawn git ENOENT'), 'git-missing');
  // Falhas transitórias/de credencial NÃO são config do servidor — tratadas à
  // parte, para não marcar como não-recuperável o que uma nova tentativa resolve.
  assert.equal(serverConfigGitFailure('fatal: Authentication failed for ...'), null);
  assert.equal(serverConfigGitFailure('fatal: Could not resolve host: github.com'), null);
  assert.equal(serverConfigGitFailure('! [rejected] main -> main (non-fast-forward)'), null);
  assert.equal(serverConfigGitFailure(''), null);
  assert.equal(serverConfigGitFailure(null), null);
});

test('ferramentas de escrita do GitHub estão marcadas para o filtro de plan/review', () => {
  const names = githubToolDefinitions.map(t => t.function.name);
  assert.deepEqual(names.sort(), ['github_clone', 'github_create_pr', 'github_list_repos', 'github_push']);
  assert.equal(GITHUB_WRITE_TOOLS.has('github_push'), true);
  assert.equal(GITHUB_WRITE_TOOLS.has('github_create_pr'), true);
  assert.equal(GITHUB_WRITE_TOOLS.has('github_clone'), false);
});
