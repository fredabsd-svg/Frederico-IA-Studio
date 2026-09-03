# Arquitetura real do Frederico AI Studio

> Levantado por leitura do código em **2026-07-25** (branch `claude/frederico-audit-production-gduf4s`).
> Este documento descreve o que o código **faz**, não o que a documentação antiga
> dizia que ele faria. Onde há divergência entre intenção e implementação, ela
> está marcada como **lacuna**.

---

## 1. Serviços e dependências

| Serviço | Imagem/base | Papel | Depende de |
| --- | --- | --- | --- |
| `web` | Caddy (`frontend/Dockerfile`) | Serve o SPA e faz proxy de `/api` para o backend. Único serviço com portas expostas (80/443). | `backend` |
| `backend` | `node:20-slim` (`Dockerfile`) | API HTTP + SSE, agente, ferramentas, memória, Docling, conectores. Processo **único** (estado em memória). **Não** enxerga o socket do Docker. | `postgres`, `docker-guard`, `clamav` (opcional), `docling-service` (opcional) |
| `docker-guard` | `node:20-slim`, sem dependências (`docker-guard/Dockerfile`) | **Único** container com `/var/run/docker.sock`. Valida cada requisição ao daemon (allowlist de rotas, corpo de `create`, posse por label). Sem portas expostas. | Docker socket do host |
| `postgres` | `pgvector/pgvector:pg16` | Banco único de tudo, inclusive as tabelas do Better Auth e os embeddings (pgvector). | — |
| `clamav` | `clamav/clamav:stable` | Antivírus dos uploads (protocolo INSTREAM por TCP). Opcional. | — |
| `docling-service` | `docling-service/Dockerfile` (Python) | Conversão documental (PDF/OCR → JSON + Markdown). Perfil `docling`, sem portas. | — |
| `sandbox-image` | `sandbox/Dockerfile` | **Não é serviço**: build one-shot da imagem `frederico-ai-sandbox:latest` usada pelos containers efêmeros. | — |
| sandboxes | `frederico-ai-sandbox:latest` | Containers efêmeros criados pelo backend via `dockerode`, um por (usuário, conversa) — **através do `docker-guard`**. | `docker-guard` |

**Estado em memória do backend** (não sobrevive a reinício, e não é compartilhável entre réplicas):
`liveStream.js` (buffer SSE por conversa), `sandbox.js` (`sessions`, `creating`, `pcFoldersByUser`),
`agent/control.js` (controles de pausa/parada), `freeQueue.js` (fila do modo gratuito),
`uploads.js` (concorrência por usuário), caches de ferramentas.
→ **O app assume um único processo de backend.** Rodar duas réplicas contra o mesmo
Postgres quebra reconexão SSE, cancelamento, fila e reconciliação de sandbox.

---

## 2. Fluxo HTTP e autenticação

```
navegador → Caddy (/api/*) → Express (backend/src/server.js)
   ├─ helmet + CORS restrito (FRONTEND_URL/BETTER_AUTH_URL; sem eles, origin:false)
   ├─ rate limit por IP: /api geral (RATE_API_PER_MIN, 600/min) e /api/auth POST (50/15min)
   ├─ /api/auth/*  → Better Auth (montado ANTES do express.json — precisa do corpo cru)
   ├─ express.json({ limit: '10mb' })
   ├─ requireAuth  → sessão Better Auth → req.userId / req.user   (exceto /health e /auth)
   ├─ ensureUserSeeded(req.userId)  (idempotente, cache em memória)
   ├─ validação de :id de conversa (isConversationId)
   └─ routers de src/routes/* (22 módulos)
```

- **Entrada:** cookie de sessão do Better Auth.
- **Persistido:** tabelas `user`, `session`, `account`, `verification` (migração 002).
- **Erro:** 401 JSON padronizado; erro não tratado vira 500 sem stack (handler global).
- **Recuperação:** shim async em `app[method]` e em `makeRouter()` encaminha rejeições ao handler de erro — uma query quebrada não derruba o processo.
- **Autorização administrativa:** papel persistido em `user_roles` (migração 020), auditado em `admin_audit`. `ADMIN_EMAIL` é apenas bootstrap. Ver `docs/SECURITY.md`.
- **Testes:** `src/routes/admin.test.js`; portão de autenticação verificado no CI (9 rotas → 401).
- **Lacuna:** não há teste automatizado do fluxo de login/OAuth em si (só do portão).

---

## 3. Fluxo SSE

Dois canais, ambos em `routes/conversations.js`:

| Rota | Papel |
| --- | --- |
| `POST /api/conversations/:id/chat` | Inicia o run **e** transmite os eventos. |
| `GET /api/conversations/:id/stream?fromSeq=N` | **Reconecta** a um run em andamento (replay do buffer + ao vivo). 204 quando não há nada. |

- Todo evento passa por `liveStream.publish()` antes de ir à resposta: buffer de replay
  (5.000 eventos / 3 MB, descarta os mais antigos) + fan-out para assinantes.
- Após `finish()`, o buffer sobrevive **90 s** (`GRACE_MS`) para quem reconecta no último segundo.
- Heartbeat `: ping` a cada 15 s (evita corte por idle timeout de proxy).
- Desconexão do navegador **não** cancela a tarefa (a menos de `CANCEL_ON_DISCONNECT=true`);
  o resultado é persistido e reaparece ao voltar.
- **Isolamento entre conversas:** o registro é `Map<conversationId, LiveStream>` e o id de
  conversa é chave primária global — dois usuários não podem ter o mesmo id. A rota `GET
  /stream` confere posse antes de assinar.
- **Testes:** `src/liveStream.test.js`, `frontend/src/sse.test.js`.
- **Lacuna confirmada:** não existe teste **integrado** de SSE (rota Express real → cliente),
  nem teste de duas conversas transmitindo ao mesmo tempo. Ver `docs/AUDITORIA_2026-07.md` (F-12).

---

## 4. Fluxo de uma mensagem mono-modelo

```
POST /chat
 ├─ isConversationActive?            → 409 (uma resposta por conversa)
 ├─ countActiveRunsForUser >= 5?     → 429 (MAX_ACTIVE_RUNS_PER_USER)
 ├─ ensureConversation(userId, id)   → cria (escopada ao dono) ou 404 se for de outro
 ├─ validateAttachmentManifest       → 409 se um anexo declarado não está em disco
 ├─ enforceDailyLimit / modo gratuito (fila + cotas)
 └─ agent/loop.js  runAgent({ userId, conversationId, ... })
      ├─ getUserProvider(userId, modelo)             → chave BYOK / servidor / gratuita
      ├─ contexto: buildContext (memória) + buildDocumentContext (Docling) + uploadsNote
      ├─ prompts: promptRegistry/promptPolicy (hierarquia — ver §12)
      ├─ visão: imageUploadParts(userId, conversationId) quando o modelo tem visão
      ├─ baseline de saída: listOutputs(userId, conversationId)
      ├─ laço: provider.stream → tool_calls → runTool(...) → repete
      │    ├─ streamGuard: watchdog de stream travado
      │    ├─ repair.js: degeneração, truncamento, protocolo de ferramenta vazado
      │    └─ control.js: pausa/parada cooperativa
      ├─ checkpoint.js: salva o array de mensagens em interrupção retomável
      ├─ outputs.js: diff de arquivos + validação (validateOutputs)
      └─ persistence.js: saveMessage + arquivos + indexAfterReply (memória)
```

- **Eventos ao frontend (contrato SSE real do canal de chat):** `status`, `delta`,
  `response_reset`, `run_state`, `prompt_meta`, `memory_context`, `tool_start`,
  `tool_progress`, `tool_result`, `plan_update`, `input_required`, `resumable`,
  `files`, `file_checks`, `saved`, `execution_failed`, `free_queue`, `free_status`,
  `done`, `error` e a família `mm_*` do multimodelo (`mm_start`, `mm_status`,
  `mm_delta`, `mm_reset`, `mm_round`, `mm_done`). Todo evento é publicado no
  `liveStream` antes do `res.write` e sai carimbado com `_seq`/`_runId` — tanto
  no stream primário do `POST /chat` quanto na reconexão (`GET /stream`), o que
  dá ao cliente um cursor exato para reconectar sem replay integral.

### 4.0 Máquina de estados e runs duráveis (ADR 0003)

- **Máquina de estados explícita:** `agent/runStateMachine.js` define a tabela de
  transições válidas dos 14 estados de `executionState.js` e o rastreador
  (`createRunStateTracker`) é o único emissor de `run_state` dentro de um run.
  Transição inválida não derruba o run: é emitida com o carimbo
  `invalidTransition` e logada (falha nos testes). O backend é a autoridade —
  a UI não deduz "concluído" do fim do stream.
- **Runs duráveis:** `agent_runs` + `agent_run_events` (migração 032). O
  gravador (`agent/runLog.js`) mora nas rotas `/chat` e `/resume` — o único
  ponto por onde todos os eventos passam — e persiste os estruturais
  (`tool_start`, `tool_result`, `run_state`, `input_required`, `plan_update`,
  `files`, `file_checks`); `delta`/`status`/`tool_progress` ficam de fora.
  `GET /conversations/:id/runs` devolve os runs com as etapas e o plano
  reconstruídos (timestamps reais do servidor) — é o que permite à interface
  remontar terminal/atividade depois de reload. No boot, runs sem `ended_at`
  são fechados como `recoverable_error` ("o servidor foi reiniciado") pela
  varredura `sweepOrphanAgentRuns`. A retomada reutiliza o mesmo `run_id` e
  continua a sequência de eventos.
- **Plano estruturado:** a ferramenta interna `update_plan`
  (`agent/planTool.js`), interceptada antes do `runTool`, mantém a lista de
  passos da missão (id/título/status/evidência); um passo só fica `completed`
  com evidência (validado no backend). O plano vai ao stream (`plan_update`),
  ao run log e ao `execution_meta` da mensagem, e viaja no checkpoint.
- **ChangeSet real:** `agent/changeSet.js` + `GET /conversations/:id/changes` —
  a verdade do git sobre o(s) clone(s) da conversa (`status --porcelain` +
  `diff HEAD --numstat`), lida pelo backend sem token e sem sandbox. A aba
  "Alterações" exibe status M/A/D/R com ±linhas por arquivo; sem repositório
  git, cai no fallback heurístico (apresentado como pista, não como diff).
- **Code Intelligence leve (decisão 6A):** `agent/codeIntel.js` — ferramentas
  `find_file` (glob/trecho do nome) e `search_text` (literal/regex + filtro
  glob, resultado arquivo+linha+trecho), executadas no backend sobre o
  workspace, com contenção (sem symlink, sem `node_modules`/`.git`, binário
  ignorado) e limites explícitos. São ferramentas ACOMPANHANTES: entram
  sozinhas quando o assistente já pode ler o workspace (como a `ambiente`),
  sem mexer na configuração por assistente. Sem language server nesta fase.
- **Doom loop:** `agent/doomLoop.js` — mesma ferramenta + mesmos argumentos +
  mesmo resultado repetidos (3×) são BLOQUEADOS antes do executor, com erro
  estruturado que instrui a mudar de estratégia; resultado novo zera a
  contagem (progresso legítimo). O bloqueio conta no freio de falhas
  consecutivas do loop.
- **Layout do workspace (Fases 51, 52 e 55):** `frontend/src/devWorkspaceLayout.js`
  — módulo PURO que decide o que a sessão anuncia (projeto, branch de
  TRABALHO vinda do pré-voo real, ambiente, modelo, permissões) e quanto do
  workspace aparece por padrão. A **simplicidade progressiva** começa em Chat +
  Tarefa + Terminal e abre o resto sob demanda ("Mostrar tudo"); a escolha
  explícita do usuário sobre uma coluna sempre vence o padrão do nível
  (`null` = ainda não decidiu). A grade de três colunas + terminal + compositor
  já existia e **não foi reescrita**: a frente mexeu na lógica, não no grid.
  As colunas do modo desenvolvedor passaram a chunks lazy (a entrada do bundle
  caiu de 920 para 890 KB).
- **Diff por arquivo e reversão por hunk (Fase 27 completa):**
  `agent/diffView.js` + `GET /conversations/:id/diff` e
  `POST /conversations/:id/revert`. O arquivo alterado abre em hunks; cada
  trecho pode ser desfeito isoladamente com `git apply --reverse` sobre um
  patch reconstruído do diff ATUAL — se o arquivo mudou desde a leitura, o git
  recusa e nada é aplicado (melhor que aplicar no lugar errado). Arquivo
  inteiro volta por `git checkout HEAD --`; arquivo novo (não rastreado) é
  descartado. Contenção: repositório e caminho confinados ao clone da conversa
  (caminho absoluto e `..` são RECUSADOS, não normalizados), e a rota recusa
  reversão com a tarefa em execução.
- **Telemetria local de confiabilidade (Fase 66):** `agent/reliability.js` +
  `GET /api/reliability` + o bloco recolhido na aba "Atividade". O painel da
  Frente 14 mede CONSUMO; este responde **se o trabalho deu certo** —
  distribuição de desfechos dos runs, taxa de falha por ferramenta, duração
  (mediana/p90) e sinais medidos. **Não há migration nem coleta nova:** tudo
  deriva de `agent_runs`/`agent_run_events`, que a Fase 17 já grava, e nada sai
  da instalação. `awaiting_user`/`paused` ficam fora do denominador (parar
  esperando o usuário não é falha nem sucesso); a falha de ferramenta usa o
  MESMO `toolResultLooksFailed` do terminal; sinal só aparece com amostra
  mínima; e o corte de amostra é declarado no resultado. Escopo é do próprio
  usuário, opcionalmente filtrado por projeto. Detalhes em
  `docs/OBSERVABILITY.md`.
- **Validação por navegador (Fase 38):** `agent/pageCheck.js` +
  `agent/pagePreviewServer.js`, expostos ao agente como a ferramenta
  `validar_pagina`. O review gate mede o DIFF; esta fase mede o RESULTADO
  RENDERIZADO — o defeito clássico de frontend (import quebrado → página em
  branco com erro no console) não aparece em teste unitário nem no diff.
  A página é servida por um servidor HTTP efêmero em `127.0.0.1`, porta
  aleatória, raiz no workspace da conversa, somente leitura e derrubado ao fim
  da chamada; o Chromium é o mesmo do `pageShot.js`, com uma guarda **mais
  estreita**: só a origem fixada do servidor passa, e todo o resto — internet,
  outra porta do loopback (inclusive a API do backend), `file:` — é abortado e
  **registrado como evidência**. Coleta: erro de JS não tratado, erro de
  console, resposta 4xx/5xx de recurso local, requisição externa bloqueada,
  detector de tela em branco (sem texto visível **e** sem elemento visual — as
  duas condições, para não reprovar página só de imagem) e as asserções que o
  próprio agente declara (`esperar_seletor`, `esperar_texto`). A captura vai
  para `outputs/`, onde o usuário a vê. **Sem Chromium no ambiente a ferramenta
  devolve `disponivel: false` com o motivo — nunca um "validado" falso.**
  **Segundo modo — o dev server, sem mexer em fronteira nenhuma**
  (`agent/pageCheckSandbox.js`): o container nasce com `NetworkDisabled` e sem
  publicação de portas, então o backend não alcança o `npm run dev` da tarefa.
  A saída não é abrir isso — é inverter o movimento: **o navegador vai até o
  servidor**. A imagem do sandbox já traz `chromium` e `playwright`
  (`sandbox/Dockerfile`), e um container sem rede continua tendo loopback, de
  modo que um script Playwright rodando lá dentro alcança
  `http://127.0.0.1:<porta>`. O backend escreve o script no workspace, executa
  com `execInSandbox` (`NODE_PATH="$(npm root -g)"`, porque o pacote é global e
  só o `require` honra a variável), lê UMA linha marcada por sentinela e monta
  o veredito com o **mesmo** `buildVerdict` — as duas formas de validar
  precisam reprovar pelos mesmos critérios. Antes de gastar um navegador num
  timeout, `sandboxServices` confere o que está de fato escutando e, se a porta
  estiver errada, o erro diz **qual é a certa**. O script temporário é apagado
  em `finally`.
  **Limite honesto:** a validação mede erro, ausência e presença — não faz
  asserção de layout nem comparação visual entre versões.
- **Handoff local ↔ worktree (Fase 24):** `agent/handoff.js` +
  `GET /conversations/:id/handoff`, `GET .../handoff/patch` e
  `POST .../handoff/apply`. O trabalho da tarefa mora no clone da conversa e até
  aqui só saía dali por `github_push` + PR. Agora há ponte nos dois sentidos:
  o painel monta os comandos que o USUÁRIO roda na máquina dele
  (`git fetch` + `git worktree add --track -b <branch> ../<dir> origin/<branch>`,
  que não toca o checkout dele), e oferece como patch o que a worktree não
  traria. A base do patch é `origin/<branch>` quando há commit local não
  publicado e `HEAD` caso contrário — com base fixa em `HEAD`, o commit do meio
  sumiria dos dois caminhos. Arquivo não rastreado entra no patch por um ÍNDICE
  TEMPORÁRIO (`GIT_INDEX_FILE`): o `git add -A` enxerga tudo sem tocar o índice
  do clone. No sentido de volta, `git apply --check` antes de aplicar: o patch
  entra inteiro ou não entra (sem `--3way`, que deixaria marcador de conflito
  dentro dos arquivos da tarefa), e o clone é devolvido ao uid do sandbox
  (`chownTree`) para o agente poder editar depois o que recebeu.
  **Limite honesto:** sem branch publicada, os commits locais só saem pelo
  GitHub — o patch cobre a partir de `HEAD`, não da base da branch.
- **Review gate + painel de confiança (Fases 28 e 44):** `agent/reviewGate.js`
  — antes de a tarefa se apresentar como entregue, o backend passa um pente
  automático no que foi REALMENTE alterado (ChangeSet + `git diff HEAD -U0`),
  procurando segredo em linha adicionada (blocker), teste desligado
  (`.only`/`.skip`, high), código alterado sem teste tocado (high), remoção de
  caminho sensível, código de depuração, TODO/FIXME novo e arquivos fora do
  que o plano menciona. Não é opinião do modelo: são sinais medidos no diff.
  Achado **não bloqueia** a publicação por conta própria — ele vai ao evento
  `verification`, ao `execution_meta` (sobrevive ao reload) e, quando é
  blocker/high, ao TEXTO da resposta; a autorização continua sendo do usuário.
  Falha do gate nunca derruba o run (a entrega segue sem revisão).
  **O gate também lê o navegador** (`pageCheckFindings`): os vereditos da
  `validar_pagina` (Fase 38) executados na mesma tarefa entram como achados —
  página **reprovada** no navegador é `high` (defeito medido, no mesmo nível de
  "código sem teste"); página HTML alterada e **nunca validada** é `medium`
  (ausência de evidência, o irmão do `missing_test`); e validação que **não
  pôde rodar** é `low`, existindo para impedir que a entrega diga "validado"
  quando nada foi. Uma tentativa que só deu erro não conta como validação.
  **Limite:** o sinal de "faltou validar" vê apenas HTML dentro do repositório
  git da tarefa — artefato solto em `outputs/` não entra no ChangeSet.
- **Branch de trabalho por tarefa (Fase 23):** `agent/workBranch.js` — o
  isolamento de ARQUIVOS já vem do clone por conversa; o de HISTÓRICO vem
  daqui. Em modo de escrita sobre branch protegida (main/master/develop…) ou
  sem branch fixada, a tarefa commita numa branch derivada determinística
  (`frederico/<slug-do-projeto>-<sufixo-da-conversa>`) e a vinculada vira base
  do PR — a mesma conversa retomada volta para a MESMA branch. Branch de
  trabalho explícita no vínculo não é atropelada. A decisão acontece no
  `githubPreflight` (fonte única de inventário, interface e prompt), e o escopo
  da autorização estruturada é conferido contra a branch EFETIVA. O caminho
  legado de autorização por texto do turno **não** ganha alcance: continua
  exigindo branch explícita no vínculo.
- **Projetos dev no servidor (ADR 0004):** `dev_projects` carrega o projeto
  INTEIRO (vínculo, regras, memória, `permissions`, `mode` — migração 033) e é
  a fonte de verdade; o navegador é cache (`useDevProjects`: bootstrap por
  `GET /api/dev-projects`, migração única do localStorage via `/import`,
  mudanças por PUT com debounce, exclusão solta as conversas em vez de apagar
  histórico). A lista de conversas do projeto deriva de
  `conversations.project_id`.
- **Política de comandos:** `agent/permissionPolicy.js` — allow/ask/deny por
  padrão de comando (glob, última regra que casa vence; compostos lineares
  divididos e vale a decisão mais restritiva). `ask` devolve
  `PERMISSION_REQUIRED` instruindo o `ask_user`; a confirmação vira autorização
  estruturada (`commandGrants`), re-validada no backend (só padrões `ask` da
  política sobrevivem) e herdada pelos sub-agentes via `DelegationContext`.
  É política de produto sobre as fronteiras duras (sandbox, docker-guard,
  execGuard) — não as substitui.

### 4.1 `input_required` — pergunta interativa do agente

Pedir uma **decisão** ao usuário (escopo, opção A ou B, autorização) não é falha. O agente
tem uma ferramenta interna, `ask_user`, que o loop **intercepta antes do `runTool`**: ela não
roda no sandbox, não toca arquivo nem rede — só encerra o turno.

```json
{ "type": "input_required",
  "request": { "id": "iq_xxxxxxxxxx", "kind": "select",
    "question": "Qual estratégia devo aplicar?",
    "options": [ { "label": "Correção mínima", "value": "minimal", "description": "Altera apenas o defeito." } ],
    "required": true, "createdAt": "2026-08-06T00:00:00.000Z" } }
```

| Aspecto | Como funciona |
| --- | --- |
| Validação | `agent/userInputRequest.js` RE-VALIDA os argumentos do modelo: `kind` ∈ text/confirm/select, `select` exige 2–8 opções com valores distintos, limites de tamanho, HTML recusado, **id gerado no backend**. Argumento inválido volta ao modelo como resultado de ferramenta (`ASK_USER_INVALID`) — o turno não morre. |
| Estado | `awaiting_user` (terminal). `finalExecutionState` já o produzia; agora `classifyTaskResult` devolve `waiting_user` e as rotas **não** emitem `execution_failed`. |
| Persistência | `execution_meta.inputRequest` (JSON já existente — **sem migration**). É daí que a interface reconstrói a pergunta depois de um reload ou de um replay. |
| Replay | Idempotente: a solicitação é identificada por `id` e sobrescreve a mesma chave na mensagem. |
| Checkpoint | `awaiting_user` entra em `RESUMABLE_REASONS`: o progresso de uma tarefa longa não se perde entre a pergunta e a resposta. |
| Limites | Não oferecida a sub-agentes, a turnos sociais (`lowSignalTurn`), a tarefas de segundo plano (`interactive: false` em `routes/tasks.js`) nem a assistentes sem ferramentas. Só a **primeira** solicitação válida de um lote vale. |
| Fallback | `endsAwaitingUserReply` (repair.js) continua reconhecendo a pergunta escrita no texto — inclusive fechamentos sem `?` ("aguardo sua confirmação"). Nesse caso a solicitação sai com `kind: 'text'` e `fallback: true`. |
| Frontend | `components/UserInputRequest.jsx` (cartão inline) + `UserInputRequestDialog.jsx` (modal, chunk sob demanda). Fechar não descarta; a pergunta deixa de aparecer como pendente quando existe mensagem posterior do usuário (`executionSessions.js → pendingInputRequest`). |
| Testes | `backend/src/agent/userInputRequest.test.js`, `agent/repair.awaiting.test.js`, `taskOutcome.test.js`, `frontend/src/executionSessions.test.js`, `e2e/tests/modo-desenvolvedor.spec.js`. |
- **Persistido:** `messages` (+`execution_meta`, `memory_meta`, `multi_meta`), `files`, `usage`, `usage_daily`, `execution_checkpoints`, `agent_runs`/`agent_run_events` (ADR 0003), `conversation_chunks`.
- **Erro:** `friendlyApiError` traduz o erro do provedor; `classifyTaskResult` decide se houve falha real.
- **Recuperação:** failover de modelo (`MODEL_FALLBACKS`), retomada por checkpoint (`POST /resume`).
- **Testes:** ~495 casos no backend cobrem prompts, reparo, protocolo, capacidades, controle, checkpoint.
- **Lacuna:** não há teste ponta a ponta com provedor HTTP simulado completo (F-13).

---

## 5. Fluxo multimodelo (`agent/multiModel.js`)

| Modo | Execução | Coordenador |
| --- | --- | --- |
| `compare` | Todos em paralelo, respostas lado a lado. | Nenhum |
| `council` | Todos em paralelo. | Consolida concordâncias/divergências |
| `debate` | Rodadas (`MULTI_MAX_ROUNDS`, padrão 3), cada um lê os outros. | Fecha |
| `pipeline` | Sequencial; no Modo Desenvolvedor a etapa "implementador" executa de verdade via `runAgent`. | Última etapa entrega |

- Cada modelo é uma chamada **independente** (`getUserProvider` por membro) — não é failover disfarçado.
- Versionamento de artefato por etapa: `snapshotArtifactVersion(userId, conversationId, ...)`
  copia `outputs/` para `.multimodel/<runId>/vNN/`.
- Cancelamento individual: `POST /multimodel/cancel` com o slot.
- **Persistido:** `multi_meta` na mensagem final; checkpoints por etapa via `runAgent`;
  e o **coordenador durável** em `pipeline_runs` (migração 027, F-15 fechado): o
  `POST /chat` reserva o run antes do SSE e da mensagem, e o `runMultiModel`
  persiste `current_stage`/`state_json` entre etapas. `POST /resume` restaura
  o contrato original e o mesmo `runId`; mensagem nova diante de run recuperável
  recebe 409, e `POST /control` consegue encerrá-lo mesmo depois de restart.
  Toda primitiva operacional é escopada por `user_id`.

---

## 6. Fluxo de ferramentas (`tools.js`)

| Ferramenta | Onde roda | Rede |
| --- | --- | --- |
| `run_python`, `bash`, `zip_outputs` | Sandbox Docker | Desligada, salvo autorização do turno |
| `write_file`, `read_file`, `list_files` | Backend (dentro do workspace) | — |
| `web_search`, `web_fetch` | Backend | Sim, com bloqueio de SSRF |
| `consultar_cnpj` | Backend (BrasilAPI/ReceitaWS) | Sim |
| `generate_image` | Backend (provedor do usuário, escolhido por capacidade) | Sim |
| `github_*` | Backend (o token **nunca** entra no sandbox) | Sim |

- **Credencial da geração de imagem (`imageProvider.js`):** o caminho implementado é o do
  OpenRouter — `POST /chat/completions` com `modalities: ['image','text']` e a imagem em
  `choices[0].message.images`. Um endpoint OpenAI-compatível qualquer **não** faz isso
  (DeepSeek, Groq e Mistral só devolvem texto), então a chave não é escolhida por ordem de
  cadastro e sim por **capacidade**: vale a chave cujo catálogo importado declare um modelo
  com `architecture.output_modalities` contendo `image`, preferindo a do modelo ativo na
  conversa. `IMAGE_MODEL` (env) impõe um modelo, mas só num provedor que o tenha. O **modo
  gratuito** fica de fora salvo se o operador tiver posto um modelo de imagem em
  `FREE_TIER_MODELS` — a chave é da plataforma, e os modelos de imagem são pagos.
  Quando nenhuma chave serve, o erro nomeia o que falta (`IMAGE_SEM_PROVEDOR`) em vez de
  alegar ausência de chave. Testes: `imageProvider.test.js` e `imageProvider.db.test.js`.

- **Caminho:** todo acesso a arquivo passa por `safeJoin` → `insideBase` + `realInside`
  (resolve symlinks: `ln -s / /workspace/root` é bloqueado).
- **Guarda de comandos:** `GUARD_PATTERNS` bloqueia `rm -rf /`, fork bomb, `dd` em disco,
  `sudo`, `docker`, etc. É defesa em profundidade — a fronteira real é o container.
- **SSRF:** `isBlockedHost` + `assertHostResolvesPublic` (checa cada IP resolvido, cada redirecionamento).
- **Testes:** `tools.ssrf.test.js`, `tools.pathResolution.test.js`, `tools.cnpj.test.js`, `tools.websearch.test.js`.

---

## 7. Sandbox: criação, isolamento e destruição

```
execInSandbox(conversationId, cmd, timeout, { userId, ...política })
  └─ (dockerode → DOCKER_HOST=tcp://docker-guard:2375 → valida → socket do daemon)
  └─ getContainer → chave de sessão `${userDirName(userId)}/${conversationId}`
       ├─ política bate? reusa   |   não bate? dropSession + recria
       ├─ single-flight por (usuário, conversa)
       ├─ enforceUserSandboxCap  (MAX_SANDBOXES_PER_USER, padrão 2, LRU)
       └─ createContainer
            ├─ bind: HOST_WORKSPACE_ROOT/users/<dono>/<conversa> → /workspace
            ├─ mounts /mnt/pc/<label>: SÓ as pastas do PC DESTE usuário
            ├─ Labels: com.frederico.{app,user,conversation,instance,manager-version}
            └─ HostConfig: CapDrop ALL, no-new-privileges, PidsLimit 256,
               Memory/NanoCpus, AutoRemove, NetworkDisabled por padrão
```

**Ciclo de vida:**
- Reaper de ociosidade: 30 min sem uso (`SANDBOX_IDLE_TTL_MS`).
- Reaper de disco: `.tmp_*.py` órfãos (2 h) e retenção opcional de `outputs/`.
- **Reconciliação de órfãos** (novo): no boot remove todo container com a label do app
  vindo de outra instância; varredura periódica recolhe os que sumiram do mapa.
  Nunca toca em container sem a label.
- **Invalidação direcionada** (novo): mudar pastas do PC descarta só os sandboxes **daquele** usuário.
- **Observação sem efeito colateral:** `execInActiveSandbox(userId, conversationId, ...)` —
  não cria, não troca, não mata; usado pelo monitor do copiloto.
- **Timeout NÃO derruba mais o container** (novo): o comando leva
  `FREDERICO_EXEC_ID` no ambiente, e o encerramento varre `/proc/*/environ` para
  matar a árvore inteira (filhos, netos). O sandbox só cai se a árvore
  sobreviver à carência — antes, um `pytest` travado custava as dependências da
  sessão.
- **Saída ao vivo** (novo): `execInSandbox` aceita `onProgress`; o loop repassa
  como evento SSE `tool_progress` e a interface mostra um terminal ao vivo, com
  aviso de silêncio ("sem saída há Xs"). A saída INTEGRAL vai para
  `/workspace/.agent-env/ultima-execucao.log` — o resultado é aparado nos últimos
  12 mil caracteres e o erro de uma suíte longa costuma estar no começo.
- **Serviços e transação de workspace** (novo): `ambiente` → `servicos` cruza o
  que o agente subiu (uvicorn, vite, http.server…) com o que está realmente
  escutando (`ss`/`netstat`), marcando o que morreu no reinício;
  `transacao_iniciar/confirmar/desfazer` dá ponto de retorno a uma edição em
  vários arquivos, e a transação ABERTA reaparece no preâmbulo do turno seguinte.
- **Estado estruturado + aviso de reinício** (novo): toda execução devolve
  `status`, `diagnostico` (ambiente × projeto), `arquivos_alterados` e, quando o
  container foi trocado, `ambiente_reiniciado` com o que sobreviveu e o que se
  perdeu. Camadas: `/workspace` e `/cache` persistentes, `/runtime/tmp`
  descartável. Ver **`docs/AMBIENTE_EXECUCAO.md`**.
- **Testes:** `src/sandbox.isolation.test.js` (11 casos), `src/sandbox.id.test.js`,
  `src/sandbox.stability.test.js`, `src/agentEnv.test.js`.

---

## 8. Workspace em disco

```
WORKSPACE_ROOT/
  users/
    <userDirName(userId)>/
      <conversationId>/
        uploads/        arquivos enviados pelo usuário
        outputs/        entregas geradas
        repo/           clones do GitHub (modo desenvolvedor)
        .multimodel/    versões de artefato por etapa do pipeline
        .thumbs/        miniaturas do web_fetch
  <conversationId>/     LEGADO — migrado no boot (migrateLegacyWorkspaces)
```

`userDirName()` é **injetivo**: ids já seguros (`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`) viram eles
mesmos; qualquer outro vira `h_<sha256[0:40]>` — dois usuários nunca caem na mesma pasta.
`workspaceFor(conversationId, userId)` **exige** o dono (`WORKSPACE_SCOPE_REQUIRED`).

---

## 9. Fluxo de upload

```
POST /conversations/:id/upload
  1. beginUpload           → 413 pelo Content-Length declarado; 429 por concorrência
  2. multer diskStorage    → streaming para DATA_DIR/tmp-uploads/req-XXXX (nunca RAM)
  3. ensureConversation    → 404 se a conversa é de outro dono
  4. enforceUploadLimits   → total real da requisição + cota de disco do usuário
  5. scanOrReject          → ClamAV por streaming; infectado é apagado na hora
  6. hashFileStreamSync    → sha256 em blocos
  7. commitUploadedFile    → rename (ou copy+unlink em EXDEV) para users/<dono>/<conversa>/uploads
  8. INSERT em files       → id, nome original, path, size, hash, mime
  9. kickProcessing        → Docling em segundo plano (não bloqueia a resposta)
 10. finally               → cleanupRequestUploads (o staging some sempre)
```

Resposta: `{ files, scanned, scanStatus, rejected }`.
`scanStatus` ∈ `verificado` | `degradado` | `sem-antivirus` — a interface **não pode**
exibir selo de verificado quando o antivírus não analisou.

- **Testes:** `src/uploads.test.js`, `src/routes/upload.http.test.js` (integrado), `src/clamav.test.js`.

---

## 10. Fluxo Docling (`src/docling/`)

```
upload → kickProcessing → processFile
  ├─ chave de cache: (user_id, hash, config_version)   → idempotente
  ├─ runner.js → docling-service (HTTP, token interno) → JSON completo
  ├─ markdown.js  (Markdown otimizado, o que vai à IA)
  ├─ chunker.js   (chunks com referência de página)
  ├─ tables.js    (resumo + avisos de tabela)
  ├─ semantic.js + memory/embeddings.js (embeddings dos chunks)
  └─ persistência: document_processings + artefatos em DOCLING_CACHE_ROOT/<userId>/<hash>_<cfg>
```

- Isolamento por usuário: o diretório de artefatos inclui o `userId` — dois usuários com o
  **mesmo** arquivo têm derivados separados (dedup é por usuário, não global).
- Retenção: `DOCLING_RETENTION_DAYS` apaga só **derivados** (reprocessáveis), nunca o original.
- LGPD: apagar o arquivo dispara `purgeIfOrphan(userId, hash)`.
- Falha do serviço → fallback silencioso (o app segue sem Docling).
- **Lacuna:** a bateria documental pedida (PDF escaneado, DRE, PGFN, células mescladas,
  centenas de páginas…) **não foi executada** nesta auditoria — exige o serviço Python de pé
  e um corpus real. Ver F-18.

---

## 11. Fluxo de memória (`src/memory/`)

```
indexer.js       → após cada resposta, fatia e indexa a conversa (conversation_chunks)
embeddings.js    → @huggingface/transformers local (q8); degrada para busca lexical se indisponível
vectorStore.js   → pgvector quando a extensão existe; senão, varredura em JS
memoryService.js → memórias explícitas (memory) + sugestões (memory_suggestions)
relevanceScorer.js → Context Builder 3.0: pontua CADA memória e CADA conversa antiga
retrievalPolicy.js → isLowSignalTurn: saudação/confirmação curta não puxa contexto
contextBuilder.js  → monta o contexto final + metadados para a UI (MemoryTrace)
```

- A memória recuperada é embrulhada por `untrustedContext()` (`promptRegistry.js`) — entra
  como **dado**, nunca como instrução.
- A UI (`MemoryPanel.jsx`, `components/MemoryTrace.jsx`) exibe o que foi usado e a pontuação.
- **Testes:** `memory/relevanceScorer.test.js`, `memory/contextBuilder.test.js`, `memory/retrievalPolicy.test.js`.
- **Lacuna:** não existe a suíte de relevância com casos negativos pedida (memória
  conflitante, cliente diferente, injeção dentro da memória, troca de modelo de embeddings). Ver F-16.

---

## 12. Hierarquia de prompts (`agent/systemPromptV4.js`, `prompts.js`, `promptRegistry.js`, `promptPolicy.js`)

Ordem real de montagem, do mais forte ao mais fraco:

1. núcleo global imutável (`global-core@4.2.0`);
2. contrato de ferramentas (`tool-contract@3.3.0`) — só as ferramentas **autorizadas**;
3. perfil do assistente (`assistantProfileBlock` — prompt do usuário **não** amplia permissão);
4. modo de trabalho (desenvolvedor / multimodelo / artefato);
5. memória → `untrustedContext()`;
6. repositório e arquivos → `untrustedContext()`;
7. respostas de outros modelos → `untrustedContext()` + `MULTI_ARTIFACT_PROTOCOL`;
8. pedido atual do usuário;
9. resultados de ferramentas (role `tool`).

### 12.1 `messages[0]` — o prompt v4.2

Até a v4.1 o preâmbulo era uma **colagem** de cinco constantes escritas em
épocas diferentes (`IMMUTABLE_CORE_PROMPT`, o perfil, `QUALITY_BAR`,
`EXECUTION_UX_RULES`, `SANDBOX_RULES`, `COMPLETION_PROTOCOL`), mais o bloco de
kits que só o assistente "Documentos profissionais" recebia. A colagem repetia a
mesma regra em vozes diferentes — "não diga que concluiu quando o status é
timeout" vivia em três redações — e a ordem entre os pedaços era acidental.

A v4.2 é **um texto**, montado por `promptFor(assistant, opts)` nesta ordem:

| # | Bloco | Onde mora | Por que aí |
| --- | --- | --- | --- |
| 1 | NÚCLEO DE CONFIANÇA | `promptPolicy.js` | é o que nenhum perfil pode substituir |
| 2 | `<assistant-profile>` + estilo | `promptPolicy.js` + `personalitySuffix` | envelope ESCAPA o delimitador: um perfil não consegue fechá-lo e fingir que virou sistema |
| 3 | PADRÃO DE RESPOSTA | `systemPromptV4.js` | absorveu a `QUALITY_BAR` |
| 4 | CICLO DE EXECUÇÃO | `systemPromptV4.js` | absorveu `EXECUTION_UX_RULES` + `COMPLETION_PROTOCOL` |
| 5 | DOCUMENTOS PROFISSIONAIS | `prompts/docpro/atual.txt` | **só com `run_python` na chamada** (ver abaixo) |
| 6 | SANDBOX — fatos do ambiente | `systemPromptV4.js` | absorveu `SANDBOX_RULES` |
| 7 | EXEMPLOS DE RESPOSTA FINAL | `systemPromptV4.js` | forma da resposta, não conteúdo |
| 8 | EM CASO DE CONFLITO | `systemPromptV4.js` | **penúltimo**: só se lê como hierarquia depois de tudo que ordena |
| 9 | CONTEXTO DESTA CHAMADA | `systemPromptV4.js` | **último**: data de hoje, modelo e estado da rede |

O que continua sendo montado por código e anexado **depois** dele não mudou:
`toolAvailabilityNote`, `uploadsNote`, `pcFoldersNote`, a nota do Modo
Desenvolvedor e a de pesquisa web.

**A seção de documentos é condicional.** São ~10,8 mil caracteres de API de kit
e ela entra só quando `run_python` está entre as ferramentas do assistente: sem
execução não há arquivo para gerar. O prompt sai com ~20,4 mil caracteres para
quem executa e ~9,6 mil para quem não executa — antes eram ~21,8 mil para o
assistente de documentos e ~9,8 mil para todos os outros, que **não recebiam a
API dos kits nenhuma**. Um assistente personalizado com execução gerava `.docx`
sem saber que o kit existia, e diagramava na mão.

**A data entra no prompt, a hora não.** `callContextVars()` preenche
`{{data_extenso}}`, `{{data_ddmmaaaa}}`, `{{fuso}}`, `{{ano}}`, `{{modelo}}` e
`{{rede}}`. Sem a data escrita ali o modelo usa a do próprio treinamento e assina
um relatório com o ano errado. A **hora** fica de fora de propósito:
`messages[0]` é o prefixo estável da conversa e o primeiro breakpoint do cache de
prompt — uma hora ali invalidaria o cache a cada turno. Quem precisa do relógio
roda `date` no bash. Variável sem valor vira string vazia, nunca `{{...}}` cru:
um placeholder no texto é lido pelo modelo como conteúdo e reaparece na resposta.

**Quem NÃO recebe o v4.2:** os especialistas do Modo Equipe e o coordenador do
multimodelo. Eles não executam ferramentas — opinam sobre a mensagem e devolvem
texto —, então continuam com `protectedProfilePrompt()`: núcleo + perfil +
`QUALITY_BAR` + `COMPLETION_PROTOCOL`, abaixo de 6 mil caracteres. Arrastar o
ciclo de execução e o sandbox para cada parecer seria pagar 20 mil caracteres
por especialista, por rodada, sem uso.

`promptPolicy.js` decide o que entra por turno; `toolProtocol.js` limpa protocolo de
ferramenta que vaze como texto (`sanitizeToolProtocolText`), na exibição **e** na exportação.
- **Testes:** `agent/prompts.context.test.js` (data, fuso, placeholder, ordem dos
  blocos e as catracas de tamanho), `agent/promptPolicy.test.js` (ordem das
  seções, fronteira do perfil, envelope enxuto dos especialistas),
  `promptKits.test.js` (a seção de documentos travada contra a API real dos kits),
  `agent/promptRegistry.test.js`, `agent/prompts.dev.test.js`, `toolProtocol.test.js`,
  `agent/assistantPolicy.test.js`.
- **Lacuna:** não há bateria adversarial de injeção (README malicioso, delimitador fechado
  à força, resposta maliciosa de outro modelo). Ver F-17.
- **Validação de comportamento:** texto não tem teste unitário que prove que o
  modelo responde melhor, então o nível de cima é uma bateria de mensagens reais
  — `backend/scripts/validar-prompt.mjs` (`npm run validar:prompt`), com os
  casos em `agent/promptValidation/`. Ela monta o `messages[0]`/`messages[1]`
  **reais** (`promptFor` + `toolAvailabilityNote`, com as ferramentas do
  assistente do caso) e mede a decisão observável de cada promessa desta seção:
  pedido de arquivo vira chamada de `run_python` e não código colado no chat;
  pergunta de decisão encerra o turno; a data usada é a do bloco CONTEXTO DESTA
  CHAMADA e não a do treinamento; a regra 7 acompanha o idioma de quem escreveu;
  sem `run_python`, o modelo culpa a configuração em vez de dizer que gerou o
  arquivo. Sem `--live` não toca a rede — por isso fica fora do CI. O veredito é
  **triagem**, não aprovação: o `--md` traz a resposta inteira para leitura
  humana. O harness é testado em `promptValidation.test.js`.
- **Lacuna:** a bateria mede o v4.2 contra o comportamento esperado, mas **não**
  faz o A/B automático com o v4.1 — as constantes antigas foram removidas, e o
  comparativo exige rodar a bateria também no commit anterior. Ver a nota em
  `CONTINUIDADE.md`.

---

## 13. Checkpoint, retomada e cancelamento

| Peça | Onde | Comportamento |
| --- | --- | --- |
| Checkpoint | `agent/checkpoint.js` + migração 007 | Um por conversa. Persiste o array de mensagens + modelo + cadeia de failover. Teto de 600 KB com aparo que **preserva o pareamento** `tool_call`/`tool_result`. |
| Quando salva | Limite de ciclos, falha/stall do provedor, parada do usuário com progresso. **Não** salva em falha de qualidade (degeneração/protocolo) — ali o certo é refazer. |
| Retomada | `POST /conversations/:id/resume` | Não grava nova mensagem de usuário; reusa a última. Orçamento de ciclos novo. |
| Idempotência | Resultados de ferramentas já executadas continuam no array → o modelo parte para a próxima etapa, sem repetir. |
| Cancelamento | `agent/control.js` + `POST /control` | Pausa/parada cooperativa; `AbortSignal` chega ao sandbox e ao provedor. |
| Estado de execução | `agent/executionState.js` + migração 009 | Etapas visíveis na UI. |
| Pipeline multimodelo | `agent/pipelineRuns.js` + migração 027 | Reserva fail-closed antes do stream; conflito 409; objetivo/opções/runId duráveis; retomada e stop escopados pelo dono. |

- **Testes:** `agent/checkpoint.test.js`, `agent/executionState.test.js`,
  `agent/runStateMachine.test.js`, `agent/runLog.test.js`, `agent.control.test.js`
  e a retomada após **interrupção real do processo** em
  `checkpoint.kill9.real.test.js` (F-14 fechado: processo A grava o checkpoint e
  morre; processo B reconstrói via `buildResumeMessages` contra PostgreSQL real).

---

## 13.1 Sub-agentes (`agent/subagents.js`)

Delegação em **tempo de execução**: o próprio agente principal decide, no meio do trabalho,
mandar uma subtarefa para um `runAgent` completo com ferramentas de verdade. Diferente do
Modo Equipe (`orchestrator.js`), onde os especialistas são escolhidos antes pela interface e
não executam ferramentas.

| Peça | Comportamento |
| --- | --- |
| Oferta da ferramenta | `shouldOfferSubagentTool` — desliga em turno social, modo gratuito, sem ferramentas, dentro de outro sub-agente e com `SUBAGENTS_ENABLED=false`. |
| Escolha do especialista | `especialista_id` com **`enum` dos ids reais** da conta (`listSubagentSpecialists`). Id inexistente devolve `SUBAGENT_SPECIALIST_NOT_FOUND` — não há fallback silencioso. Sem especialista, o filho usa o perfil do pai. |
| Autorização | `DelegationContext` congelado (ver `SECURITY.md` §8.1). Nada é recalculado a partir da subtarefa. |
| Contexto | Janela isolada: sem memória e sem histórico. O filho vê o prompt protegido, a subtarefa e o manifesto de uploads/documentos da conversa. |
| Paralelismo | `createSubagentLimiter` — semáforo com contador e fila FIFO. Lote **só** de delegações corre em paralelo; lote misto (`write_file` + delegação) volta a correr em série, na ordem pedida. |
| Cancelamento | `control.activeTools` é um `Set`: o Parar aborta todas as ferramentas em voo, não só a última registrada. |
| Custo | `usage` do filho soma na do pai; esforço limitado a `alto`; tetos `SUBAGENT_MAX_PER_RUN` (4, máx. 10) e `SUBAGENT_MAX_PARALLEL` (2, máx. 4). |
| Budget próprio | `buildSubagentBudget` cria janela independente do pai (12 etapas por padrão, teto duro 18); o parâmetro aceito pelo loop é `subagentRunBudget`. |
| O que volta ao pai | Só o JSON de `summarizeSubagentResult`: resultado, arquivos, especialista e modelo REAIS. O texto corrido do filho nunca entra na resposta do pai (`FORWARDED_EVENTS`). |

- **Testes:** `agent/subagents.test.js`, `agent.control.test.js`.
- **Lacuna:** sem teste de ponta a ponta do `loop.js` com delegação real simulada (F-13);
  sem orçamento próprio de tempo/tokens por delegação; arquivos de dois filhos paralelos
  ainda compartilham `outputs/` (a atribuição por filho pode se cruzar — o conjunto que o
  usuário recebe está correto porque o pai também faz o diff).

---

## 14. Integração GitHub (`connectors/github.js`)

- Token do usuário cifrado em `user_connectors` (AES-256-GCM, `crypto.js`).
- **O token nunca entra no sandbox**: clone/pull/push rodam no **backend**, com `spawn('git')`
  e `scrubSecrets()` em toda saída (stdout e stderr).
- Clone em `users/<dono>/<conversa>/repo/<owner>__<repo>` — escopado pelo dono (novo).
- `github_push` exige `commit_message` quando há mudanças não commitadas; PR é chamada
  explícita de API (`github_create_pr`) — o modelo não "declara" publicação sem retorno.
- Falha de TLS/credencial é marcada `recoverable:false` para o freio de falhas parar cedo
  (evita o loop de 7 min visto em produção).
- **Git remoto pelo sandbox é BLOQUEADO** (`execGuard.js → remoteGitSubcommand`): `clone`,
  `fetch`, `pull`, `push`, `ls-remote` e `remote add/set-url` recusam com a mensagem que
  aponta as ferramentas certas. Git **local** (`status`, `diff`, `add`, `commit`, `log`,
  `branch`, `checkout`, `config`, `stash`) continua liberado — é assim que o agente trabalha
  no clone. O reconhecimento é por posição de comando, então `git commit -m "corrige o fetch"`
  e `echo "git push" >> README.md` não são confundidos com execução remota.
- **Testes:** `connectors.github.test.js`, `agent/githubAccess.test.js`,
  `execGuard.remoteGit.test.js`, `hooks/useDevProjects.test.js`.
- **Lacuna:** não há teste de clone/commit/push com um servidor git local. Ver F-19.

### 14.1 Autorização de publicação — uma decisão só (`agent/githubAccess.js`)

O aplicativo distingue **duas coisas diferentes** que antes se confundiam:

```
autorização do usuário   ≠   disponibilidade técnica da ferramenta
```

O defeito corrigido: a liberação de `github_push`/`github_create_pr` dependia de uma condição
espalhada no `loop.js` cujo único sinal era uma regex aplicada ao texto **do turno atual**
(`explicitlyAuthorizesGitWrite`). O usuário autorizava numa mensagem, a tarefa seguia em
turnos seguintes (ou retomava de um checkpoint) e as ferramentas de escrita simplesmente não
estavam no inventário — e o agente respondia que "as ferramentas não estão habilitadas nesta
sessão", como se fosse um limite do produto.

Agora existe **um pré-voo** (`githubPreflight`) e o inventário sai dele
(`githubToolsForContext`). A mesma função responde ao painel do Modo Desenvolvedor
(`GET /api/connectors/github/preflight`) e monta a nota do prompt
(`githubPreflightNote`) — o que o modelo acredita ter, o que o executor tem e o que a
interface mostra vêm da mesma fonte, com teste de catraca (`githubAccess.test.js`).

Matriz aplicada (fail-closed em toda linha):

| GitHub conectado | Repositório vinculado | Modo gravável | Autorização válida | Resultado |
| --- | --- | --- | --- | --- |
| Não | — | — | — | Nenhuma ferramenta remota (`github_not_connected`) |
| Sim | Não | Sim | Sim | Só leitura: `github_clone`, `github_list_repos` (`repository_not_bound`) |
| Sim | Sim | Não (ask/plan/review) | Sim | Só leitura (`read_only_mode`) |
| Sim | Sim | Sim | Não | Só leitura + confirmação estruturada (`write_not_confirmed`) |
| Sim | Sim | Sim | Sim | `github_clone`, `github_push`, `github_create_pr` |

A autorização é **estruturada e escopada** — repositório, branch, branch base e ações
(`push`, `create_pr`) — e chega em `developer.permissions`:

```js
permissions: {
  githubWrite: true,
  githubWriteConfirmedAt: '2026-08-06T19:00:00.000Z',
  githubWriteScope: { repo: 'owner/repo', branch: 'feat/x', base: 'main', actions: ['push', 'create_pr'] }
}
```

Regras: vem de ação explícita do usuário (botão **Autorizar publicação** no painel, ou a
confirmação de um `ask_user` cujo escopo o **backend** carimba a partir do vínculo); é
re-validada no backend, que descarta campos e ações desconhecidas; não vale para outro
repositório, outra branch ou outra base; nenhum sub-agente publica; o frontend não amplia
nada; e o texto do modelo nunca concede permissão. Sobrevive a turnos seguintes e à retomada
porque viaja no payload `developer`, que o checkpoint já persiste. A regex do turno segue
existindo como caminho secundário, mas **escopada ao vínculo** — sem branch declarada não há
escopo, e sem escopo não há permissão.

Quando bloqueada, a interface mostra a **causa real** (`blockingReason` +
`blockingMessage`), nunca "a ferramenta não está habilitada".

Decisão registrada em
[`docs/decisions/0002-autorizacao-estruturada-de-publicacao-no-github.md`](decisions/0002-autorizacao-estruturada-de-publicacao-no-github.md).

---

## 15. Copiloto (Nino) e Companion

- O cabeçalho do Modo Desenvolvedor expõe os estados oficiais **Ativo**,
  **Silencioso** e **Desligado**. Eles são projeções das preferências persistidas
  existentes: silencioso remove animação, voz e proatividade; desligado desmonta
  o personagem e interrompe polling/monitoramento.
- `companion/monitor.js` observa o git da conversa por `execInActiveSandbox` — **observa sem
  materializar container** (a versão anterior criava um sandbox a cada ciclo de polling e
  podia derrubar o do modo dev).
- `companion/health.js` amostra memória/CPU; `incidents.js`, `errorDigest.js`, `bugAnalysis.js`,
  `suggestions.js`, `permissions.js` alimentam a Central de Diagnósticos.
- Chat do copiloto isolado do chat principal (migrações 017–019). O isolamento continua
  sendo o **padrão**; a migração 024 acrescenta a porta que só abre por fora: preferências
  (`copilot_prefs`), memória própria (`copilot_notes`) e a leitura AUTORIZADA das últimas
  mensagens da conversa principal, sempre registrada em `companion_audit`.
- `copilot/core.js` é puro (prompts, blocos de contexto/memória/base, `decideContextAccess`)
  e `copilot/knowledge.js` responde dúvidas sobre o próprio Studio com busca local — sem
  rede e sem gastar tokens para descobrir relevância. Ver `docs/COPILOT_PLAN.md` §9.

---

## 16. Frontend

```
main.jsx → AuthGate → App.jsx
  ├─ hooks/: useChat (SSE), useConversations, useAssistants, useTasks, useFileUploads,
  │          useDevProjects, useDocling, useCompanion, useCopilot, useCopilotChat,
  │          useSpeech, useComposerHeight, useSmartAutoScroll
  ├─ lógica pura (testável sem DOM): chatScroll.js (regras da rolagem),
  │          executionSessions.js (sessões de execução e pergunta pendente),
  │          executionSteps.js, sse.js, modelFilters.js, ...
  ├─ componentes de painel: SettingsHub, DeveloperPanel, MemoryPanel, ProviderPanel,
  │          MultiModelBoard/Picker, DoclingPanel, CopilotWorkspace, Companion, ...
  ├─ rodapé do chat: ChatJumpToBottom + ExecutionTerminalDock (chunk sob demanda) +
  │          compositor. As duas faixas publicam a própria altura em `--composer-h` e
  │          `--dock-h`; quem flutua no canto (Companion) soma as duas.
  └─ CSS: styles.css + v2.css + 8 arquivos temáticos (auth, camera, companion,
          copilot, docling, landing, nino, design)
```

**A coluna do chat é limitada pela janela.** `.app` é um grid com `height:100vh` e
`grid-template-rows: minmax(0, 1fr)`; `.chat` tem `min-height: 0; overflow: hidden`. Sem
esse par, a linha do grid era de tamanho automático: numa conversa longa ela crescia com o
conteúdo, `.messages` (flex:1, overflow:auto) nunca precisava rolar — a **página** rolava —
e o compositor saía da tela. O sintoma ficava escondido pela rolagem antiga
(`scrollIntoView`, que rola qualquer ancestral); rolando o contêiner, o teste de navegador
mediu `scrollHeight - clientHeight === 0` em `.messages` com nove parágrafos passando do
rodapé. `.messages` é o **único** elemento que rola no chat.

**Terminal de execução (`components/ExecutionTerminalDock.jsx`).** Filho normal do `.chat`,
entre `.messages` e o compositor — nunca `position: fixed` sobre o conteúdo. Três estados
(`collapsed` 48 px / `expanded` / `maximized` até 70 vh no desktop e 55 vh no celular),
persistidos em `fred_execution_dock_v1_state` e `fred_execution_dock_v1_height`. Alça
superior com Pointer Events (mouse, caneta e toque) **e alternativa por teclado**
(setas, `Home`/`End`). Reaproveita o que já existia: `TOOL_META`/`CAT_META`/`describe`/
`statusIcon`/`ResultView` de `ExecutionSession.jsx` e `groupExecutionSteps` de
`executionSteps.js`; as sessões vêm de `executionSessions.js` (fonte única, também lida pela
linha compacta do histórico). O relógio bate **dentro** do terminal — antes o chat inteiro
re-renderizava (e reparseava markdown) uma vez por segundo. A janela em tela cheia
(`ExecutionWorkspace`) continua disponível como visualização secundária.
**Limite conhecido:** as etapas de ferramenta não são persistidas no banco (só o resumo, em
`execution_meta`), então reabrir uma conversa antiga não reconstrói o terminal — mesmo limite
que o cartão de execução sempre teve.

**Rolagem do chat (Smart Auto-scroll).** As regras vivem em `chatScroll.js`, puras e
testadas (`chatScroll.test.js`); `hooks/useSmartAutoScroll.js` só as liga ao contêiner
`.messages`. Quatro estados separados: `isNearBottom` (mede o DOM), `isFollowing` e
`userPausedFollowing` (refs — lidos a cada delta, e um render atrasado é exatamente o que
fazia o chat brigar com o usuário) e `hasNewContentBelow` (acende o botão). Regras: roda
para cima, `ArrowUp`/`PageUp`/`Home` e gesto de toque pausam **na hora**; voltar perto do
fim (≤ 80 px) religa; durante o streaming o comportamento é sempre `'auto'`
(`scrollIntoView({behavior:'smooth'})` reiniciado a cada token era o defeito); o clique
explícito usa `'smooth'`, salvo `prefers-reduced-motion`. O efeito depende de
`chatContentKey(messages)` — derivada do que cresceu —, não da identidade do array nem do
tique do relógio.

Dois detalhes que só o teste de navegador expôs, e que a implementação precisa manter:
o `requestAnimationFrame` que executa a rolagem **reavalia a pausa antes de rolar** (a
decisão é tomada no efeito, e o usuário pode girar a roda nos milissegundos até o quadro —
sem a reavaliação ele levava um "puxão" logo depois de subir); e o retorno do
acompanhamento exige uma rolagem **para baixo** até o fim (`shouldResumeFollowing`), porque
um gesto para cima *começa* dentro dos 80 px finais e, com a regra ingênua "perto do fim
religa", o primeiro quadro do próprio gesto desligava a pausa que o usuário acabou de pedir.

**Medições de 2026-07-25** (não corrigidas nesta auditoria):
- `App.jsx`: 62 `useState`, 13 `useEffect`, 12 `useRef` num único componente.
- Bundle: **932 KB** de JS num **único chunk** (287 KB gzip) + 183 KB de CSS.
  (Medição de 2026-07-25. Em 2026-08-06: entrada 890 KB, total 1.064 KB, CSS 204 KB —
  os três com catraca em `frontend/scripts/bundleBudget.mjs`. O teto de CSS é de
  TAMANHO e não substitui a catraca do `cssInventory.mjs`, que trava a contagem de
  regras mortas: folha nova de 40 KB, toda em uso, passa lá e para aqui.)
  Sem code splitting, sem `React.lazy`.
- Sem virtualização de listas; Markdown reparseado durante o streaming.
- **Catraca no CI:** teto de 1.000 KB — impede crescimento silencioso enquanto a
  decomposição não é feita. Ver F-20 e F-21.

**CSS inventariado (Frente 11 — F-21, 2026-08-06).** Os arquivos em
`frontend/src/*.css` são varridos por `frontend/scripts/cssInventory.mjs`
(plugado em `npm run check`). O detector varre JSX/JS/HTML por uso literal,
template strings, classNames() e concatenação; uma classe morta é REMOVÍVEL
quando não aparece em código nem como ancestral de classe viva. A catraca
fala: o número de regras mortas removíveis NÃO pode subir em relação ao
snapshot em `frontend/scripts/cssInventory.snapshot.json` (lido em todo
`npm run check`). Artefato gerado: `frontend/dist/cssInventory.json`.

Estado atual (2026-08-06): 10 arquivos CSS, 2.117 regras, 226.903 bytes
brutos — 3 removíveis, 123 mistas (mortas combinadas com vivas — não
tocadas), 1.963 vivas. Bundle final minificado: **186,96 KB** (vs. 206,08 KB
antes da poda).

---

## 17. Persistência (PostgreSQL, 20 migrações)

Runner em `src/migrate.js`: ordem alfabética, `pg_advisory_lock` (duas instâncias subindo
juntas não corrompem `schema_migrations`), uma transação por arquivo.

| Faixa | Conteúdo |
| --- | --- |
| 001 | núcleo (conversations, messages, files, assistants, templates, memory, usage, tasks, schedules, clients) |
| 002 | Better Auth (user, session, account, verification) |
| 003 | multi-tenant (`user_id` em tudo) |
| 004–005 | conectores, LGPD (consentimento) |
| 006–009 | multimodelo, checkpoints, modo gratuito, estado de execução |
| 010–011 | permissões de ferramenta por assistente |
| 012–014 | múltiplos provedores, inteligência e histórico do catálogo |
| 015–019 | Companion e copiloto (eventos, chat, documentos) |
| **020** | **`user_roles` + `admin_audit`** (autorização administrativa persistida) |
| 021 | memória por projeto (`dev_projects`, `project_id` nas conversas e na memória) |
| 022–023 | Modo Design (projetos, versões e ajustes) |
| 024 | copiloto: preferências, memória própria e contexto autorizado do chat principal |

Verificado no CI por `backend/scripts/check-migrations.mjs`: banco vazio → 24 migrações →
reexecução no-op → 30 tabelas essenciais → escrita/leitura/cascade.

---

## 18. Desempenho — linha de base medida

| Métrica | Valor em 2026-07-25 | Orçamento adotado |
| --- | --- | --- |
| JS na primeira pintura | 909 KB em 2026-08-06 (entrada + `modulepreload`) | ≤ 920 KB (catraca) |
| JS total emitido | 987 KB em 2026-08-06, 9 chunks | ≤ 1.100 KB (alarme de dependência) |
| CSS | 183 KB (31 KB gzip) | sem teto ainda |
| Suíte backend | ~5 s (495 casos) | ≤ 60 s |
| Suíte frontend | ~0,3 s (34 casos) | ≤ 30 s |
| Migrações em banco vazio | < 2 s | ≤ 30 s |
| Sandboxes simultâneos por usuário | 2 (`MAX_SANDBOXES_PER_USER`) | — |
| Runs simultâneos por usuário | 5 (`MAX_ACTIVE_RUNS_PER_USER`) | — |
| Uploads simultâneos por usuário | 2 (`UPLOAD_MAX_CONCURRENT_PER_USER`) | — |
| RAM por requisição de upload | ~0 (streaming) — era até ~1 GB | — |

**Por que dois tetos, desde 2026-08-06.** Até então o CI somava todo o JS contra
um teto único. Isso funcionava com um chunk só, mas passou a reprovar exatamente
o trabalho de code splitting que a catraca dizia estar esperando: cada
`React.lazy` novo tira bytes da primeira pintura e ACRESCENTA alguns KB ao total
(cada chunk tem seu invólucro). Agora a **entrada** — o script inicial mais o que
o HTML manda pré-carregar — é o número que o usuário sente e que o splitting deve
baixar; o **total** não encolhe com splitting e serve de alarme para dependência
nova entrando de carona. A regra vive em `frontend/scripts/bundleBudget.mjs` e
roda no `npm run check`, não só no CI: portão que só existe no CI é descoberto
tarde demais.

Não medidos nesta auditoria: tempo de carregamento inicial no navegador, tempo para abrir
uma conversa longa, consultas lentas do Postgres, RAM do backend sob carga. Ver F-22.

---

## 19. Kits de documento (`sandbox/kits.py`, `docpro.py`, `xlspro.py`, `pdfpro.py`)

Os kits são copiados para dentro da imagem do sandbox (`sandbox/Dockerfile`) e
importados pelo modelo em `run_python`: `from docpro import Relatorio, Sobrio`
(Word), `from xlspro import Planilha` (Excel), `from pdfpro import RelatorioPDF`
(PDF) e `from kits import fmt` (formatação pt-BR). A seção DOCUMENTOS
PROFISSIONAIS do prompt base (`backend/prompts/docpro/atual.txt`, versionada em
`agent/promptRegistry.js` e carregada por `agent/systemPromptV4.js` quando
`run_python` está na chamada — ver §12.1) **proíbe** diagramar por fora deles, e
`backend/src/promptKits.test.js` trava essa seção contra a API real — todo
`objeto.metodo(` citado tem de existir em `sandbox/*.py`.

### 19.1 `kits.py` — a base comum

Antes da v2, a paleta, a escala tipográfica, a limpeza de texto, a detecção de
placeholder e a formatação de número viviam **triplicadas** e divergiam: um
"R$ 1,89 mi" saía do Word ao lado de um "R$ 1.887.900,00" do Excel no mesmo
pacote de entrega. `kits.py` é a fonte única de:

| O quê | Para quê |
| --- | --- |
| `PALETA` / `ESCALA` | identidade "Tinta & Latão" e a escala tipográfica fechada, únicas para os três formatos |
| `paleta_para(cor_marca)` | `cor_marca="RRGGBB"` substitui `tinta` e **recalcula** `apoio`, para o acento não ficar verde ao lado da cor do cliente |
| `fmt` | moeda, percentual, milhar, data, valor por extenso, CNPJ, CPF — em pt-BR, com arredondamento meio-para-cima (`round()` do Python usa banker's rounding e devolveria centavo a menos) |
| `tipos_de_coluna` / `linha_de_total` | tipagem das colunas por NOME e o TOTAL calculado pelo kit |
| `normaliza_linhas` | linha fora do cabeçalho é completada **e acusada** |
| `escala_kpi` / `linhas_de_kpi` / `eixo_milhar` | regras de leitura: corpo do KPI pelo comprimento do valor, 5–6 KPIs em duas fileiras, eixo em milhar acima de 100 mil |
| `PLACEHOLDER`, `achados_de_placeholder`, `achados_de_paginacao` | auditoria compartilhada |
| `grafico_*_png` | gráficos matplotlib com a paleta e as regras acima |

Ele não importa python-docx, openpyxl nem reportlab — é o que permite testá-lo
sozinho (`sandbox/kits_test.py`).

**Números pertencem ao kit.** O modelo passa `int`/`float`/`Decimal`/`date`; a
coluna (`moeda=`, `pct=`, `milhar=`, `data=`) decide o formato, o alinhamento e
o parêntese vermelho do negativo. String com "R$" vira texto no Excel — nenhuma
soma, gráfico ou tabela dinâmica funciona em cima dela, e a auditoria reprova.

### 19.2 Presets: o modelo escolhe o registro, não os blocos

`PRESETS` (mesmo dicionário no `docpro` e no `pdfpro`) traduz o tipo de
documento em decisões de diagramação:

| preset | capa | sumário | numeração | corpo | fechamento |
| --- | --- | --- | --- | --- | --- |
| `gerencial` | faixa de tinta | automático com 4+ seções | SEÇÃO 01 | esquerda | faixa (ou `estilo="pagina"`) |
| `parecer` | simples | automático com 4+ seções | 1., 1.1 | justificado | faixa |
| `proposta` | faixa de tinta | nunca | sem | esquerda | faixa |
| `carta` | nenhuma | nunca | sem | justificado | assinatura |
| `sobrio` (PDF; no Word é a classe `Sobrio`) | nenhuma | nunca | rígida no texto | justificado | assinaturas + testemunhas |

Capa e sumário são montados no `salvar()`, quando já se sabe quantas seções o
documento tem, e movidos para a frente do corpo. `capa=False`, `sumario=False` e
`contracapa="faixa"|"pagina"|False` sobrescrevem o preset caso a caso.

### 19.3 O contrato de grade

O defeito que motivou a reescrita de 2026-07-26 não era de conteúdo: era o
texto começar em coordenadas diferentes conforme o bloco. No PDF entregue
havia **seis arestas esquerdas na mesma página** (54,7 / 56,7 / 62,7 / 67,7 /
70,7 / 72,7 pt). Os kits passaram a ter uma grade única:

| Aresta | Onde | PDF | Word |
| --- | --- | --- | --- |
| Caixa | fundo de callout, faixa de cabeçalho de tabela, régua do rodapé | `X_CAIXA` = margem | margem da seção |
| Texto | **todo** texto: corpo, título, 1ª coluna da tabela, marcador de lista, rodapé | `X_TEXTO` = `X_CAIXA + RECUO` | `RECUO_PT` (recuo de parágrafo / `tcMar`) |

`RECUO` (PDF) e `RECUO_PT` (Word) valem 10 pt e são a única distância do
sistema. A barra de destaque à esquerda de títulos e callouts é uma **coluna**
da tabela, não um `LINEBEFORE`: assim ela fica inteira dentro da caixa e não
empurra o texto nem invade a margem. Nenhum bloco aceita recuo próprio ou
largura literal em centímetros.

### 19.4 Tipografia: a fonte que o cliente vê é a que foi conferida

A v1 pedia "Source Serif 4"/"Source Sans 3" **pelo nome** no `.docx`. Essas
fontes não existem no Windows nem no Mac do cliente: o Word substituía, as
linhas quebravam em outro lugar e a conferência — feita no PDF gêmeo gerado no
sandbox — passava a valer para um documento diferente do que ele abria.

O padrão da v2 é **Cambria** (títulos e números de destaque) sobre **Calibri**
(corpo e tabelas): existem em todo Office desde 2007 e, no Linux do sandbox, o
LibreOffice as substitui por **Caladea/Carlito**, que são metricamente
idênticas. O PDF gêmeo passa a quebrar a linha no mesmo lugar que o Word do
cliente. O `pdfpro` embute Caladea/Carlito (`tipografia="office"`, padrão) e
mantém Source como `tipografia="editorial"`, que só faz sentido em PDF — lá a
fonte vai embutida no arquivo. As duas famílias são registradas no import
(`pdfpro.TIPOGRAFIAS`); DejaVu e Liberation fecham a lista de fallback, e a
base-14 é o último recurso.

Demais garantias do PDF (mantidas da v1):

- **Saneamento de glifo.** `texto_seguro()` remove caracteres de controle e
  troca por equivalentes o que a fonte não desenha. A checagem pergunta ao
  próprio reportlab (`unicode2T1`), porque a resposta intuitiva está errada:
  `"•".encode("cp1252")` funciona, mas o reportlab codifica o bullet em
  Helvetica como `\x7f` (DEL) — que o leitor mostra como quadrado ou nada. Era
  a origem dos **320 marcadores quebrados** do relatório entregue.
- **Marcação.** Todo texto é escapado preservando as tags que o `Paragraph`
  entende (`<b>`, `<i>`, `<br/>`…). Sem isso um "Silva & Cia" ou um "a < b"
  vindo de dado do usuário derruba a geração.
- **Rodapé.** "Página X de Y" sai por `drawRightString`. Com `drawString` a
  borda direita anda ao passar de 9 para 10 páginas.

### 19.5 Regras de paginação (código, não instrução ao modelo)

| Regra | Como | Onde |
| --- | --- | --- |
| Tabela de até 15 linhas é indivisível | `cantSplit` em toda linha + `keepNext` em todas menos a última | `docpro._paginacao_tabela`, `pdfpro.tabela` (`KeepTogether`) |
| Acima de 15 linhas, o TOTAL nunca abre a página sozinho | `keepNext` na penúltima linha, cabeçalho repetido (`tblHeader`/`repeatRows`) | idem |
| "Fonte:" cola na tabela | `keepNext` na última linha | idem |
| Fecho + assinaturas + testemunhas são indivisíveis **e colam no conteúdo anterior** | tabela externa de uma coluna com `cantSplit` (Word); `KeepTogether` que puxa o último bloco, limitado a 35% da altura útil (PDF) | `assinaturas()` |
| Sumário só ganha página própria acima de 10 entradas | decidido em `_finalizar_estrutura` | ambos |
| Lista curta, callout, citação e cronograma curto são indivisíveis | `keepNext`/`cantSplit` | ambos |
| Fechamento em faixa fica no PÉ da última página | tabela flutuante `vertAnchor="margin" tblpYSpec="bottom"` (Word); `KeepTogether` no fim da story (PDF) | `contracapa()` |

### 19.6 Sumário com as páginas REAIS (segundo passo pelo PDF)

Na v1 o modelo informava a página (`sumario([("Sumário executivo", 3)])`) — e o
sumário saiu errado no próprio documento da revisão. Na v2, `docpro.salvar()`:

1. grava o `.docx` e converte para PDF com o LibreOffice;
2. lê o texto de cada página com o `pypdf`, **ignorando as linhas do próprio
   sumário** (senão cada título é achado na página do índice, que lista todos, e
   o sumário passa a apontar para si mesmo);
3. reescreve o número de cada entrada e converte de novo.

`sumario(entradas)` continua aceito, com `warnings.warn` — quem forçar o número
sabe que ele não é conferido. No PDF o mesmo papel é do `multiBuild` do
reportlab, e os títulos também viram **marcadores (outline)** do arquivo: eles
são anotados durante o build e registrados na reemissão de páginas do
`_CanvasNumerado`, porque um `bookmarkPage` feito durante o build apontaria
todos para a página 1.

### 19.7 Auditoria: `salvar()` confere o arquivo pronto

Os **três** kits devolvem `{"ok", "paginas"/"abas", "achados"}` e levantam
`KitError` (subclasse de `ValueError`) quando há achado grave. O modelo lê o
retorno e corrige o script — em vez de "lembrar de conferir".

| Código | Gravidade | Kit | O que pega |
| --- | --- | --- | --- |
| `placeholder` | grave | os três | "DD/MM/AAAA", "Seu Nome", "[cliente]", "Cidade/Estado"… no arquivo PRONTO, inclusive nas tabelas aninhadas do bloco de assinatura |
| `linha-fora-do-cabecalho` | grave | os três | linha com número de valores diferente do cabeçalho |
| `sumario-divergente` | grave | docpro | o índice aponta uma página e a seção está em outra |
| `pagina-vazia` | grave | docpro, pdfpro | página com menos de 40 caracteres (a capa e a contracapa de página inteira são isentas) |
| `assinatura-orfa` | grave | docpro, pdfpro | página em que, tirado o material de fechamento, não sobra nada |
| `coluna-numerica-com-texto` | grave | xlspro | coluna declarada `moeda=`/`pct=` que recebeu string — a soma dá zero em silêncio |
| `formula-com-erro` | grave | xlspro | `#REF!`, `#DIV/0!`… depois do recálculo com LibreOffice |
| `grafico-invalido` | grave | xlspro | aba inexistente, intervalo invertido, série vazia (reaproveita `validar_artefato.check_charts`) |
| `texto-fora-da-grade`, `glifo-invalido`, `sem-tounicode`, `pagina-irregular` | grave | pdfpro | os da v1, sobre o binário do PDF |
| `kpi-quebrado` | aviso | docpro, pdfpro | o valor do cartão não aparece inteiro em nenhuma linha do PDF |
| `celula-de-valor-vazia` | aviso | docpro | coluna de valor sem conteúdo numa linha de dados |
| `impressao-sem-ajuste`, `notas-fora-do-lugar` | aviso | xlspro | aba fora do "ajustar à largura"; aba de notas que não é a última |
| `sem-pdf-gemeo`, `pdf-ilegivel`, `formula-nao-recalculada` | aviso | conforme | o ambiente não tinha LibreOffice/pypdf: a conferência foi PARCIAL e diz isso |

O auditor do PDF descomprime os streams de conteúdo **das páginas** (não das
fontes embutidas), refaz a pilha de matrizes `q`/`Q`/`cm` e acompanha `Tm`/`Td`
para saber onde cada trecho de texto realmente começa. Aplicado ao PDF que
motivou a reescrita, devolve 203 trechos fora da grade, 342 glifos trocados e
nenhuma fonte embutida.

### 19.8 Excel: a planilha entregue é a planilha impressa

O `xlspro` v2 fechou o que faltava para a planilha sair pronta e não só bonita:
`filtro=True` no cabeçalho, `total="formula"` para quem quer a planilha viva,
aba **Notas** (fonte, premissas, responsável e data) por último, e
`imprimir()` aplicado a todas as abas no `salvar()` — `fitToWidth=1` com
`fitToPage` no `sheetPr` (sem ele o Excel ignora o ajuste), paisagem acima de 6
colunas, cabeçalho repetido e "Página &P de &N" no rodapé. A área de impressão
do painel inclui os **gráficos**: eles flutuam sobre a grade e não entram em
`max_row`, então uma área calculada só pelas células imprimia o painel sem eles.

### 19.9 Robustez comum e testes

Caractere de controle é ilegal em XML 1.0: no `.docx` produz arquivo que o Word
recusa ("conteúdo ilegível") e no `.xlsx` o openpyxl levanta
`IllegalCharacterError`. Os kits limpam o texto antes de escrever, e o nome de
aba do Excel é saneado (`: \ / ? * [ ]`, 31 caracteres). Identificadores
(CNPJ, CPF, NIRE, CEP) recebem **hífen não separável**, para o Word não partir
um NIRE ao fim da linha numa folha que vai à Junta Comercial.

Testes: `sandbox/*_test.py`, rodados na CI (`python -m unittest discover -s
sandbox`) com matplotlib, LibreOffice e as fontes Carlito/Caladea instalados —
sem eles os testes de gráfico e de PDF gêmeo se auto-pulariam e a cobertura
sumiria em silêncio. `sandbox/exemplos/gerar_exemplos.py` regenera os quatro
documentos da revisão de design (relatório, proposta, ata e planilha) para
conferência em tela; os binários **não** são versionados, porque envelheceriam
documentando uma versão do kit que não existe mais.

**Deixado de fora da v2, de propósito:** a contracapa de página inteira não é
escolhida sozinha pelo número de páginas (o padrão é a faixa; `estilo="pagina"`
é explícito) — decidir isso exigiria um terceiro passo de conversão só para uma
escolha estética.
