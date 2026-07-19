// Testes das funções PURAS do conector GitHub (validação de nomes, saneamento
// de segredos). As operações de rede/git são exercitadas manualmente — aqui o
// foco é o que protege contra injeção de argumento e vazamento de token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRepoFullName, isValidBranchName, repoDirName, scrubSecrets, GITHUB_WRITE_TOOLS, githubToolDefinitions } from './connectors/github.js';

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

test('ferramentas de escrita do GitHub estão marcadas para o filtro de plan/review', () => {
  const names = githubToolDefinitions.map(t => t.function.name);
  assert.deepEqual(names.sort(), ['github_clone', 'github_create_pr', 'github_list_repos', 'github_push']);
  assert.equal(GITHUB_WRITE_TOOLS.has('github_push'), true);
  assert.equal(GITHUB_WRITE_TOOLS.has('github_create_pr'), true);
  assert.equal(GITHUB_WRITE_TOOLS.has('github_clone'), false);
});
