# ADR 0002 — Autorização estruturada de publicação no GitHub

Data: 2026-08-06

## Contexto

O conector GitHub tem duas ferramentas de escrita — `github_push` e
`github_create_pr` — que rodam no backend, com o token do usuário cifrado e sem
que ele jamais entre no sandbox. Elas só devem ser oferecidas ao modelo quando o
usuário autorizou a publicação.

Até aqui, o único sinal de autorização era uma expressão regular aplicada ao
texto **do turno atual** (`explicitlyAuthorizesGitWrite`), avaliada dentro de uma
condição inline no `agent/loop.js`:

```js
const githubTools = (!developerContext?.canWrite || !gitWriteAuthorized)
  ? githubToolDefinitions.filter(tool => !GITHUB_WRITE_TOOLS.has(tool.function.name))
  : githubToolDefinitions;
```

Três consequências, todas observadas em uso real:

1. **A autorização morria com o turno.** O usuário escrevia "pode abrir o PR",
   o agente trabalhava por vários turnos (ou retomava de um checkpoint) e, nesses
   turnos seguintes, a regex não casava com nada — as ferramentas de escrita
   simplesmente saíam do inventário. O agente então respondia que "mesmo com a
   sua autorização, `github_push` e `github_create_pr` não estão habilitadas
   nesta sessão", como se fosse um limite do produto. Não era: era um defeito.
2. **A permissão não tinha escopo.** Uma frase de autorização valia para
   qualquer repositório e qualquer branch que estivesse vinculada no momento em
   que a ferramenta fosse chamada.
3. **A interface e o executor discordavam.** O painel do Modo Desenvolvedor
   mostrava "Pode enviar (push)" derivando isso apenas do modo de trabalho, sem
   consultar nada do que o loop de fato usaria. A frase certa — *o que bloqueou* —
   não existia em lugar nenhum.

O ponto de fundo é que duas coisas diferentes estavam sendo tratadas como uma:

```
autorização do usuário   ≠   disponibilidade técnica da ferramenta
```

## Decisão

Separar as duas e concentrar a decisão em **um** módulo testável,
`backend/src/agent/githubAccess.js`.

**1. A autorização passa a ser estruturada e escopada.** Ela viaja no payload
`developer.permissions` do chat:

```js
permissions: {
  githubWrite: true,
  githubWriteConfirmedAt: '2026-08-06T19:00:00.000Z',
  githubWriteScope: {
    repo: 'owner/repo', branch: 'feat/x', base: 'main',
    actions: ['push', 'create_pr']
  }
}
```

Ela vem de ação explícita do usuário — o botão **Autorizar publicação** no painel
(que exibe repositório, branch, destino e ações antes de confirmar) ou a
confirmação de um `ask_user` cujo escopo o **backend** carimba a partir do
vínculo, nunca do texto do modelo. É gravada no projeto do Modo Desenvolvedor
(navegador) e re-validada no backend por `normalizeGithubWriteAuthorization`, que
descarta campos e ações desconhecidas e recusa nome de branch inválido.

Por sobreviver no payload `developer` — que o checkpoint já persiste —, a
autorização vale nos turnos seguintes e na retomada, sem o usuário repetir nada.

**2. Um pré-voo único decide e informa.** `githubPreflight()` devolve o estado
real (`connected`, `repository`, `branch`, `base`, `mode`, `canRead`, `canWrite`,
`writeAuthorized`, `authorizedActions`, `tools.{clone,push,createPr}`,
`blockingReason`). Dele saem, obrigatoriamente:

- o inventário entregue ao modelo (`githubToolsForContext`);
- a nota do prompt (`githubPreflightNote`);
- o que o painel exibe (`GET /api/connectors/github/preflight`).

Há teste de catraca cobrando que o que o prompt **anuncia** é exatamente o que o
executor **recebe**.

**3. Fail-closed em toda a matriz**, com a causa nomeada: `github_not_connected`,
`repository_not_bound`, `read_only_mode`, `write_not_confirmed`, `scope_mismatch`,
`action_not_authorized`, `invalid_branch`, `subagent_not_allowed`,
`low_signal_turn`. Sub-agente nunca publica. Turno conversacional não recebe
ferramenta remota. Modo de leitura (`ask`/`plan`/`review`) não publica mesmo com
autorização registrada.

**4. A regex do turno continua, como caminho secundário e escopado.** Quem
escreve "faça o commit e abra o PR" na própria missão não precisa de um segundo
clique — mas essa autorização também exige uma branch declarada no vínculo. Sem
branch não há escopo; sem escopo não há permissão.

**5. Git remoto pelo sandbox é bloqueado** (`execGuard.js`), apontando as
ferramentas do backend. Não é uma decisão de rede: o token nunca está lá, então
`git push` pelo bash falharia mesmo com a rede aberta — e a falha genérica de
rede fazia o modelo insistir por minutos em caminhos que não existem.

## Alternativas descartadas

- **Melhorar a regex.** Reconhecer mais frases ("autorizo", "pode publicar",
  "sim, prossiga") não resolve nenhuma das três consequências: a autorização
  continuaria presa ao turno, sem escopo e sem estado consultável. Trocaria um
  defeito determinístico por um defeito mais raro e mais difícil de reproduzir.
- **Permissão persistida por conta ou por repositório no banco.** Resolveria a
  durabilidade, mas cria uma permissão de longa duração para uma ação destrutiva
  em repositório de terceiros, invisível no fluxo em que ela é usada. A
  autorização por (projeto, repositório, branch, base, ações) é o menor escopo
  que ainda dispensa repetição — e a mudança de qualquer parte do escopo exige
  nova confirmação, que é o comportamento desejado.
- **Sempre oferecer as ferramentas e barrar na execução.** O modelo passaria a
  anunciar ao usuário uma capacidade que ele não tem, e cada tentativa gastaria
  uma etapa do orçamento para receber uma recusa. Menor privilégio no inventário
  é mais honesto e mais barato.
- **Deixar a decisão distribuída, só melhorando as mensagens.** Foi a decisão
  espalhada — condição no loop, texto no prompt, selo na interface — que produziu
  a divergência. Sem uma fonte única não há como testá-la.

## Consequências

- `github_push`/`github_create_pr` entram no inventário quando, e só quando, o
  pré-voo diz que entram. Uma segunda condição em qualquer outro lugar é
  regressão, e há teste de catraca para pegá-la.
- A interface passa a mostrar a **causa real** de um bloqueio; frases genéricas do
  tipo "a ferramenta não está habilitada" deixam de ser aceitáveis.
- Trocar branch, repositório ou branch base **invalida** a autorização e pede nova
  confirmação. É o comportamento correto, não um defeito — e está coberto por
  teste nos dois lados (`agent/githubAccess.test.js`,
  `frontend/src/hooks/useDevProjects.test.js`).
- O payload `developer` ganha o campo opcional `permissions`. Cliente antigo que
  não o envie continua funcionando: cai no caminho secundário (texto do turno) ou
  em `write_not_confirmed`. **Sem migration** — nada disso é persistido no banco.
- Limite conhecido: o pré-voo não verifica os escopos reais do PAT. Um token sem
  permissão de escrita só é descoberto quando o `github_push` falha, e aí a
  mensagem do conector nomeia a causa. Verificar antes exigiria uma chamada extra
  à API do GitHub por pré-voo; registrado como risco baixo em `CONTINUIDADE.md`.
