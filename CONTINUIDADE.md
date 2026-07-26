# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo (2.640 linhas) está preservado em `docs/CHANGELOG_HISTORY.md`.

---

## Estado atual

Aplicação multiusuário com agentes de IA, memória semântica, multimodelo, execução de
ferramentas em sandbox Docker, geração de documentos, Docling, conector GitHub e copiloto
(Nino). Backend Node 20 + Express + PostgreSQL (pgvector); frontend React 19 + Vite;
autenticação Better Auth (e-mail/senha, GitHub, Google).

**Prontidão para produção: 🟡 amarelo — apto com restrições.**
**Nenhum risco crítico aberto** desde o fechamento do F-04 (o backend não detém mais o
socket do Docker — ver `docs/SECURITY.md` §4.3). O que ainda impede o verde é a cobertura
de testes: **o SSE integrado saiu do zero** (ver a frente abaixo), mas a retomada após
interrupção real do processo e o pipeline multimodelo retomável continuam sem teste.
Critérios e caminho em `docs/AUDITORIA_2026-07.md` §6.

- **Último trabalho:** estabilização do **ambiente de execução do agente** (frente abaixo):
  um timeout deixou de derrubar o sandbox, toda execução devolve estado estruturado
  (ambiente × projeto), o reinício é anunciado com o que sobreviveu e o que se perdeu,
  e o agente ganhou a ferramenta `ambiente` (status, recursos, dependências,
  checkpoints). Antes dele, o **PR [#147](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/147)**
  (o Nino cobrindo o botão de enviar), o **PR [#146](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/146)**
  (Playwright + suíte ponta a ponta) e o **PR [#145](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/145)**
  (as sete falhas P0 dos sub-agentes).
- **Última validação:** 2026-07-26 — **833 testes** (backend 717, frontend 57, guarda do
  Docker 49, sandbox Python 10). Backend e frontend passaram neste contêiner: **698
  passaram, 0 falharam, 19 pulados** (os 19 exigem PostgreSQL, que não está de pé aqui —
  na CI rodam). Os 10 do Python não coletam aqui por falta do `openpyxl`. Os 13 E2E não
  entram nesta contagem porque o `e2e/` não está instalado neste contêiner. A contagem
  vem de `cd backend && npm run test:count` — não a escreva à mão.

---

## Estabilização do ambiente de execução do agente (2026-07-26)

O pedido era largo: tornar o ambiente onde o agente edita arquivos, instala pacotes e
roda testes **estável, persistente, observável e recuperável**, de modo que uma falha de
infraestrutura não seja confundida com falha do projeto. O diagnóstico apontou uma causa
raiz que explicava a maioria dos sintomas:

**Um timeout matava o container inteiro.** Os processos filhos morriam (correto), mas
levavam junto os pacotes instalados no turno, os serviços de apoio e todo o estado fora
do workspace — e o modelo não era avisado de nada. Ele seguia trabalhando como se o
ambiente anterior existisse: reinstalava, repetia etapas e, no pior caso, declarava
concluída uma execução que havia sido cortada.

O que mudou:

| Antes | Agora |
| --- | --- |
| Timeout derrubava o sandbox | Mata a **árvore de processos** (`FREDERICO_EXEC_ID` varrido em `/proc/*/environ`, alcança netos); só derruba o container se ela sobreviver à carência |
| Resultado era `{exitCode, output}` | + `status`, `sucesso`, `duracao_ms`, `processo_encerrado`, `saida_parcial`, `arquivos_alterados`, `diagnostico` |
| Falha de ambiente parecia bug do código | Taxonomia com `falha_do_projeto`: dependência, rede, permissão, recurso e ferramenta são do AMBIENTE; teste quebrado e exit ≠ 0 são do projeto |
| Reinício era silencioso | Evento `ambiente_reiniciado` com motivo, geração e as listas **preservado/perdido** — entregue uma única vez |
| `pip install` sumia com o container | `/cache` é bind do host por usuário (pip/npm/uv/poetry) e as instalações ficam num manifesto em `/workspace/.agent-env` |
| Sem rede de segurança para edições | Checkpoints do workspace (criar/listar/restaurar), fora da árvore da conversa, **sem segredos** |
| Sem visibilidade de recursos | Ferramenta `ambiente` → `recursos`: CPU, memória, disco, maiores diretórios e processos |
| Comando longo era uma barra parada | **Saída ao vivo** por SSE (`tool_progress`), com terminal no Ambiente de Trabalho e aviso "sem saída há Xs" |
| Resultado perdia o começo da saída | Log INTEGRAL em `/workspace/.agent-env/ultima-execucao.log` + ação `ultima_execucao` |

Detalhe importante da classificação, achado por teste: `ModuleNotFoundError` contém a
subcadeia `eNotFound` — com regex insensível a maiúsculas, uma dependência ausente virava
"problema de rede", exatamente o diagnóstico trocado que o módulo existe para evitar. Os
códigos de erro do sistema passaram a ser casados com fronteira de palavra e sem `i`.

Também: `/containers/<id>/stats` liberado no `docker-guard` (leitura, com posse pela
label — sem ela não dá para distinguir "morreu por falta de memória" de "o código
quebrou"), `/runtime/tmp` como `TMPDIR` descartável e `/artifacts` persistente na imagem
do sandbox.

Sobre o **corte da saída**: o resultado entregue ao modelo tem os últimos 12 mil
caracteres, e o erro de uma suíte longa está quase sempre no COMEÇO — que o corte
descartava. A saída inteira agora é gravada enquanto o comando roda, e o resultado aponta
o arquivo (`progresso.log_completo`). A gravação é síncrona de propósito: com
`createWriteStream`, o `end()` não garante os bytes em disco e a leitura no mesmo tique
encontrava o arquivo vazio. E `.agent-env` saiu da impressão digital do workspace — sem
isso, gravar o log fazia `arquivos_alterados` sair `true` em toda execução.

**Mudança visível para o usuário:** o assistente passa a avisar quando uma execução não
terminou, em vez de relatar sucesso; comandos longos mostram a saída **ao vivo** (com
aviso quando o comando emudece); e o agente ganha a ferramenta `ambiente`, que acompanha
automaticamente quem já tem `run_python`/`bash` (não é uma permissão nova a ligar no
Assistant Studio).

**Ficou de fora, de propósito** (§11 de `docs/AMBIENTE_EXECUCAO.md`): registro de
portas/serviços iniciados pelo agente, sintaxe explícita de transação de workspace,
snapshot do container e a consulta ao progresso **pelo próprio modelo** durante a
execução — esta última é limitação do laço de function-calling (enquanto a ferramenta
roda, o modelo está bloqueado esperando o resultado; não há turno em que ele possa
perguntar). Os dois efeitos práticos estão cobertos: o usuário vê ao vivo, o agente lê o
log integral depois.

Onde está: `backend/src/agentEnv.js`, `backend/src/sandbox.js`, ferramenta `ambiente` em
`backend/src/tools.js`, prompt em `backend/src/agent/prompts.js`, aviso de reinício e
evento `tool_progress` em `backend/src/agent/loop.js`, interface em
`frontend/src/hooks/useChat.js` e `frontend/src/components/ExecutionSession.jsx`.
Documentação em `docs/AMBIENTE_EXECUCAO.md`. Testes: `src/agentEnv.test.js` (27) e
`src/sandbox.stability.test.js` (13).

---

## O Nino cobria o botão de enviar (2026-07-26 — PR #147)

Primeiro defeito que a suíte E2E encontrou sozinha — e ele era pior do que pareceu na
primeira leitura. Medindo com navegador real em oito larguras:

| Largura | Sobreposição sobre o botão | O que o clique no centro do botão atingia |
| --- | --- | --- |
| 1920px | nenhuma | o botão |
| 1440px | nenhuma | o botão |
| 1280px | 23px | **o mascote** |
| 1100px | 40px (**botão inteiro**) | **o mascote** |
| 980px | 33px | **o mascote** |
| 820px | 33px | **o mascote** |
| 560px | 40px (**botão inteiro**) | **o mascote** |
| 390px | 40px (**botão inteiro**) | **o mascote** |

Ou seja: em notebook de 1280px e em **qualquer largura de celular**, tocar em "enviar"
acertava o Nino. Só funcionava em tela larga — provavelmente por isso passou tanto tempo
sem ser notado, e por isso nenhum teste o pegava: nenhum abria o app num navegador.

**Causa.** `.companionRoot` é `position: fixed; bottom: 22px`, e o compositor ocupa
justamente a base da tela. Em telas largas o compositor (máx. 840px, centralizado) para
antes da faixa do mascote; em telas médias e no celular ele usa a largura toda, e as duas
coisas disputam o mesmo canto.

**Correção.** O personagem passa a pousar **acima** do compositor:
`bottom: calc(var(--composer-h, 6px) + 16px)`. A altura vem medida — não escrita à mão —
por `frontend/src/hooks/useComposerHeight.js`, um *callback ref* com `ResizeObserver` no
`<footer className="composerWrap">`. Medir era necessário porque o compositor **cresce
com o texto** (a textarea vai até 160px) e muda entre modos de trabalho: qualquer número
fixo acertaria um caso e erraria os outros, em silêncio. Quem arrasta o mascote (o
componente salva a posição) continua no comando — o arraste usa `left/top` inline e
ignora o `bottom`.

**Guarda:** `e2e/tests/layout.spec.js`, 4 testes — sobreposição zero nas oito larguras,
compositor alto não empurra o mascote de volta, **clique real no botão** no desktop e no
celular, e um teste contra o exagero (o mascote tem de continuar visível dentro da
janela). Conferi que servem de guarda revertendo a correção: 3 dos 4 falham, com a
mensagem certa; o quarto passa nos dois casos, de propósito.

---

## Playwright: navegador headless e suíte ponta a ponta (2026-07-26 — PR #146, F-20)

Duas frentes numa só, porque as duas trocam a mesma peça.

### 1. O navegador headless passou a ser o Playwright

`backend/src/agent/pageShot.js` (miniatura de página do `web_fetch`) saiu do
`puppeteer-core` para o `playwright-core`. A imagem Docker **continua usando o Chromium do
apt** (`CHROMIUM_PATH=/usr/bin/chromium`) em vez de baixar o do Playwright: seriam ~150 MB
a mais na imagem de produção por um navegador que o apt já instalou.

**O que quase passou batido — e é o ponto importante desta frente.** O `page.route()` do
Playwright **não** é chamado de novo no destino de um redirecionamento; o
`setRequestInterception` do puppeteer era. Medido neste repositório, com um 302 de `/a`
para `/b`:

| | guarda chamado para `/a` | guarda chamado para `/b` | navegação |
| --- | --- | --- | --- |
| puppeteer | sim | **sim** | bloqueada |
| Playwright | sim | **não** | **seguiu** |

Ou seja: uma porta linha-a-linha teria reaberto SSRF por redirecionamento — bastaria uma
página pública responder 302 para `169.254.169.254` e o navegador do backend buscaria o
endereço de metadados da nuvem, exatamente a superfície que o F-04 aponta. A correção
segue os redirecionamentos **à mão** (`route.fetch({ maxRedirects: 0 })`), validando cada
salto antes de continuar.

De quebra, dois ganhos: `newPage()` do Playwright abre contexto próprio (cookies não vazam
de uma miniatura para a seguinte) e o `catch` que fazia `req.continue()` — falha **aberta**
— virou negação.

`pageShot.test.js`: 15 casos, sem navegador (as decisões são funções puras e o guarda
depende só da interface do `route`, então um duplo basta).

### 2. Suíte ponta a ponta (`e2e/`)

Chromium real contra o **build de produção** (`vite preview`), backend real e PostgreSQL
real. O único figurante é o provedor de IA: `e2e/fixtures/provedorFalso.mjs` responde no
lugar dele, de forma determinística — **nenhum teste usa rede externa ou chave paga**.

9 testes em 3 arquivos: streaming chega aos poucos e persiste; **duas conversas com troca
no meio do stream não misturam respostas**; recarregar a página no meio da resposta não a
perde (reconexão); indicador de "processando" na barra lateral; portão de consentimento
(LGPD); e a mensagem de chave inválida nomeando o provedor certo — a regressão do PR #140,
que até aqui só tinha teste de unidade.

Novo job `e2e` no CI, com Postgres real e Chromium. Ver `e2e/README.md`.

### Duas coisas que os testes encontraram

1. **O avatar do Nino ficava por cima do botão de enviar** — não corrigido naquele PR,
   **corrigido na frente seguinte** (seção acima), onde a medição mostrou que o problema
   valia para 1280px e todas as larguras abaixo, não só para 1280px.
2. **O modelo padrão do assistente continua sem prefixo de provedor.** Ao montar os
   testes foi preciso fixar o `modelRef` completo nos assistentes: sem isso o app manda
   `deepseek/deepseek-chat`, o `getUserProvider` cai no `rows[0]` e o teste da chave
   inválida recebia um eco normal em vez do 401. É a causa-raiz que já era o item 1 dos
   próximos passos — agora com uma demonstração reproduzível.

---

## Sub-agentes: as sete falhas P0 (2026-07-26 — PR #145)

Revisão técnica externa do mecanismo de delegação apontou 7 achados P0. Todos confirmados
contra o código e corrigidos nesta frente.

| # | Falha | Correção |
| --- | --- | --- |
| P0-01 | Sem especialista válido, o filho rodava com `assistant = null` e `toolsFor(null)` liberava **todas** as ferramentas — um assistente só-leitura ganhava `bash`/`write_file` ao delegar | `allowedTools = pai ∩ especialista` (`intersectToolDefinitions`); sem especialista, o filho herda o **perfil do pai** |
| P0-02 | `runAgent` recalculava rede e escrita no PC a partir do `userText` — que, no filho, é a subtarefa **escrita pelo modelo** | Herdadas do `DelegationContext`; o filho não chama `resolveSandboxNetwork` nem `explicitlyAuthorizesPcWrite` |
| P0-03 | Pai em `write:<projeto>` e filho em `read-only`: cada um derrubava o container do outro na primeira ferramenta | `sandboxOptions` e `developerContext` herdados verbatim → mesma `sandboxPolicy().key` |
| P0-04 | O prompt dizia "você não vê o histórico", mas o filho usava o mesmo `conversationId` e recebia memória + histórico inteiros | Janela isolada: sem `buildContext` e sem `selectHistoryForContext` quando `isSubagent` |
| P0-05 | `Promise.race([...ativas])` liberava **várias** tarefas por vaga: limite 2, pico 3 | Semáforo com contador + fila FIFO |
| P0-06 | Delegações do lote eram lançadas **antes** das outras ferramentas: `write_file` + delegar para revisar o arquivo → o filho lia o que ainda não existia | Paralelismo só em lote homogêneo (`canLaunchDelegationsInParallel`); lote misto roda em série |
| P0-07 | `control.activeTool` era slot único: com dois filhos executando, o Parar abortava só o último | `control.activeTools` virou `Set` |

De carona, três achados P1/P2 que tornavam os P0 difíceis de perceber:

- **P1-01/P1-02** — `especialista` era texto livre pedindo "o nome exato" sem o modelo saber
  quais existem: ele inventava "Fiscal", "Revisor", e o código caía no assistente padrão em
  silêncio, com a interface anunciando o nome pedido. Agora vai `especialista_id` com
  **`enum` dos ids reais** da conta e id inexistente devolve `SUBAGENT_SPECIALIST_NOT_FOUND`.
  O resultado carrega o especialista e o modelo que **de fato** rodaram, e a interface mostra.
- **P2-01** — a subtarefa era cortada em 6.000 caracteres em silêncio (o que se perde são as
  regras do final). O corte passa a ser declarado ao sub-agente.

**ARMADILHA:** a fronteira de autorização é o `DelegationContext` **congelado**, montado uma
vez pelo pai. Qualquer permissão nova do filho tem de entrar ali — derivar do texto da
subtarefa devolve a decisão ao modelo, que é exatamente o defeito de origem.

Detalhe em `docs/SECURITY.md` §8.1 e `docs/ARCHITECTURE.md` §13.1.

---

## GraphQL no sandbox e o inventário do modelo (2026-07-26 — PR #144)

`strawberry-graphql[fastapi,cli]` entrou na imagem do sandbox — schema por type hints,
`Schema.execute_sync` para consultar sem subir servidor, `strawberry.fastapi.GraphQLRouter`
para expor pelo FastAPI que já estava lá e o comando `strawberry` (GraphiQL local).

O inventário que o modelo lê foi atualizado nos **três** lugares em que ele existe — eram
independentes e é fácil mexer num e esquecer os outros:
`PYTHON_INVENTORY` (`agent/prompts.js`), a descrição do `run_python` (`tools.js`, que é o
que muitos modelos leem para decidir chamar a ferramenta) e a verificação automática de
ambiente (`ENVIRONMENT_QUERY_RE` + `ENVIRONMENT_AUDIT_COMMAND`, para "tem GraphQL aí?"
rodar `import strawberry` de verdade em vez de o modelo responder de memória).

**ARMADILHA (duas):**

1. O pacote é `strawberry-graphql`, o módulo é `strawberry` — mesma classe do `odfpy`/`odf`.
   Por isso ele entrou na lista de auditoria, que existe exatamente para os nomes que não
   batem.
2. O `pip install` fica numa camada **ao fim** do Dockerfile, não junto do `flask fastapi`.
   Acrescentar no meio do arquivo invalidaria todas as camadas seguintes — dotnet, Kotlin,
   Chromium, Playwright — e cada atualização baixaria tudo de novo numa VPS pequena. É o
   mesmo motivo já documentado no bloco acima dele.

Guarda novo: `agent/prompts.inventory.test.js` compara o que o modelo lê com o que o
Dockerfile instala. Ele **descarta os comentários** do Dockerfile antes de comparar — a
primeira versão passava com o pacote desinstalado porque casava com o comentário que o
cita. Verificado nos dois sentidos: falha ao remover o `pip install`, passa ao devolver.

`atualizar.sh` e o `docker compose up -d --build` já reconstroem a imagem do sandbox
(`sandbox-image`). Quem subir **sem** `--build` fica com a imagem antiga e o inventário
promete o que não existe — a regra de conferir no terminal antes de afirmar cobre o caso,
mas o certo é reconstruir.

O README também passou a descrever a caixa de ferramentas do sandbox (antes era só
"Python, Bash e geração de arquivos"), incluindo REST e GraphQL. Vale a regra de sempre:
só entra ali o que está de fato instalado na imagem.

---

## Bateria adversarial de injeção de prompt (2026-07-26 — PR #143, F-17)

`backend/src/agent/promptInjection.adversarial.test.js` — 33 casos escritos do ponto de
vista de quem controla o conteúdo externo, cobrindo os quatro vetores previstos no F-17:
README malicioso no repositório, memória envenenada em turno anterior, delimitador fechado
à força e resposta maliciosa de outro modelo no multimodelo.

Rodada contra o código anterior, a bateria acusou **15 falhas** — duas causas reais:

**1. O selo do delimitador só cobria a forma canônica.** `untrustedContext()` escapava
`</untrusted-context>` exato; escapavam da caixa `</untrusted-context foo="1">`,
`</untrusted-context/>`, `< /…>`, `</ …>` e a tag de **abertura** (que faz o fechamento
legítimo encerrar o bloco forjado, deixando o resto do payload aparentemente fora dele).
Os metadados do cabeçalho escapavam só aspas: um `>` ou uma quebra de linha no valor punha
texto do atacante **antes** do aviso "isto é dado" — o único trecho que o modelo lê como voz
do aplicativo.

**2. 🔴 O resultado de ferramenta ia CRU para o modelo.** `loop.js` fazia
`messages.push({ role: 'tool', content: result })` sem wrapper nenhum — apesar de o
`docs/SECURITY.md` §8 já afirmar que passava por `untrustedContext()`. É o maior canal de
texto de terceiros do app (`web_fetch` traz a página inteira, `read_file`/`bash` o arquivo
ou a saída do comando, `github_clone` o README) e a cadeia mais curta até **execução**: o
mesmo loop converte protocolo textual (`<tool_call>`, `<function=…>`) achado no texto do
modelo em chamada nativa, então bastava o modelo repetir um trecho da página lida para o
comando do atacante rodar no sandbox. O teste "a cadeia completa" prova os dois lados:
sem defesa o eco vira 1 chamada real; com o dado neutralizado, 0.

Correção em `promptRegistry.js`: `neutralizeExternalMarkup()` escapa a marcação estrutural
(delimitador em qualquer forma tolerante, `trusted-instruction` e o protocolo textual de
ferramenta), os atributos passam a escapar `<`, `>` e quebra de linha, e
`untrustedToolResult()` embrulha o resultado no `loop.js`. O `result` **cru** continua indo
para a interface e para `classifyToolOutcome` — quem precisa dele intacto.

**ARMADILHA:** o casamento é limitado a esses nomes de propósito. Escapar marcação genérica
mutilaria HTML, XML e código legítimos — e num domínio contábil/fiscal o conteúdo *é* o
dado. Quatro testes de não-regressão guardam isso (`R$ 1.234,56`, `a < b && b > c`,
bloco de código, `<div class="card">`).

---

## "Chave da API inválida" apontando o provedor errado (2026-07-26 — PR #140)

Conta com DeepSeek **e** OpenRouter: o OpenRouter sincronizou 345 modelos às
21:42:55 (chave válida) e o chat falhou às 21:42 com "Chave da API inválida ou
expirada". Mesma chave, mesmo minuto — ou seja, **a chamada que falhou não era a
do OpenRouter**.

Cadeia da causa:

1. `seed.js` grava nos assistentes padrão o modelo `deepseek/deepseek-chat` — um
   id **sem prefixo `<provedor>::`**. (O repositório ainda tem dois defaults
   incoerentes: `deepseek/deepseek-chat`, nome do OpenRouter, em `seed.js` e
   `routes/assistants.js`; e `deepseek-chat`, nome nativo, em `routes/schedules.js`,
   `inbox.js`, `conversations.js` e `helpers.js`.)
2. `getUserProvider` não acha esse id em catálogo nenhum e cai em `rows[0]` —
   **o provedor mais antigo**, que nesta conta é a DeepSeek.
3. A chave da DeepSeek é recusada → 401 → mensagem genérica mandando "confira sua
   chave", sem dizer de quem.

Corrigido **o diagnóstico**: `tagProviderError` marca no erro qual provedor e qual
modelo falharam (em `loop.js` nos dois catches do stream, no `multiModel.js` por
cartão e no `orchestrator.js`), e `friendlyApiError` nomeia os dois no 401/402.
7 testes novos, incluindo os casos sem contexto (a mensagem antiga não regride).

**Ainda em aberto (causa raiz):** `rows[0]` continua sendo um chute silencioso, e
os defaults sem prefixo continuam sendo gravados. O certo é o assistente guardar um
`modelRef` completo — frente própria, ainda não feita.

---

## 🔴 O sandbox não subia em NENHUM ambiente (2026-07-26 — PR #140)

`POST /containers/create` era recusado pelo guarda em toda tentativa, então
nenhuma ferramenta rodava. Mesmo sintoma no PC e na VPS, causas diferentes:

| Ambiente | Log | Causa |
| --- | --- | --- |
| Windows (Docker Desktop) | `bind por volume nomeado não é permitido: C:\Users\...\workspaces\...:/workspace` | `bindSource` cortava no primeiro `:` — o da **letra de unidade**. A origem virava `"C"`, que não começa com `/`, e caía na regra de volume nomeado. |
| VPS | `caminho proibido no host: /root/...` | `git clone` logado como root (o que o `VPS-DEPLOY.md` manda fazer) põe o projeto em `/root/<projeto>`, então `GUARD_WORKSPACE_ROOT` vira `/root/<projeto>/workspaces` — e a blocklist tem `/^\/root/`. |

Correções em `docker-guard/src/policy.js`:

- `normalizeHostPath` aceita caminho do Windows (`C:\a\b` / `C:/a/b`), devolve a
  forma canônica e continua recusando UNC e volume nomeado; `isInsideRoot`
  compara sem caixa quando os dois lados têm letra de unidade.
- `bindSource` ignora o `:` da unidade.
- **A raiz do workspace tem precedência sobre a blocklist de diretórios de
  sistema** — ela vem da configuração do operador, não do backend, então confiar
  nela não amplia a superfície que o F-04 fecha.
- O **socket do Docker saiu da blocklist comum** (`isDockerSocket`) e é barrado
  antes de tudo: nem uma raiz mal configurada o libera.
- Blocklist equivalente para Windows (`C:\Windows`, `Program Files`,
  `ProgramData`, `AppData`) — sem ela, ligar "Pastas do PC" num host Windows
  ficaria sem blocklist nenhuma, já que as regras POSIX nunca casam com `C:/...`.

9 testes novos (40 → 49), incluindo os invariantes: socket sempre barrado, `/root`
**fora** da raiz segue barrado e os diretórios de sistema do Windows também.

---

## 🔴 A tela "Algo deu errado por aqui" (2026-07-26 — PR #140)

Abrir **qualquer conversa em que a IA tivesse usado uma ferramenta** derrubava a
aplicação inteira na tela do `ErrorBoundary`. Causa:

```js
export { SUBAGENT_TOOL } from '../executionSteps.js';   // ExecutionSession.jsx
```

Um re-export cria a **entrada de exportação** do módulo, mas **não** uma variável
local. `SUBAGENT_TOOL` era usado logo abaixo em `summarize()` e em `ResultView()` —
ou seja, referência a um global inexistente. `summarize()` roda num `useMemo` do
`ExecutionSessionInner`, que o `App.jsx` monta para todo bloco `type: 'tool'`:
`ReferenceError` na primeira renderização e a árvore inteira caindo. Corrigido
importando o nome (binding de verdade) e reexportando a partir dele — a superfície
pública do módulo continua igual. Reproduzido no Chromium antes e depois.

**É a segunda ocorrência da mesma classe de bug** (a primeira foi `chunksIncluded`,
no Context Builder). Nada pegava: `node --check` não pega — a sintaxe é válida; o
build não pega — o bundler resolve exportações, não escopo; e o `lint` do frontend
**ignorava os `.jsx` por inteiro**. Daí a rede nova: `frontend/scripts/reexportBindings.mjs`
acusa nome re-exportado que é usado no próprio arquivo, roda também nos `.jsx` e tem
12 testes próprios (`scripts/` entrou na varredura do `run-tests.mjs` — um guarda que
erra é pior que guarda nenhum).

---

## O que mudou por último (embeddings sem a árvore vulnerável, 2026-07-25 — PR novo)

Migração de `@xenova/transformers@2.17.2` (parado, sem manutenção) para
`@huggingface/transformers@4` — o sucessor mantido. **`npm audit --omit=dev`:
7 vulnerabilidades (1 crítica, 4 altas) → 2 moderadas.**

| Antes | Depois |
| --- | --- |
| `protobufjs` — execução arbitrária de código (**crítica**) | eliminada |
| `onnx-proto`, `onnxruntime-web` (altas) | eliminadas |
| `sharp <0.35.0` — CVEs herdadas do libvips (alta) | `override` para `^0.35.3` |
| `adm-zip <0.6.0` — ZIP forjado aloca 4 GB (alta, via `onnxruntime-node`) | `override` para `^0.6.0` |
| `uuid <11.1.1` via `dockerode` (moderada) | **mantida, com justificativa** |

O `npm` marcava `sharp` e `adm-zip` como "sem correção" porque as versões
corrigidas estão fora do range declarado pelas dependências; `overrides` no
`package.json` resolve. A do `uuid` exigiria forçar um major no `dockerode`
(que declara `^10.0.0`) — e o `dockerode` só chama `uuid.v4()` sem o parâmetro
`buf`, então o caminho vulnerável (bounds check em v3/v5/v6 com `buf`) é
**inalcançável**. Forçar o major arriscaria a execução de código no sandbox
para fechar um risco que não existe aqui.

### A armadilha real: a quantização

A v4 mudou o padrão de `model_quantized.onnx` (int8) para `model.onnx` (fp32).
Aceitar o padrão novo teria dois efeitos silenciosos: o download saltaria de
**113 MB para 470 MB** (com a RAM proporcional, numa VPS pequena) e — pior — os
**vetores mudariam de valor**. Os que já estão no banco e nos artefatos do
Docling foram gerados com o modelo quantizado; a comparação por cosseno passaria
a misturar duas escalas, sem erro nenhum, só recuperação pior.

Correção em três partes:
1. `dtype: 'q8'` fixo (`EMBEDDING_DTYPE`) — exatamente o mesmo arquivo de pesos.
2. A **identidade do vetor** passou a incluir a quantização
   (`Xenova/multilingual-e5-small@q8`). `maybeReindexOnModelChange` compara essa
   identidade, então qualquer mudança futura de modelo OU de quantização dispara
   a reindexação sozinha — antes só o nome do modelo era comparado.
3. Os vetores dos artefatos do Docling ficam **fora** do alcance do `reindexAll`
   (que só cobre `memory` e `conversation_chunks`) e a chave do cache do Docling
   não inclui o modelo. Agora a identidade é gravada junto do `embeddings.json` e
   conferida na leitura; quando não bate, os vetores são descartados e o
   `context.js` cai na seleção por palavras — pior, porém correta.

**Medição, não suposição:** instalando as duas bibliotecas lado a lado e gerando
os mesmos textos, os vetores do `@xenova/transformers@2.17.2` e do
`@huggingface/transformers@4` com `q8` são **bit a bit idênticos** (diferença
máxima por componente 0, cosseno 1,000000). Por isso a identidade legada (sem
sufixo) é aceita como equivalente: **nenhuma instalação existente reindexa nem
reprocessa documento** por causa desta troca.

**Validação:** backend 590 testes (577 ✓, 13 pulados por exigirem PostgreSQL),
frontend 45 ✓, build ✓. Testes novos: `memory/embeddings.test.js` (14) e
`docling/artifacts.test.js` (7), cobrindo identidade, compatibilidade retroativa
e as entradas degeneradas dos artefatos.

---

## O que mudou por último (auditoria PC + Docling, 2026-07-25 — PR #132)

Auditoria de ponta a ponta da integração com o computador do usuário e da camada
documental. Achados corrigidos, com testes de regressão para cada um:

| Área | Achado | Correção |
| --- | --- | --- |
| Execução | `run_python` **não passava por guarda nenhuma** — só o `bash` era validado, e ele era contornável por heredoc | Novo `backend/src/execGuard.js`: mount somente-leitura sem autorização do turno (garantia do Docker), análise linha a linha do Python e auditoria em `companion_audit` |
| Execução | `rm -rf /home` e `/var` passavam pelo padrão antigo | Alvo passa a listar os diretórios de sistema por nome |
| Docling | Progresso calculado e **descartado** — a UI lia `stats.stage`, nunca preenchido (`setStatus` era código morto) | Estágio persistido a cada mudança; barra de progresso no painel |
| Docling | Cancelamento existia no serviço e no runner **sem rota nem botão** | `POST /docling/documents/:id/cancel` de ponta a ponta, com status `canceled` próprio |
| Docling | `pypdf` importado sem estar declarado: a detecção de PDF com senha **nunca rodava** | Declarado no `requirements.txt`; ausência agora é logada |
| Docling | Conteúdo dos documentos não chegava ao **multimodelo** nem ao **Modo Equipe** (modos que não executam ferramentas) | Bloco `document-content` nos três caminhos |
| Markdown | **Perda total de dados**: relatório de 120 páginas virava string vazia; páginas que diferiam só nos valores eram descartadas como duplicatas | `norm()` preserva dígitos; só linhas de paginação são mascaradas; rede de segurança impede esvaziar página com conteúdo |
| Serviço | Cache de resultados sem teto de memória; `_gc_jobs` coletava jobs vivos; hash recebido ignorado | Teto em bytes com LRU; só jobs terminados são coletados; hash conferido |

Causa raiz das duas perdas de dados: mascarar todos os dígitos ao comparar linhas,
num domínio contábil/fiscal em que **o número é o conteúdo**.

Também nesta frente: `CLAUDE.md` (regra permanente de abrir PR ao concluir),
repaginação do README como vitrine do produto, e `docs/CONFIGURACAO.md`.

> Convergência com o PR #133: os dois PRs corrigiram, de forma independente, o
> `destroyAllSandboxes` global que derrubava containers de todos os usuários. Ficou
> a versão da `main` (`destroySandboxesForUser`), mais completa. O `docs/ARQUITETURA.md`
> que esta frente criou foi removido em favor do `docs/ARCHITECTURE.md` do #133.

---

## O que mudou por último (auditoria de produção, 2026-07-25 — PR #133)

| Commit | Assunto |
| --- | --- |
| `78fd482` | Workspace e sandbox escopados por usuário; invalidação direcionada; labels e reconciliação de containers órfãos |
| `1ff3c4f` | Backup com chave mestra + manifesto/checksum/trava; administração persistida em `user_roles` com auditoria |
| `fd70dac` | Uploads por streaming em disco, tetos e cotas; antivírus com status honesto |
| `ad7879c` | CI com PostgreSQL real, migrações, todos os testes do frontend, smoke de boot e portão de autenticação |
| PR seguinte | **F-04 fechado**: serviço `docker-guard` — o backend perdeu o socket do Docker |
| `7a56b1f` | Reorganização da documentação e relatório da auditoria |

Detalhe de cada achado (evidência, causa raiz, correção, testes) em
`docs/AUDITORIA_2026-07.md`.

---

## Correção da memória (Context Builder 3.1, 2026-07-25 — branch `claude/memoria-dominio-conversa`)

Numa conversa de software, "vamos continuar o projeto" recuperava 38 memórias e 20
conversas contábeis (IRPF, aviso prévio, alteração contratual). Duas causas somadas:

1. **Pedido sem palavra-chave desligava o crivo inteiro.** Sem 2 hits de domínio, o
   prompt caía em `general`, o que liberava os quatro domínios e desativava as
   penalidades de desvio. O domínio passa a vir também do **contexto da conversa**
   (modo desenvolvedor com repositório, ou as últimas mensagens do usuário).
2. **O limiar não correspondia à escala do modelo.** O `multilingual-e5-small` nunca
   desce de ~0,79, mesmo para textos sem relação; os pisos eram 0,25/0,30. A
   similaridade passa a ser calibrada (0,80–0,92 → 0..1) antes de virar pontuação e
   antes de ser exibida na interface.

O nome do projeto é deliberadamente ignorado na classificação: "SPED-HUB" é software
mas cai inteiro no dicionário contábil. Detalhe completo, com as medições do modelo,
em `docs/CHANGELOG_HISTORY.md`. Piso configurável por `MEMORY_MIN_SIM`.

### Ao atualizar uma instalação existente para esta versão

1. **Faça backup antes** (`GET /api/backup` — agora leva a chave mestra junto).
2. Suba normalmente. No log do boot, confira as duas linhas novas:
   `[workspace] migração de layout: N movido(s)…` e `[sandbox] reconciliação: …`.
3. Acesse uma rota administrativa uma vez para o papel de admin ser gravado em
   `user_roles` (o `ADMIN_EMAIL` atual continua valendo como bootstrap).
4. Confira em `/api/health` que `sandbox.docker.modo` é `"guarda"` — o backend deve
   alcançar o Docker **só** pelo serviço `docker-guard`.
5. Em instalação PESSOAL com "Pastas do PC" ligadas, ponha também
   `GUARD_ALLOW_PC_FOLDERS=true` no serviço `docker-guard` — do contrário os mounts de
   pastas do host serão recusados (de propósito).
6. Em instalação pública, revise: `CLAMAV_REQUIRED=true`, `ADMIN_USER_ID`,
   `UPLOAD_USER_QUOTA_MB`. Ver `docs/SECURITY.md` §10.

---

## System prompt consolidado (2026-07-25 — branch `claude/system-prompt-review-mte8v0`)

Retomada dos itens 1–3 que ficaram pendentes quando o PR #43 foi fechado (a refatoração
modular invalidou o diff), agora refeitos contra `backend/src/agent/*`:

- **Preâmbulo em poucas mensagens system**, alinhado aos breakpoints do prompt caching:
  `messages[0]` = prompt-base + `QUALITY_BAR` (estável na conversa — breakpoint 1);
  `messages[1]` = nota de ferramentas (**índice reservado**, reescrito quando as
  ferramentas mudam); dados não confiáveis seguem como `user` (`untrustedContext`); e
  UMA mensagem reúne as notas de sistema da chamada, fechando o prefixo estático
  (breakpoint 2). Mesma consolidação no Modo Equipe e no multimodelo. Motivo: vários
  modelos servidos via OpenRouter tratam mal uma pilha de mensagens system.
- **Deduplicação**: caminho de arquivos/downloads e aviso anti-`/mnt/user-data` só na
  `toolAvailabilityNote`; "uma frase antes das ferramentas" só em `EXECUTION_UX_RULES`;
  rede/pacotes/apt só em `SANDBOX_RULES` (o modo Programação perdeu os bullets
  repetidos); checklist final do `QUALITY_BAR` comprimido.
- **Precedência de estilo**: o sufixo dos sliders de personalidade prevalece sobre as
  regras gerais de estilo.
- `PROMPT_RELEASE` → `2026.07.25.1`; módulos `global`/`tools` → `3.2.0`.

**ARMADILHA:** `messages[1]` continua reservado à nota de ferramentas; `QUALITY_BAR`
agora mora DENTRO de `messages[0]` — não voltar a empilhá-lo como mensagem própria.

---

## Continuidade por projeto (Context Builder 4.0, 2026-07-25 — branch `claude/mobile-site-responsiveness-8z0eb9`)

Abrir um chat **novo dentro de um projeto** começava do zero: o agente ignorava as
últimas conversas e decisões e trazia memória antiga sem relação. O 3.1 melhorou o
crivo, mas não podia resolver isto — **não existia vínculo entre projeto, conversa e
memória**. Os projetos do Modo Desenvolvedor viviam só no `localStorage`; o backend
nunca soube a que projeto uma conversa pertencia, então "as últimas conversas deste
projeto" era impossível de consultar. Pesos e limiares não criam um dado que não está
no banco — daí a reincidência ao longo de 3.0, 3.0.1 e 3.1.

- **Migração `018`** — `dev_projects` e `project_id` em `conversations`,
  `conversation_chunks`, `memory` e `memory_suggestions`.
- **Camadas de continuidade** com prioridade acima de tudo (últimas a serem cortadas
  pelo orçamento): identidade e memória permanente do projeto → últimas conversas dele
  → decisões, correções e pendências.
- **`projectLinked`** no scorer: conteúdo do projeto ativo ganha bônus forte e fica
  imune à penalidade de domínio. Recência vale 0,15 (decai em 30 dias) dentro do
  projeto e segue fraca fora.
- Projetos antigos são **adotados** na primeira mensagem — o histórico do navegador
  entra de uma vez, sem reabrir conversa a conversa.
- Só as **tecnologias** do projeto entram na detecção de domínio; nome e descrição
  ficam de fora pelo mesmo motivo já documentado no 3.1 ("SPED-HUB" é software mas cai
  no dicionário contábil).

Todo o 3.1 foi preservado (calibração de similaridade, `softDomain`, `domainsAllowed`,
`DOMAIN_INDEX`, dedup real). O PR #125 foi fechado como superado, com a otimização de
performance dele já incorporada pelo #134.

### 🔴 Corrigido de carona: o Context Builder não rodava

O 3.1 usava `chunksIncluded` sem declarar. O `push` ficava dentro de um `try {} catch {}`
que engolia o `ReferenceError`, e a montagem seguinte — fora do try — derrubava o
`buildContext` inteiro. Como `loop.js` também tem `try/catch` com fallback, a falha era
silenciosa e total: **toda resposta caía no `memoryNote` simples**. Confirmado rodando a
versão do `main`: `ReferenceError: chunksIncluded is not defined`. Corrigido com a
declaração faltante e teste de regressão.

---

## Modo Desenvolvedor no celular (2026-07-25 — mesma branch)

O Modo Desenvolvedor abria quebrado no celular: texto quebrando letra a letra e botões
sobrepostos. O grid de 4 colunas (`barra lateral · explorador · conversa · atividade`)
assumia a conversa sempre na 3ª coluna; no celular a barra lateral vira gaveta
(`position:fixed`) e os trilhos somem, então a conversa caía na 1ª faixa — de **0px** —
deixando a faixa útil vazia. Os pontos de quebra do arquivo (900/1180px) também não
batiam com os 980px do resto do app. Corrigido em `frontend/src/dev-handoff.css`:
até 1180px vira barra lateral + conversa; até 980px, coluna única. Verificado com
renderização real (Playwright) em 360, 393, 600, 900, 1000 e 1300px.

---

## Riscos abertos

| ID | Risco | Severidade |
| --- | --- | --- |
| F-15 | Pipeline multimodelo sem coordenador durável: reinício não retoma a próxima etapa pendente. | 🟠 Alta |
| F-12 | SSE integrado: duas conversas, troca rápida e reconexão **agora cobertos** por `e2e/`; falta o caso isolado de `fromSeq` (reconectar sem duplicar eventos). | 🟡 Média |
| F-14 | Sem teste de retomada após interrupção **real** do processo. | 🟠 Alta |
| F-05b | Sandbox com rede habilitada não tem allowlist de egress. | 🟡 Média |
| F-13 | Provedor simulado: streaming, catálogo e erro 401 **cobertos** por `e2e/fixtures/provedorFalso.mjs`; faltam tool calls e timeout. | 🟡 Média |
| F-16, F-18, F-19, F-23 | Relevância de memória (casos negativos), corpus do Docling, git local, validação de artefato com arquivos reais. | 🟡 Média |
| F-24 | Sub-agentes: sem orçamento próprio de tempo/tokens por delegação e sem catálogo de modelos com tool calling **verificado** (hoje qualquer modelo do seletor pode receber uma subtarefa). | 🟡 Média |
| F-25 | Sub-agentes paralelos compartilham `outputs/`: a atribuição de arquivo por filho pode se cruzar e dois filhos podem gravar o mesmo nome. O conjunto que o usuário recebe está certo (o pai também faz o diff); o rótulo por sub-agente é que não é confiável. | 🟡 Média |
| F-21 | `App.jsx` com 62 `useState`; bundle num único chunk (teto de 1.000 KB no CI); CSS em camadas sem inventário. | 🟡 Média |
| F-11 | Sem quarentena/reprocesso do que passou com o antivírus degradado. | 🟡 Média |

---

## Próximos passos (em ordem)

1. **Modelo do assistente sem provedor** (causa raiz do 401 do PR #140, ainda aberta).
   `getUserProvider` cai em `rows[0]` — o provedor mais ANTIGO — quando o id do modelo
   não tem prefixo `<provedor>::` e não aparece em catálogo nenhum. O assistente deve
   guardar um `modelRef` completo. Envolve: unificar os dois defaults incoerentes
   (`deepseek/deepseek-chat` em `seed.js` e `routes/assistants.js`; `deepseek-chat` em
   `schedules`, `inbox`, `conversations` e `helpers`), migrar os assistentes já gravados
   e decidir o que fazer quando o modelo não for atribuível — hoje o chute é silencioso.
2. **F-12/F-13, o que sobrou** — reconexão do `/stream` com `fromSeq` sem duplicar
   eventos, e tool calls/timeout no provedor falso (`e2e/fixtures/provedorFalso.mjs`,
   onde o resto já está pronto).
3. **F-14** — retomada após `kill -9` no meio de um run, com checkpoint real.
4. **F-15** — tabela `pipeline_runs` (`pipeline_run_id`, `current_stage`,
   `completed_stages`, `pending_stages`, `artifact_versions`, `status`, `checkpoint`,
   `updated_at`) e retomada no boot.
5. **F-21** — extrair de `App.jsx`, por etapas: shell → estado da conversa → estado da
   execução → drawers/configurações. `React.lazy` nos painéis pesados.
6. **F-24/F-25 (sub-agentes, o que sobrou dos P1/P2)** — orçamento por delegação
   (`SUBAGENT_TIMEOUT_MS`, `MAX_STEPS`, `MAX_TOKENS`, deadline compartilhado); diretório
   `outputs/<delegationId>/` com manifesto por filho; catálogo persistido de capacidade de
   tool calling por `provedor+modelo+endpoint` (hoje `markModelCapabilityUnsupported` só
   vive em memória e se perde no reinício); controle "Usar sub-agentes: automático /
   desligado / obrigatório" e motivo de indisponibilidade na interface.

---

## Como retomar o desenvolvimento

```bash
# 1) Postgres igual ao da produção (e ao do CI)
docker run -d --name fred-pg -e POSTGRES_USER=studio -e POSTGRES_PASSWORD=studio \
  -e POSTGRES_DB=studio -p 5432:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgres://studio:studio@localhost:5432/studio

# 2) Backend
cd backend && npm install
npm run test:integration    # migrações do zero + suíte completa
npm run dev

# 3) Frontend
cd frontend && npm install
npm test && npm run dev

# 4) Antes de commitar
cd backend  && npm run check   # lint + testes
cd frontend && npm run check   # lint + testes + build

# 5) Mexeu em interface, streaming ou login? Rode também os E2E (exige Postgres)
cd e2e && npm install && npm run navegador   # só na primeira vez
cd e2e && E2E_DATABASE_URL=$DATABASE_URL npm test
```

**Convenções que valem a pena manter:**

- **Escopo de usuário é obrigatório.** `workspaceFor(conversationId, userId)` lança
  `WORKSPACE_SCOPE_REQUIRED` sem dono — é intencional: um chamador esquecido tem de
  falhar no teste, não gravar num caminho sem dono.
- **Testes que precisam de banco se auto-pulam** sem `DATABASE_URL`, mas o CI de
  integração **falha** se algum for pulado com o banco disponível.
- **Comentários explicam o porquê**, não o quê — em especial o problema que a linha
  resolve. É o padrão do repositório e o que torna este código legível meses depois.
- **Commits pequenos e rastreáveis**, um assunto por commit.

- **Docker só pelo guarda.** O backend não monta `/var/run/docker.sock`; quem monta é o
  `docker-guard`, que valida cada requisição. Rota nova para o daemon exige liberar em
  `docker-guard/src/policy.js` — negar por padrão é a regra.

**Mapa da documentação:** `docs/ARCHITECTURE.md` (como funciona) ·
`docs/SECURITY.md` (ameaças e controles) · `docs/OPERATIONS.md` (runbook) ·
`docs/BACKUP_RESTORE.md` · `docs/TESTING.md` · `docs/AUDITORIA_2026-07.md` ·
`docs/CHANGELOG_HISTORY.md` (histórico).
