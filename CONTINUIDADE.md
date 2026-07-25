# CONTINUIDADE — Estado do projeto Frederico AI Studio

## 🚀 Botões de GitHub no modo desenvolvedor: "Enviar para o GitHub" e "Continuar no repositório" (1 clique) (2026-07-25 — PR #129, branch `claude/dev-github-buttons`)


**Motivação:** enviar o trabalho de uma conversa de dev ao GitHub dependia de
duas condições nada óbvias — estar num MODO DE ESCRITA (build/fix/auto) E a
mensagem AUTORIZAR o push com palavras soltas (`explicitlyAuthorizesGitWrite`). Se
faltasse alguma, as ferramentas `github_push`/`github_create_pr` nem apareciam e o
modelo caía no `git push` pelo bash do sandbox (que falha de propósito — sem
credencial lá), às vezes sugerindo ao usuário rodar `git push` num caminho que só
existe DENTRO do sandbox. Resultado: commit pronto no workspace e nenhum jeito
óbvio de subir.


**Correção — ação determinística por botão, sem IA:**
- Backend `routes/conversations.js`: dois endpoints escopados por conversa (posse
  checada) — `POST /conversations/:id/github/clone` e `.../github/push` — que
  chamam `runGithubTool('github_clone'|'github_push', …)` DIRETO no backend, com o
  token do usuário. Sem passar pelo modelo, sem depender de modo/frase, sem gastar
  tokens. O push devolve `needsCommitMessage` quando há mudanças pendentes, para o
  front pedir a mensagem e repetir.
- Frontend `App.jsx`: na barra do modo desenvolvedor, quando há repositório
  vinculado, dois botões — **"Continuar no repositório"** (clone/atualiza nesta
  conversa) e **"Enviar para o GitHub"** (commit se preciso + push). Estado de
  carregando por botão; ao faltar mensagem de commit, pede via `askPrompt` e
  repete. `styles.css`: estilo dos botões.


**Efeito:** o caso clássico "o commit já está pronto no workspace e só falta o
push" vira **1 clique**. Combina com o PR #127 (que restaura o vínculo do repo ao
reabrir a conversa): reabre → clica em "Enviar para o GitHub" → sobe.


## 🔑 ENCRYPTION_KEY automática (self-hosted sem terminal) + correção do repositório sumindo no modo dev (2026-07-24 — PRs #127 e #128)


**Correção do modo dev (PR #127 — branch `claude/dev-mode-repo-persist`):** ao
reabrir uma conversa de projeto, o vínculo com o repositório GitHub (repo/branch),
o modo e as regras eram PERDIDOS — `openConversation` zerava `developerSession` e
nada o reconstruía. Sem `developer.github`, o backend não recebia o vínculo e o
agente dizia "não encontro o repositório", travando o desenvolvimento (o clone
seguia no workspace da conversa em disco; o agente só deixava de saber que
existia). Agora a sessão é RECONSTRUÍDA a partir do projeto dono (persistido no
navegador com seus `conversationIds`) — mesmo padrão que já restaurava o modelo da
conversa. Novo helper puro `developerSessionForConversation` (com teste), resolver
via ref em `useConversations`, e volta ao workspace de desenvolvimento.


**ENCRYPTION_KEY automática (PR #128 — branch `claude/auto-encryption-key`):**
antes, a `ENCRYPTION_KEY` (que cifra token do GitHub + chaves de API por usuário)
era obrigatória no `.env` e, se mudasse entre deploys, os segredos ficavam
ilegíveis ("perdi o acesso ao GitHub"). Complicado demais para o usuário comum que
apenas instala o app. Agora `backend/src/crypto.js` resolve a chave por
prioridade: (1) env `ENCRYPTION_KEY` se definida (SaaS/secret manager); (2) senão,
o arquivo `DATA_DIR/encryption.key`; (3) senão, gera uma e a PERSISTE nesse arquivo
(0600) — no MESMO volume do banco. Resultado: `docker compose up` funciona de
primeira, sem `openssl`/terminal, e a chave fica estável entre reinícios (lida
sempre do arquivo, nunca regenerada à toa; arquivo inválido lança em vez de
sobrescrever). `.env.example`/README documentam que a env é opcional e tem
prioridade. Decisão pura `chooseKeyHex` testada + teste e2e da geração/persistência.


## 🤖 Copiloto com espaço próprio: Chat + Documentos isolados, config nas Configurações e balão proativo de revisão (2026-07-24 — PR #126, branch `claude/copilot-refactor`)


**Contexto:** o "copiloto" estava espalhado em três peças diferentes e com papéis
misturados: o **avatar flutuante** (Companion) cuja engrenagem abria um modal de
configuração do personagem; um **painel técnico** separado (Diagnósticos/Saúde/
Permissões); e o **PromptCoach**, que oferecia revisão de prompt durante a
digitação no chat principal. Além disso, o avatar não tinha cérebro próprio — o
envio rápido dele delegava ao `sendMessage` do chat principal, sem contexto,
memória nem armazenamento próprios. A reorganização (R1–R4) dá ao copiloto um
**espaço próprio e isolado**.


**Mudanças:**
- **R1 — Configuração sai do avatar → Configurações.** Removido o modal
  `CompanionSettings` e o painel rápido do avatar. Nova tela **Configurações ›
  Agente › "Copiloto — Personalização"** (`CompanionConfig.jsx`): personagem,
  persona, modelo, modo, proatividade e animação. O painel técnico continua em
  **"Copiloto — Diagnósticos"**. Clicar no avatar passa a abrir **apenas** o
  painel do copiloto (abas Chat e Documentos).
- **R2 — Balão proativo de revisão de escrita.** O avatar observa o rascunho do
  chat principal e, após uma pausa (`PAUSA_MS=3000`) + tamanho mínimo
  (`MIN_CHARS` por sensibilidade), oferece revisar (**Sim / Agora não**). Aceitar
  chama `/api/copilot/revise` e mostra um **cartão clicável** que substitui o
  texto pelo revisado. Frases sorteadas sem repetir, Esc/clique-fora fecham,
  cooldown por rascunho. Removida a faixa do PromptCoach do compositor (não há
  mais oferta de prompt durante a digitação); as 10 ações de prompt foram
  preservadas **dentro do chat do copiloto**.
- **R3 — Chat com contexto 100% isolado.** Novas tabelas
  `copilot_conversations`/`copilot_messages` (migration `018`), separadas de
  `conversations`/`messages`. Backend `copilot/core.js` (puro) + `copilot/store.js`
  + rotas `/api/copilot/chat` (GET/POST/DELETE) com persona dedicada. O isolamento
  é garantido em `buildChatMessages` (só `system` + histórico do **próprio**
  copiloto — nunca a conversa principal nem a memória dela).
- **R4 — Caixa de documentos própria.** Nova tabela `copilot_documents`
  (migration `019`), separada dos anexos das conversas (`files`). Rotas de
  listar/ver/baixar/excluir e criação automática dos textos revisados pelo balão.
  Aba Documentos com estados vazio/carregando/lista.


**Decisões de engenharia:**
- O copiloto usa o **mesmo provedor de IA do usuário** (`getUserProvider`), com o
  modelo definido na config do Companion (`settings.model`; vazio = provedor
  padrão). Sem chave configurada, o chat/revisão respondem com mensagem amigável
  em vez de erro.
- O chat mantém **uma thread contínua por usuário** (MVP), com botão de limpar
  histórico. Documentos guardam o conteúdo textual inline na tabela.
- O painel técnico (Diagnósticos/Saúde/Permissões) foi **mantido** — o prompt não
  pedia removê-lo e ele já vivia nas Configurações, não no avatar.


**Arquivos:**
- Backend: `migrations/018_copilot_chat.sql`, `migrations/019_copilot_documents.sql`,
  `src/copilot/core.js`, `src/copilot/core.test.js`, `src/copilot/store.js`,
  `src/routes/copilot.js`, `src/routes/companion.js` (novos campos
  `proactiveWriting`/`writingSensitivity`), `src/server.js` (monta o router).
- Frontend: `Companion.jsx` (reescrito — avatar abre o painel + balão proativo),
  `components/CopilotWorkspace.jsx` (abas Chat/Documentos), `components/CompanionConfig.jsx`,
  `hooks/useCopilotChat.js`, `hooks/useCompanion.js`, `components/SettingsHub.jsx`,
  `App.jsx`, `companion.css`. Removido `components/PromptCoach.jsx` (órfão).


**Validação:** Postgres real — migrations `001`–`019` aplicam limpas; E2E do
`store` contra o banco confirma **isolamento por usuário** (um usuário não lê/apaga
dados de outro) e o CRUD de chat e documentos; testes unitários do núcleo
(`core.test.js`, incluindo o invariante de isolamento das mensagens) e
`sanitizeSettings` verdes; build do frontend OK. Não exercitado ponta a ponta: a
chamada real ao provedor de IA (sem chave no ambiente) — as peças em volta estão
testadas.


## 🎚️ Roteamento OpenRouter: qualidade × resiliência + transparência de troca de modelo (2026-07-24 — PR #124, branch `claude/open-router-provider-lock-6iywu6`)


**Contexto:** investigação a partir de uma reclamação de que um app agêntico via
OpenRouter parecia **trocar de modelo silenciosamente** (DeepSeek V4 Pro → V3)
durante a execução. A análise do código + dos dados reais da API pública do
OpenRouter (`/models/<slug>/endpoints`) mostrou **dois fenômenos distintos**:
(1) o OpenRouter balanceia cada requisição entre vários provedores do MESMO
modelo, e esses provedores rodam o modelo em **precisões diferentes**
(quantização) — as faixas agressivas (`int4/int8/fp4/fp6`) degradam a qualidade;
(2) a "troca de modelo" relatada **não era downgrade da tarefa**: a conversa
rodou inteira no modelo escolhido, e as chamadas pequenas a um modelo mais barato
eram a **extração de memória em segundo plano** (`indexer.js` / `EXTRACT_MODEL`,
default `deepseek/deepseek-chat`), cobrada ao preço correto e apenas misturada no
Activity do OpenRouter.


**Correção:**
- **`agent/provider.js` — `openRouterRouting`:** meio-termo qualidade × resiliência.
  `allow_fallbacks: true` mantém a resiliência (reroteia só entre provedores que
  ainda atendem o filtro de qualidade, em vez de falhar) e `quantizations`
  (padrão `fp8,fp16,bf16,fp32,unknown`) exclui só a compressão agressiva sem
  prender a um provedor único. `unknown` fica na lista porque modelos reais em uso
  (ex.: `gpt-4o`) só têm provedores `unknown` e ficariam sem endpoint se fossem
  excluídos. Ajustável por ambiente: `OPENROUTER_QUANTIZATIONS` (inclui `off` e a
  precisão cheia `bf16,fp16,fp32`) e `OPENROUTER_ALLOW_FALLBACKS=0` (trava no
  provedor preferido — erro em vez de troca de provedor).
- **`memory/indexer.js`:** as chamadas de extração de memória passam a herdar o
  mesmo `openRouterRouting` das respostas principais — o filtro de qualidade
  (evita `fp4` etc.) vale também no segundo plano.
- **`agent/loop.js`:** quando um failover troca o modelo no meio da execução, a
  troca é registrada **na própria resposta salva** (antes só havia um status
  efêmero que sumia — por isso "só se notava depois"). Compara o modelo final com
  o inicial (`startedModel`) e anexa uma nota explicando qual reserva concluiu e
  como desativar a troca automática (`MODEL_FALLBACKS`).


**Decisão de engenharia:** a extração de memória **continua** num modelo barato
(configurável via `EXTRACT_MODEL`), não no modelo premium da conversa — ela roda a
cada resposta e usar um modelo caro multiplicaria o custo sem benefício visível;
agora apenas com a mesma proteção de qualidade das respostas principais.


**Arquivos:**
- `backend/src/agent/provider.js` — filtro de quantização + `allow_fallbacks`
- `backend/src/agent/provider.promptCache.test.js` — testes do roteamento (padrão,
  modo estrito, trava de provedor, filtro desligado)
- `backend/src/memory/indexer.js` — roteamento de qualidade nas 2 chamadas de extração
- `backend/src/agent/loop.js` — nota persistente de troca de modelo
- `.env.example`, `README.md` — `OPENROUTER_QUANTIZATIONS` e `OPENROUTER_ALLOW_FALLBACKS`


**Validação:** suíte completa do backend → 434 pass / 2 skipped / 0 falhas;
`node --check` nos arquivos alterados + verificação de import (sem ciclo).


## 🎯 Filtro de relevância por domínio na recuperação de contexto — Context Builder 3.0 (2026-07-24 — PR #120, merge `31303fd`)


**Problema:** a recuperação de contexto (memórias + conversas antigas) injetava
material irrelevante nos pedidos. Ex.: memórias de domínio **contábil** entravam
num pedido de **desenvolvimento de software**, poluindo o contexto e gastando
tokens à toa. Causas: injeção incondicional de memórias de perfil/pinned,
limiares semânticos baixos demais, peso excessivo de recência e preenchimento
por cota (encher o orçamento mesmo sem relevância real).


**Correção:** novo módulo **puro** `backend/src/memory/relevanceScorer.js` (sem
I/O nem DB) que pontua cada memória e conversa antiga por **domínio**
(software / contábil / financeiro / geral, com penalidade para domínio
incompatível), **intenção**, **projeto**, **entidades** do prompt e
**similaridade semântica**. Limiares separados (memória `0.25`, conversa `0.30`),
validação de relevância, deduplicação e extração de trecho relevante. O
`contextBuilder.js` (Context Builder 3.0) passa a filtrar o material recuperado
por essas pontuações antes de montar o contexto.


**Arquivos:**
- `backend/src/memory/relevanceScorer.js` — novo, módulo puro
- `backend/src/memory/relevanceScorer.test.js` — novo, 27 testes
- `backend/src/memory/contextBuilder.js` — integra o scorer (v3.0)
- `frontend/src/components/MemoryTrace.jsx` — MemoryTrace 3.0: rótulo do botão por
  tipo de contexto recuperado (memórias / conversas / ambos) + motivo por item


**Validação:** `relevanceScorer.test.js` → 27/27; suíte completa do backend →
417 pass / 2 skipped / 0 falhas; `vite build` do frontend limpo (`dist`
reconstruído). Origem: correção feita por um agente no sandbox de dev (sem rede
para push); os arquivos foram trazidos e publicados a partir do ambiente com rede.


## 🩺 Correção de watchdog de streaming (C7) + métricas de saúde no healthcheck (C8) (2026-07-24 — branch `main`, commit `d393640`)


**Contexto:** auditoria técnica (`AUDITORIA_TECNICA_FREDERICO_AI_STUDIO.md`) 
listou 10 problemas; dois foram corrigidos nesta rodada (os de curto prazo 
factíveis sem reestruturação).


### C7 — Unificar watchdogs de streaming (backend como fonte de verdade)


**Problema:** o frontend tinha `SSE_STALL_MS = 60000` (60s) e o backend tinha 
`guardStreamStall` (180s). Como o timeout do frontend era menor, ele abortava 
antes do backend, gerando falsos positivos — o usuário via "stream travado" 
quando na verdade o modelo só estava pensando (ex.: DeepSeek R1 com <think> 
longo, ou o primeiro token de um modelo lento em pico de uso).


**Correção:** `SSE_STALL_MS` do frontend (`frontend/src/hooks/useChat.js`) 
subiu de 60s → 300s (5 min). O backend (`guardStreamStall` em 180s) continua 
sendo a fonte de verdade — ele tem visibilidade real do socket e do heartbeat 
do provedor. O frontend agora é apenas um **fallback de conexão TCP perdida** 
(se o EventSource morrer sem notificar, o timeout de 5 min evita que o chat 
fique pendurado para sempre). Comentário documentando a hierarquia de duas 
camadas adicionado no hook.


### C8 — `unhandledRejection` counter + healthcheck


**Problema:** `process.on('unhandledRejection')` no `server.js` só dava 
`console.error`, sem visibilidade em produção. Se promessas começassem a 
vazar (ex.: após um deploy com bug), ninguém saberia até o processo crashar 
por memória ou o event loop ficar lento.


**Correção:** novo módulo `backend/src/healthMetrics.js` exporta objeto 
`{ unhandledRejections, bootAt }`. O handler de `unhandledRejection` em 
`server.js` incrementa o contador. O endpoint `GET /api/health` 
(`backend/src/routes/account.js`) agora inclui `bootAt` e `unhandledRejections` 
na resposta — compatível com versão anterior (campos adicionados, nenhum 
removido). Assim um monitor externo (Uptime Kuma, Healthchecks.io, Grafana) 
pode alertar quando `unhandledRejections > 0`.


**Arquivos modificados:** `frontend/src/hooks/useChat.js`, 
`backend/src/server.js`, `backend/src/routes/account.js`. 
**Arquivo novo:** `backend/src/healthMetrics.js`.


**Validação:** `node --check` nos 3 arquivos backend; suíte `streamGuard.test.js` 
(6/6 passando); `curl /api/health` confirmando os novos campos. 
Commit direto em `main` (sem PR).


**Pendências da auditoria (médio prazo, não mexidas):** React Router (C1/C6), 
projetos no banco (C3), prompt modular (C5), proxy de containers (C9).


## 🔒 Revisão dos PRs #102–#107 (Companion + Docling): isolamento, churn de sandbox e contradição de prompt (2026-07-23 — branch `claude/steps-count-bug-v879qz`)

Análise completa do código novo (Companion fases 1–2, Docling fases 1–2,
launcher). Quatro correções aplicadas:

1. **SEGURANÇA (grave) — posse no monitor de Git do Companion:**
   `POST /companion/monitor/git` só validava o FORMATO do `conversationId`;
   qualquer usuário logado com o id de uma conversa alheia lia branch +
   arquivos alterados do workspace de outro dono (e fazia o servidor criar um
   container para isso). Agora a rota exige posse
   (`WHERE id=? AND user_id=?` → 404), como manda a regra multi-tenant.
2. **Recursos/VPS — monitor OBSERVA, não cria:** `inspectGit` usava
   `execInSandbox`, que (a) MATERIALIZAVA um container a cada ciclo de polling
   (90 s) quando não havia um, e (b) pior: com opções default, DERRUBAVA e
   recriava um sandbox ativo de política diferente (`getContainer` troca o
   container quando a policyKey não bate) — podia matar um sandbox do modo dev
   no meio do trabalho. Novo `execInActiveSandbox` (sandbox.js): executa SÓ se
   já houver sandbox ativo, nunca cria/troca/mata, não estende o lastUsed
   (observar não deve impedir o reaper) e no timeout apenas desiste da leitura.
   Sem sandbox → `{ isRepo:false, noSandbox:true }`.
3. **Contradição de prompt (Docling ligado):** a `uploadsNote` (system) manda
   extrair anexos com ferramentas; o contexto do Docling manda NÃO reextrair —
   e `mustInspectUploads` ainda FORÇAVA `tool_choice='required'`. Mesma classe
   do bug "não tenho acesso ao GitHub" (2026-07-22). Agora: nota de
   precedência `DOC_PRECEDENCE_NOTE` (context.js) publicada entre as duas
   ("pré-processados usam o conteúdo fornecido; ferramentas valem para os
   demais anexos e para cálculos/conversões"), a nota do Docling é escopada
   aos documentos listados, e `mustInspectUploads` não força ferramenta quando
   o conteúdo documental já foi injetado.
4. **Botão "Reprocessar" do Docling era no-op:** com a mesma config, o
   `processFile` devolvia o cache (early-return) e nada reprocessava. Agora a
   rota passa `force:true` e o `processFile` ignora o cache nesse caso; o hash
   usa `f.hash || row.hash` (arquivos antigos sem hash na tabela files).

**Registrados sem correção (menores):** docling-service ignora `ocr:auto|never`
(`do_ocr=True` sempre — a config prometida entra no config_version mas não é a
efetiva); `inbox.js` insere em files sem hash/mime (anexos do inbox ficam fora
do Docling — o fallback cobre); `selectChunks` não inclui chunks sem match "se
sobrar espaço" (comentário promete, código não faz); no caminho "documento
completo" as páginas vão como `<!-- page: N -->` e o modelo pode não citá-las;
definir `DOCLING_INTERNAL_TOKEN` no .env da VPS ao ligar o Docling.

**Validação:** `node --check` em todos os arquivos tocados; suíte
`node --test` → 337 testes, 335 pass, 0 fail (inclui teste novo do
`inspectGit` sem sandbox). Nenhuma migração nem mudança de frontend.

## 🔁 FIM do "limite de N etapas" em tarefa produtiva — fôlego automático + retomada na pipeline (2026-07-23 — branch `claude/steps-count-bug-v879qz`)

**Sintoma (com print):** pipeline multimodelo ("Especialistas em sequência"), a
etapa 2 (Revisão especializada, Kimi K3) morre com _"A tarefa atingiu o limite
de 90 etapas antes da conclusão"_ e o estágio vira **"● Erro"** — no MEIO de
trabalho legítimo (inspecionando/corrigindo um .xlsx, 11,4M tokens, 84 min).
Bug "consertado várias vezes" (PR #58 subiu 60→90) mas sempre voltava, porque
as correções mexiam no NÚMERO, não no MODELO do limite.

**Causa raiz (por que o Claude Code não sofre disso):** ferramentas maduras de
agente NÃO limitam por contador de etapas — os freios são de **falta de
progresso** (repetição, falhas seguidas, estagnação) e o contexto é
**compactado** quando cresce. Aqui, qualquer teto fixo (60, 90, 200…) sempre
será alcançado por uma tarefa pesada honesta: cada etapa = 1 turno do modelo
(~1 ferramenta), e revisar uma planilha real consome dezenas de turnos. Dois
agravantes: (1) o loop abortava a tarefa **ainda produtiva** ao bater
`hardMaxSteps`; (2) na pipeline multimodelo o `step_limit` era terminal — o
estágio virava Erro e a sequência parava, pois o botão "Continuar" do chat não
existe dentro do quadro multimodelo (o checkpoint ficava salvo sem ninguém usar).

**Correção (modelo novo, não número novo):**
- **`loop.js` — fôlego automático:** `hardMaxSteps` passa a valer por JANELA.
  Ao bater o teto com progresso recente (o mesmo sinal `lastProductiveStep`/
  `IDLE_STEP_GRACE` de antes), o loop **compacta o histórico**
  (`trimCheckpointMessages`, o mesmo apara do checkpoint — preserva preâmbulo
  de sistema + cauda recente) + injeta `AUTO_CONTINUE_NOTE` (checkpoint.js) e
  **renova a janela de orçamento**, até `AGENT_MAX_AUTO_CONTINUES` vezes
  (padrão 6; 0 desliga = comportamento antigo). É o que o "Continuar" faria,
  sem parar. Estagnação, 5 falhas seguidas, degeneração e limites de pesquisa
  web continuam encerrando como antes. Mensagem de limite agora cita o total
  REAL de etapas executadas.
- **`multiModel.js` — retomada automática da etapa:** se mesmo assim uma etapa
  da pipeline terminar `resumable` por `step_limit`, o orquestrador recarrega o
  checkpoint (`loadCheckpoint`) e chama `runAgent({ resume })` de novo, até
  `PIPELINE_STAGE_RESUME_LIMIT` vezes (padrão 2), antes de marcar Erro. Só
  `step_limit` retoma na hora (falha de provedor já esgotou a cadeia de reserva).
  Usage somado UMA vez no final (o resume acumula o consumo anterior — somar a
  cada tentativa duplicaria).
- **Custo/latência:** a compactação também resolve o crescimento sem fim do
  array `messages` (era reenviado inteiro a cada turno — daí 11,4M tokens);
  janelas seguintes partem de um contexto aparado.
- Docs: `.env.example` + tabela do README com as duas variáveis novas.

**Regra para não regredir:** NUNCA "resolver" limite de etapas aumentando o
número. Tarefa produtiva não morre por contador; morre por falta de progresso.
Os tetos são para-raios, e a resposta ao teto é compactar + continuar.

## 🐛 Corrige "conecto o GitHub e a IA diz que não tem acesso" (2026-07-22 — branch `claude/resumo-alteracoes-tres-dias-vukd8t`)

**Sintoma relatado (com print):** no Modo Desenvolvedor, com um repositório
GitHub selecionado, a IA respondia que **"não tem acesso ao GitHub"** e às vezes
a execução terminava com o selo **"● Erro"**. O usuário suspeitou (corretamente)
que era bug do app, não do OpenRouter.

**Causa raiz encontrada (contradição interna do app):**
1. O prompt do modo desenvolvedor mandava **clonar** (`prompts.js`, "PRIMEIRO
   PASSO OBRIGATÓRIO: chame github_clone") sempre que um repo estava
   *selecionado* — independente de haver conexão.
2. Mas as ferramentas `github_*` só eram entregues ao modelo se
   `hasGithubConnection(userId)` fosse verdadeiro (`loop.js`).
3. Quando os dois discordavam (repo selecionado + conexão ausente), o modelo era
   mandado usar uma ferramenta **que não estava na lista dele** → respondia o
   "não tenho acesso" genérico.
4. Agravante: `getGithubConnection` (`connectors/github.js`) engolia **qualquer**
   erro em silêncio (`catch { return null }`, e `if (!token) return null` quando
   a descriptografia falhava) — então, se a `ENCRYPTION_KEY` mudou entre deploys,
   o usuário aparecia "conectado" no banco mas o app o tratava como desconectado,
   **sem nenhum log** apontando a causa.

**Correções aplicadas:**
- **`loop.js`**: consulta `hasGithubConnection` UMA vez, passa `{ githubConnected }`
  para `developerContextFor` e reaproveita no gate das ferramentas (fim da
  consulta dupla ao banco).
- **`prompts.js`** (`developerContextFor(request, userId, opts)`): quando há repo
  selecionado mas **sem conexão**, a nota deixa de mandar clonar e passa a
  instruir o modelo a explicar objetivamente que o usuário precisa **reconectar
  em Configurações → Conectores** — em vez do "não tenho acesso" confuso. Default
  `githubConnected=true` preserva os demais chamadores (orchestrator/multiModel).
- **`connectors/github.js`**: `getGithubConnection` passa a **logar** os dois
  casos antes engolidos — token que não descriptografa (ENCRYPTION_KEY mudou) e
  erro de banco — distinguindo "nunca conectou" de "conexão quebrada".

**Sobre o selo "● Erro" (sintoma separado):** vem de um `throw` de erro de
provedor no `loop.js` (não é incompatibilidade de ferramentas — essa já é
tratada sem erro, "respondendo em texto"). Provável erro do provedor do modelo
escolhido (ex.: Kimi K3) ao receber ferramentas. **Não** foi alterado às cegas —
depende do texto real do erro para classificar sem regressão; fica registrado
como próximo passo caso persista com modelos específicos.

**Testes:** `prompts.dev.test.js` ganhou 3 casos (conectado manda clonar; sem
conexão pede reconexão e não emite o comando de clone; sem opts preserva o
comportamento antigo). Suíte completa: **179 testes, 177 passam, 0 falham**, 2
pulados (Postgres).

## 🔎 Auditoria cruzada Git × CONTINUIDADE + registro de lacunas (2026-07-22 — branch `claude/resumo-alteracoes-tres-dias-vukd8t`)

**Pedido:** o usuário achou o app "muito bugado" e pediu um resumo detalhado de
tudo que foi feito, e depois uma **conferência cruzada** entre o histórico real
do Git (PRs #18→#77) e este arquivo, para auditar e melhorar o `CONTINUIDADE.md`.

**Método:** listei os 59 PRs do histórico do Git e cruzei um a um contra as 30
seções deste arquivo (busca por palavra-chave + leitura de contexto).
**Resultado:** o arquivo não inventa nada e cobre ~90% do trabalho, mas
encontrei **4 frentes que entraram no código e não tinham registro aqui** — são
lacunas de OMISSÃO, não de divergência (as features existem no app; só não
estavam anotadas). Registradas abaixo, com detalhe, para fechar as lacunas.

**Nota de numeração:** o histórico deste repositório **começa no PR #18**
(18/07/2026, "Câmera no chat"). Os PRs **#1–#17 não existem neste repositório**
(predatam o histórico atual) e o **#43 foi fechado como superado** pela
modularização do backend (ver primeira seção de 07-21). Ao auditar cronologia,
lembrar que datas de seção às vezes são a data de AUTORIA da branch, enquanto o
merge do PR ocorreu 1 dia depois (ex.: "Catálogo de modelos" rotulado 07-20,
PR #55 mergeado 07-21).

### 💾 Cache — prompt caching, embeddings, CNPJ e busca web (PR #57, 2026-07-20) — LACUNA PREENCHIDA

A memória de longo prazo já preservava contexto; faltava a camada de **CACHE**
para reduzir custo de tokens, evitar chamadas externas repetidas e acelerar
respostas. Utilitário único `backend/src/cache.js` (TTL + LRU, sem dependências)
aplicado em 4 frentes:
1. **Prompt caching do LLM** (`provider.applyPromptCache`): marca o preâmbulo
   estável (prompt-base + notas de sistema) com `cache_control` para o provedor
   reaproveitar entre mensagens/etapas — menos tokens de ENTRADA e menor
   latência. Só onde é seguro: via OpenRouter para Anthropic/Gemini. A API
   direta da DeepSeek já cacheia sozinha (não recebe `cache_control`).
   `usage.cached_tokens` passa a ser contabilizado. Ligado no agente único e nos
   3 pontos do Modo Equipe.
2. **Embeddings** (`memory/embeddings.js`): memoiza por `hash(kind, texto)` — a
   mesma pergunta não é re-embedada a cada mensagem.
3. **Consulta de CNPJ** (`tools.js`): TTL longo (12h); guarda só resultados
   definitivos (sucesso ou "não encontrado"), nunca erros transitórios.
4. **Busca web** (`tools.js`): TTL curto (10min) contra repetição imediata.

Observabilidade: `GET /api/cache/stats` (tamanho, TTL, taxa de acerto). Tudo
desligável por env (`PROMPT_CACHE`, `EMBED_CACHE_MAX`, `TOOL_CACHE`,
`*_CACHE_TTL_MS`). Testes: `cache.test.js`, `provider.promptCache.test.js`.

### 🆓 Modo gratuito para novos usuários sem chave de API (PR #67, 2026-07-21) — LACUNA PREENCHIDA

Primeiro acesso sem barreira: quem não tem chave escolhe entre **"Começar
gratuitamente"** (chave da plataforma, só no backend) e **"Configurar minha
própria chave"** (assistente `KeyWizard` para OpenRouter, DeepSeek, Groq, Gemini,
Mistral). Backend:
- `freeTier.js`: allowlist de modelos gratuitos (padrão OpenRouter `:free`, com
  fallback), limite diário por usuário + sobreposição individual, freio por
  minuto, bloqueio por abuso, registro de consumo/erros, config do admin com
  efeito imediato (`free_tier_settings`).
- `freeQueue.js`: fila global com concorrência limitada, posição visível e
  cancelamento (Parar cancela job ainda na fila).
- `userProvider.js`: nova fonte `'free'` (usuário > modo gratuito > chave do
  servidor); loop/orquestrador/multimodelo restringem modelos à allowlist.
- Rotas `/api/free-tier/status` e `/opt-in`; painel admin `/api/admin/free-tier`
  (somente `ADMIN_EMAIL`). **Migração 007** (`free_mode` + tabelas `free_tier_*`);
  **depois renumerada para 008** porque a main já usara a 007 para checkpoints.

Frontend: onboarding com as 2 opções + aviso das limitações; chip "Modo
gratuito" no chat (modelo, restantes) + gaveta (provedor, fila, renovação);
tela amigável de limite atingido; `FreeAdminPanel`. **A chave gratuita vive só
no `.env` do servidor** (nunca no cliente/repo). Pesquisa jul/2026 documentada
no README: OpenRouter permite servir usuários finais via backend próprio;
NVIDIA NIM, Cohere trial e GitHub Models **proíbem** — não usar.

### 🔗 Atribuição do app no OpenRouter + failover de modelo 404 (PRs #70–#76, 2026-07-20/21) — LACUNA PREENCHIDA

Frente de estabilidade/identidade do provedor (6 PRs), antes sem registro:
- **Identificação do app** (`aiClient.js`, PRs #70/#71): as chamadas ao
  OpenRouter chegavam sem `HTTP-Referer`/`X-Title` — o app aparecia como
  "desconhecido" nos Registros. Helper único `createAiClient` injeta os
  cabeçalhos quando a base URL é do OpenRouter; aplicado em TODOS os pontos que
  criam cliente (BYOK `userProvider.js`, cliente legado, indexador de memória,
  teste de chave). Nome/URL via `OPENROUTER_APP_TITLE`/`OPENROUTER_APP_URL`.
- **Prioriza `BETTER_AUTH_URL`** na atribuição (PR #71): em produção o
  docker-compose define `BETTER_AUTH_URL` a partir do `DOMAIN`, enquanto o
  `FRONTEND_URL` do `.env.example` ainda é localhost — sem isso o app seria
  marcado com URL de dev. Fallback reordenado para preferir `BETTER_AUTH_URL`.
- **404 de modelo faz FAILOVER** em vez de erro fatal (PR #72): vários modelos
  davam "Modelo não encontrado" (404) e a tarefa encerrava de vez.
  `isModelUnavailableError` detecta 404 / "not a valid model id" / "no endpoints
  available" e, no loop do agente, aciona o failover para o próximo modelo de
  reserva. `friendlyApiError` passa a mostrar o motivo real do provedor. A lista
  PADRÃO de modelos gratuitos apontava para IDs mortos (gemma-4,
  nemotron-3-super-120b, openrouter/free) → trocada por IDs `:free` vivos.
  Testes: `agent.modelUnavailable.test.js`.

### 🧩 Repositório selecionado informado aos modelos no Modo Multimodelo (2026-07-22) — LACUNA PREENCHIDA (mudança mais recente)

O fix anterior (`072884f`, Modo Equipe) só cobriu o `orchestrator.js` (N
assistentes no MESMO modelo). O **multimodelo real** — N modelos DISTINTOS nos
modos compare/council/debate/pipeline — roda em `multiModel.js`, que nunca
recebia o contexto do repositório. Por isso, com um repo GitHub selecionado no
Modo Desenvolvedor, os modelos ainda respondiam "me mande o link do
repositório" / "não tenho acesso ao GitHub". Agora `runMultiModel` calcula a nota
do time uma vez (`developerTeamContextFor`), e `multiModelSystemBlocks` injeta
papel + nota do repositório como 2º bloco de sistema em `slotMessages` (cobre
compare/council/debate + etapas não-executoras do pipeline) e no
`streamCoordinator`. Execução real (clone/leitura) segue no executor via
`runAgent`. Testes de regressão em `multiModel.test.js`.

### 🔐 Nota: rodada de segurança inicial (PR #21, 2026-07-18) — antes sem parágrafo próprio

Registrado aqui para completar a auditoria. **Críticos:** `/api/backup` virou
SOMENTE admin (`ADMIN_EMAIL`) — antes qualquer usuário logado baixava o banco
inteiro + todos os workspaces (incluindo chaves BYOK); "Pastas do PC" desativado
por padrão (`ENABLE_PC_FOLDERS=false`), `isDangerousHostPath` passa a rejeitar
qualquer `..`. **Altos:** Multer 1.x → 2.2.0 (DoS) + limite de 20 arquivos;
fuso `America/Sao_Paulo` por padrão (antes contadores diários ~3h fora no
Brasil); "pode/sim/não/continua" deixam de ser tratados como baixo sinal (senão
o agente perdia as ferramentas ao confirmar "posso gerar?"); `POST
/api/provider/test` passa a testar a chave DIGITADA no corpo.

## 🧹 Varredura de PRs antigos abertos + remoção dos pins de versão do prompt (2026-07-21 — branch `claude/version-pins-cleanup`)

**Pedido:** buscar PRs abertos esquecidos no repositório e mesclar.

Achados 2 PRs de 2026-07-19 (#40 e #43), ambos com conflito contra o `main`
atual — natural, dado o tanto que mudou desde então (checkpoint/resume,
multiconversa, modo gratuito, LGPD, antivírus, redesign do Modo Desenvolvedor).

- **PR #40 (correção de SSRF no `web_fetch`)** — conferido: a vulnerabilidade
  ainda estava presente no `tools.js` atual (bypass por IPv6 entre colchetes +
  falta de defesa contra DNS rebinding). Fiz `git rebase` da branch sobre o
  `main` atual — o código aplicou limpo (só o texto do CONTINUIDADE.md teve
  conflito, resolvido mantendo as duas entradas). Suíte completa: 166 testes,
  164 passam, 2 pulados (Postgres). **Mesclado.**
- **PR #43 (consolidação do system prompt)** — este **não deu para simplesmente
  rebasear**: o `backend/src/agent.js` que ele editava (113 linhas mudadas)
  virou, depois de 2026-07-19, uma FACHADA de 43 linhas que só reexporta de
  `backend/src/agent/*.js` (loop, prompts, orchestrator...). Reaplicar o diff
  original não faz sentido — a estrutura mudou por completo. Da lista de 4
  melhorias do PR, conferi cada uma contra o código de hoje:
  1. Mensagem system única — ainda não está assim hoje (`agent/loop.js` monta
     várias mensagens `system`); precisaria ser refeito do zero contra a
     arquitetura atual (loop.js + checkpoint/resume), não é um ajuste pequeno.
  2. Deduplicação de regras — mesma situação.
  3. Precedência de estilo dos sliders — idem.
  4. **Pins de versão no prompt** (`Python 3.12`, `kotlinc 2.3.21`) — ainda
     presentes, e o motivo do PR continua válido: a versão real já é conferida
     AO VIVO pelo audit de ambiente (`verifiedEnvironmentNote`, ainda existe em
     `agent/prompts.js`), então o pin é só informação que pode ficar desatualizada
     silenciosamente. Esta parte É pequena e segura, então apliquei de novo à
     mão nos arquivos atuais (`agent/prompts.js`, `agent/orchestrator.js`,
     `tools.js`): "Python 3.12" → "Python 3", "kotlinc 2.3.21" → "kotlinc".
     Testado: suíte completa (166, 164 passam, 2 pulados) + `prompts.dev.test.js`.

  **PR #43 fechado** como superado pela reorganização do backend, com o pedaço
  seguro (pins de versão) reaplicado nesta branch. Os itens 1–3 (mensagem
  system única, dedup de regras, precedência de sliders) ficam como
  **pendência real** para quem quiser reabrir essa frente — exigem entender a
  fundo `agent/loop.js` atual (que já ganhou checkpoint/resume no meio) antes
  de mexer, para não regredir nada.

## 🏆 Classificação de referência dos modelos no seletor (2026-07-21 — branch `claude/antivirus-vps-42tstn`)

**Pedido:** o usuário tem um ranking pessoal dos 100 melhores modelos (Tier
S+/S/A+/A/B+/B) e queria essa informação disponível no seletor de modelo, sem
"bagunçar o layout" nem complicar a visualização.

**Decisão de design:** nada de seção nova, coluna nova ou painel novo — só um
**selo discreto** (`S+`/`S`/`A+`/.../`B`) colado ao nome do modelo, e mais UMA
opção no `<select>` "Ordenar" que já existia (Nome/Lançamentos/Menor custo →
+ "Classificação de referência"). Modelo sem correspondência no ranking não
ganha selo nenhum — o app nunca inventa uma posição.

**`frontend/src/modelRanking.js`** (novo): os 100 nomes na ordem informada
(posição no array = rank), faixas de tier fixas (1–10 S+, 11–25 S, 26–50 A+,
51–75 A, 76–90 B+, 91–100 B) e `findRanking(model)`. O casamento é por NOME
normalizado contra o catálogo real (que vem do OpenRouter/DeepSeek em tempo de
execução) — não por id, porque os nomes na lista ("Claude Opus 4.8 Thinking")
raramente batem exatamente com o slug do catálogo
(`anthropic/claude-opus-4.8`). Normalização: minúsculas, travessão usado como
separador vira espaço (mas hífen colado numa palavra como `gpt-5.6` ou `x-ai`
não é tocado), pontuação removida sem quebrar número de versão (`5.6` → `56`,
não `5 6`). Se não bate exato, tenta bater pela versão "sem ruído" (remove
palavras como thinking/high/preview/turbo/instant/beta N) — assim "Claude Opus
4.8" (nome simples do catálogo) encontra a entrada "Claude Opus 4.8 Thinking"
da lista quando não existe uma entrada sem qualificador. **Sem match nenhum →
`null` → sem selo.** Nunca chuta.

**`components.jsx` (`ModelPicker`)**: `row(model)` calcula `findRanking(model)`
uma vez e, se existir, insere `<span class="mpRank tier{X}">{tier}</span>`
logo depois do nome, com `title` explicando a posição exata (ex.: "#22 de 100
· Tier S"). Novo `sort==='rank'` no `sortFn` existente + `<option
value="rank">` no select "Ordenar" (mesmo padrão de "Lançamentos"/"Menor
custo" — nada de UI nova).

**CSS (`styles.css`)**: `.mpRank` é uma pastilha pequena, cor **derivada de
`var(--accent)`** por `color-mix` (mais forte em S+/S, neutra em B+/B) — não
hex fixo, mantém a regra das 7 paletas. Um bloco de 8 linhas, sem novo layout.

**Honestidade sobre o rótulo:** o app é multiusuário (SaaS). Chamei de
"Classificação de referência" em vez de "Sua classificação"/"Minha
classificação" no texto visível, porque é uma curadoria do dono do app
embutida como dado estático — não é a opinião de quem está logado no momento
(mesmo cuidado já aplicado noutras partes do produto, ex.: seção de segurança
da landing só anuncia o que está de fato ativo).

**Teste:** dataset com 100 entradas confirmado (contagem por tier bate:
10/15/25/25/15/10), casamento verificado com nomes reais plausíveis do
catálogo (`Claude Sonnet 5`→#22, `Claude Opus 4.8`→#11 exato, `GPT-5.6
Sol`→#2 via fallback sem "xHigh", nome desconhecido→`null`), e render real
(`renderToStaticMarkup`) do `ModelPicker` confirmando que o HTML gerado tem o
selo certo (`tierS`, tooltip com #22) no lugar certo.

## 🖥️ Redesign do Modo Desenvolvedor a partir de handoff de design (2026-07-21 — branch `claude/antivirus-vps-42tstn`)

**Pedido:** aplicar no app um handoff de design (`.dc.html` + README, protótipo
Codex/Claude-Code-style) para o Modo Desenvolvedor — sidebar de projetos/tarefas,
centro com stage-driven timeline, gaveta direita com abas Atividade/Arquivos/
Alterações/Memória.

**Descoberta antes de codar (mudou o plano):** o repositório já tinha avançado
~49 commits desde a última vez que essa área foi tocada nesta sessão. O que o
handoff descrevia como "a ser construído" **já existia, mais avançado**: 6
modos de trabalho ponta a ponta (`DEV_WORK_MODES`/`DEV_MODES` no backend),
projetos persistentes (`useDevProjects.js`, localStorage: nome, descrição,
techs, vínculo pasta/GitHub, regras, memória em 6 categorias, histórico de
conversas), layout de 4 colunas (`workspace-developer`: sidebar + `DevProjectRail`
+ chat + `DevActivityRail`), e um `ExecutionSession` rico (cartão + overlay em
tela cheia, categorização por ferramenta, miniaturas reais de página via
`pageShot.js`). Reconstruir do zero teria REGREDIDO checkpoint/resume,
multiconversa e o `ExecutionSession` — todos maduros e testados. Decisão:
**redesenhar visual/interação em cima do que já existe**, não substituir.

**O que foi feito (só frontend):**
- `components/ExecutionSession.jsx`: exporta `metaOf`/`describe`/`CAT_META`/
  `statusIcon`/`tryParse` (antes privados do módulo) — o painel de Atividade
  reaproveita a MESMA categorização/rótulo por ferramenta que o "Ambiente de
  Trabalho da IA" já usa, em vez de duplicar/divergir.
- `components/DevActivityRail.jsx`: virou painel com 4 abas.
  - **Atividade**: além do cartão de status (mantido), lista cronológica dos
    passos da última resposta, com chamadas CONSECUTIVAS da mesma ferramenta
    agrupadas ("2× Comando no terminal", expansível) em vez de um item por
    chamada.
  - **Arquivos**: `read_file`/`list_files` da resposta (analisados).
  - **Alterações**: `write_file` com path/tamanho REAIS (do JSON que a
    ferramenta devolve) e selo A/M — M se o mesmo caminho já apareceu numa
    leitura antes na mesma resposta, A caso contrário. **Não inventa contagem
    de linhas/diff** — o backend não devolve isso.
  - **Memória**: o editor de 6 campos que já existia, só migrado para aba.
- `components/DevProjectRail.jsx`: a seção "Conversas do projeto" (só uma
  contagem, sem lista) virou **"Tarefas recentes"** clicável de verdade —
  resolve `project.conversationIds` para título real via `allConvs` (não
  mostra nada se a conversa não existir mais).
- `App.jsx`: pill de status no cabeçalho do workspace dev — **honesto**, 3-5
  estados derivados de sinais reais (`busy`/`paused`/`statusText`/
  `message.failed`/`message.resumable`), SEM fingir o pipeline de 5 etapas do
  protótipo (Analisando/Planejando/.../Revisando) que o backend não expõe
  (modos são um seletor de tipo de tarefa, não estágios sequenciais — confirmado
  por leitura de `backend/src/agent/prompts.js`/`loop.js`). Novo chip
  **Permissões** no composer (mesmo padrão do chip Esforço): popover só-leitura
  mostrando o modo ativo (edita/não edita) e o vínculo do projeto — dado real,
  não um toggle fictício. Cores decorativas dos 4 cartões de modo na tela vazia
  (azul/verde/âmbar/violeta) seguindo o MESMO precedente já usado nos
  `QUICK_ACTIONS` (`:nth-child` escopado, `v2.css`) — não um tema fixo.
- **Removido**: `ToolStep` (componente + CSS `.toolstep/.toolwrap/.tchev/
  .tooldetail`) — zero usos em todo o frontend, órfão desde que
  `ExecutionSession` assumiu esse papel.

**Decisão deliberada de NÃO seguir o handoff ao pé da letra (paletas):** o
protótipo define uma paleta escura fixa em hex. Este projeto tem uma regra já
documentada e reforçada por sessões anteriores — "Regra das 7 paletas: cores
saem de `var(--accent/--muted/--line)` ou `color-mix`, nunca hex fixo, senão
Claro/Sépia herdam azul" (`v2.css`, cabeçalho). Forçar o tema escuro do
protótipo ignoraria essa regra e quebraria a experiência de quem usa Claro/
Sépia/Slate/etc. no Modo Desenvolvedor. Em vez disso, o redesign usa os MESMOS
tokens semânticos (`--accent`, `--ok`, `--warn`, `--danger`) para computar os
mesmos papéis de cor do handoff (azul=ação, verde=sucesso/edita, âmbar=atenção/
corrigir, roxo=revisar — fixo, mesmo precedente decorativo do `QUICK_ACTIONS`),
então o resultado se adapta às 7 paletas em vez de fixar uma só.
**Também fora do escopo, por honestidade**: a barra de "Protótipo · estados"/
toggle desktop-mobile/overlay "Mudanças de arquitetura" do topo do `.dc.html`
— o próprio README do handoff diz que é chrome da ferramenta de design, não
parte do produto.

**Gaps conhecidos que ficam para depois (não bloqueiam este redesign):**
- `POST /tasks` (fila em segundo plano) não aceita contexto `developer` nem
  `effort` hoje — confirmado lendo `backend/src/routes/tasks.js`. O chip
  "Executar em segundo plano" já existia e continua funcionando, mas uma
  tarefa de dev enviada em 2º plano perde o modo/projeto/regras (só o texto
  vai). Se algum dia isso incomodar, dá para persistir `developer`/`effort` na
  tabela `tasks` e repassar em `processTasks()`.
- "Tarefas recentes" e a memória do projeto continuam só em `localStorage`
  (`useDevProjects.js`) — não sincronizam entre navegadores/dispositivos. Virar
  persistência no servidor é um projeto à parte (tabela nova + rotas CRUD).

**Verificação:** sem acesso a Postgres/chave de IA real neste ambiente, então
sem E2E ao vivo. Feito: `npx esbuild` em todo arquivo tocado, `npm run build`
do frontend (limpo), suíte `authUrls.test.js`+`sse.test.js` (7/7), e um teste
de fumaça server-side (`renderToStaticMarkup`) dos dois componentes novos com
dados realistas (chamadas de ferramenta consecutivas/erros/list_files/
write_file com JSON real do backend) confirmando que o agrupamento "2×", os
selos A/M, a categorização e a lista de tarefas recentes renderizam como
esperado — não só que compilam.

## ⏭️ Retomada REAL de tarefa interrompida — checkpoint persistente (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`)

**Pedido:** o app prometia "Reenviar para continuar de onde parei" quando a
tarefa batia no limite de ciclos (~90), mas ao reenviar a execução **começava do
zero** — todo o progresso, contexto operacional e estado se perdiam. O usuário
pediu uma retomada estrutural (não só aumentar o limite ou reenviar o texto),
preservando objetivo, plano, etapas/ferramentas já usadas, arquivos criados,
comandos executados, resultados, erros, ciclo em que parou, texto parcial,
decisões, modelo principal/reserva e o que falta — com checkpoint persistente e
cenários separados (limite / watchdog / desconexão / falha de modelo / reinício
do backend). É problema DIFERENTE do watchdog (PR #63): watchdog é o stream
travar; este é a retomada não existir de verdade.

**Causa raiz (confirmada no código):** o array `messages` do agente — que É o
estado operacional completo (objetivo = msg do usuário; plano/texto parcial =
conteúdo do assistente; etapas/ferramentas = `assistant.tool_calls`; resultados/
erros = mensagens `role:'tool'`; decisões = conteúdo) — vivia **só na RAM** e era
descartado quando o `runAgent` retornava. No limite de ciclos só o `finalText`
(texto visível parcial) era salvo. E o "Reenviar" (`retrySend`) chamava
`/truncate` com o id da mensagem do USUÁRIO, **apagando** a msg do usuário + a
resposta parcial, e reenviava o texto → run NOVO cujo contexto (via
`selectHistoryForContext`) não tinha nada do turno interrompido. Duas falhas
somadas: (A) estado nunca persistido; (B) "Reenviar" era restart destrutivo.

**Correção estrutural — o array `messages` VIRA o checkpoint, persistido no
Postgres:**
- **`backend/migrations/007_execution_checkpoints.sql`** — tabela
  `execution_checkpoints` (1 por conversa, PK `conversation_id`, ON DELETE
  CASCADE): `run_id`, `objective`, `reason`, `model`, `tried_models` (cadeia de
  failover), `step`, `messages` (JSONB — o estado), `usage`, `meta`. **Postgres →
  sobrevive a reinício do backend** (não é só RAM).
- **`backend/src/agent/checkpoint.js`** (novo): `saveCheckpoint`/`loadCheckpoint`/
  `hasCheckpoint`/`clearCheckpoint`. Partes PURAS (testáveis sem DB/LLM):
  `trimCheckpointMessages` (apara por tamanho preservando preâmbulo + cauda
  recente e NUNCA deixando `tool` órfã — pareamento tool_call/tool_result
  válido), `buildResumeMessages` (semeia o run de retomada: estado + nota de
  "continue, não repita"), `isResumableReason` (mesmo mecanismo central p/
  limite E watchdog), `leadingSystemCount`.
- **`backend/src/agent/loop.js`** — `runAgent` aceita `resume`:
  - restaura `chosenModel` e `triedModels` do checkpoint (o **modelo de reserva
    herda o contexto**: continua no modelo ativo e não retenta os que já
    falharam);
  - substitui o contexto recém-montado pelo array salvo + notas de continuidade
    (não regrava mensagem de usuário, não reanexa imagens);
  - **orçamento de ciclos NOVO** (a retomada avança de verdade em vez de morrer
    no limite de novo);
  - `usage` soma sobre o run anterior; `outputsBefore` vazio no resume (arquivos
    já prontos contam como entrega e não disparam falso "arquivo não gerado");
  - ao terminar interrompida por `step_limit`/`provider_failure`/`stopped` (com
    progresso), **salva o checkpoint**; ao concluir limpo, **limpa**. Emite
    evento `resumable` ao vivo. Mensagem de limite reescrita: "**Continuar**"
    (não mais "Reenviar").
- **`backend/src/routes/conversations.js`** — `POST /conversations/:id/resume`
  (SSE igual ao /chat, mesmo `openLiveStream`, **sem gravar msg de usuário**,
  carrega o checkpoint e passa `resume` ao runAgent → mesmo `conversationId`, sem
  execução nova). `GET /:id` devolve `resumable` e marca a última msg do
  assistente. 409 se já ativo / sem checkpoint; 429 respeita o teto multiconversa.
- **Frontend** (`useChat.js`, `App.jsx`): `resumeRun(convId)` faz stream do
  `/resume` reusando `consumeChatStream` (multiconversa-aware: mesma época/gate
  por conversa, sem duplicar). Botão **"Continuar de onde parei"** (verde,
  distinto do "Reenviar") aparece na msg quando `resumable` (evento ao vivo OU
  flag do GET após reload). `.resumeBtn` no styles.css.

**Cenários separados (como pedido):**
- **Limite de ciclos** → checkpoint `step_limit`, continuação real.
- **Watchdog/stream travado** → o stall exaurido vira `provider_failure` (retryável)
  → checkpoint, retomada a partir do conteúdo já recebido.
- **Frontend desconectado** → reconecta à execução existente (multiconversa,
  PR #65) — não cria tarefa nova.
- **Falha do modelo** → failover herda `messages`+`triedModels` do ponto de parada.
- **Reinício do servidor** → checkpoint no Postgres; `loadCheckpoint` numa
  requisição nova reidrata o estado.

**Anti-duplicidade:** resume checa `isConversationActive` (409), não grava msg de
usuário, usa o mesmo `conversationId`; no front, época por conversa descarta
consumidor duplo (herdado do PR #65).

**Testes:** `backend/src/agent/checkpoint.test.js` (7, PUROS — sem DB/LLM):
objetivo+ferramentas+resultados+texto parcial preservados; aparo mantém
pareamento e cauda recente sem tool órfã; toda `tool` tem seu `assistant` antes;
`buildResumeMessages` adiciona a orientação de continuar (e não a adiciona quando
parou após ferramenta); `isResumableReason` cobre requisito 8 (watchdog+limite no
mesmo mecanismo; falhas de qualidade fora). Suíte backend: **151 passam, 0
falham, 2 skips**. Frontend build OK + 7/7.

**Limitações que permanecem (honestidade):**
- O checkpoint guarda o estado do MODELO (array de mensagens), não um snapshot do
  filesystem do sandbox. Arquivos em `/workspace/outputs` persistem em disco por
  conversa, então continuam disponíveis; mas se o sandbox for reciclado, artefatos
  FORA de outputs (ex.: venv, estado intermediário) não voltam — o modelo relê/
  refaz o que precisar a partir dos resultados registrados.
- Interrupção EXATAMENTE no meio de uma ferramenta longa (ex.: um `bash` a meio
  de rodar): a ferramenta não é retomada no meio; o resume parte do último
  resultado COMPLETO registrado. Sem efeito colateral duplicado (a ferramenta
  incompleta não deixou resultado no array).
- Os testes puros provam o mecanismo (trim/seed/reason). A continuação
  ponta-a-ponta (ciclo 90 → 91 sem repetir, com LLM+Postgres reais) precisa ser
  exercitada em produção — este ambiente não tem provedor nem banco para o E2E.
- Só o agente de conversa única tem checkpoint. Multimodelo/Equipe ainda não
  (cada um teria seu próprio estado por participante) — fica como evolução.

## 🔀 Multiconversa — várias conversas processando ao mesmo tempo (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`)

**Pedido:** ter 3–5 conversas processando simultaneamente, com um indicador
girando na barra lateral mostrando quais estão ativas — e com MUITO cuidado:
trocar de conversa não pode parar, misturar nem confundir os andamentos.

**O que já existia:** o backend SEMPRE suportou execuções paralelas em
conversas diferentes (o controle pausar/parar e o liveStream são POR conversa;
`ConversationBusyError` só bloqueia a MESMA conversa). As travas eram todas do
frontend: um único estado global `busy/paused/statusText` no `useChat`, o
`blockConversationChange` do App impedia trocar de conversa durante um run, e
o consumo do SSE escrevia em `messages` sem checar qual conversa estava aberta.

**Frontend (`useChat.js` — o núcleo da mudança):**
- Estado de execução POR CONVERSA: `runs` (`convId → {busy, paused, status}`)
  + `runsRef` (fonte síncrona). `busy/paused/statusText` viraram PROJEÇÃO da
  conversa aberta — a API consumida pelo App não mudou (só ganhou
  `runs`/`anyBusy`). `busyRef` continua = conversa aberta (o `useTasks` usa).
- **ÉPOCAS de stream (anti-duplicação — o "não pode se misturar"):**
  `streamEpochsRef` conta uma época por conversa; todo consumidor (envio OU
  replay de reconexão) registra a época em que nasceu. Quem reconecta avança a
  época; o consumidor antigo detecta (`isLiveEpoch`) e se descarta cancelando o
  reader. Sem isso, voltar a uma conversa ativa criaria DOIS consumidores
  aplicando os mesmos eventos (texto dobrado).
- **Gates por conversa:** TODO update visual do stream (`update()`, `saved`)
  só aplica se `currentRef.current?.id === convId`. Status vai para o `runs` da
  conversa do stream, nunca para um global. Trocar de conversa no meio → os
  eventos da outra viram no-ops visuais (a tarefa segue no servidor).
- **1ª mensagem de conversa nova:** `currentRef` é sincronizado por efeito
  (roda depois do render); o sendMessage agora escreve `currentRef.current =
  conv` na hora (mesmo truque do openConversation) — sem isso os gates
  descartariam os primeiros eventos do stream.
- **Sair e voltar:** sair não interrompe (consumidor original segue lendo com
  updates em no-op e limpa o estado no `done`); voltar dispara o replay
  (`followActiveConversation`), que avança a época e reassume. Se o SSE cair
  com o usuário em OUTRA conversa, `watchDetachedRun` vigia por polling (5s,
  ~30 min) e apaga o "girando" quando o servidor terminar — a menos que alguém
  reconecte antes (época avança → vigia se retira).
- **Limpezas com dono único:** quem assume o acompanhamento (follow) é quem
  limpa (`endRun`); resultados `stale` NUNCA fazem cleanup (o novo consumidor é
  o dono). `loadFiles`/`setCurrent` pós-run só se a conversa ainda é a aberta.
- `App.jsx`: `blockConversationChange` virou no-op (trocar de conversa/cliente/
  nova conversa é livre); indicador `.spin.sm.convSpin` no item da barra
  lateral (`runs[c.id] ? runs[c.id].busy : c.active` — estado local vence, flag
  do servidor cobre reload/outro dispositivo); polling da lista a cada 10s
  ENQUANTO houver atividade (apaga/acende sozinho). CSS em styles.css.

**Backend (aditivo):**
- `GET /conversations` (todas as variantes) devolve `active` por linha
  (`isConversationActive`) — alimenta o indicador após reload/outro aparelho.
- `control.js`: `acquireConversationControl(conversationId, userId)` marca o
  dono; novo `countActiveRunsForUser(userId)`. `loop.js`/`multiModel.js`/
  `orchestrator.js` passam o userId (aditivo, sem mudança de comportamento).
- `POST /chat`: teto `MAX_ACTIVE_RUNS_PER_USER` (padrão 5, piso 1) → 429 com
  mensagem clara. Protege a VPS; tarefas de segundo plano não são bloqueadas
  pelo teto (só contam), e o 409 da MESMA conversa continua igual.
- `.env.example`/`README.md`: variável nova + linha na tabela de recursos.
  **Atenção:** conversas paralelas que EXECUTAM código disputam
  `MAX_SANDBOXES_PER_USER` (padrão 2) — subir os dois juntos se necessário.

**Validação:** backend **144 testes, 0 falhas** (2 novos em
`agent.control.test.js`: contagem por usuário e independência de stop/pause
entre conversas do mesmo dono). Frontend: build Vite OK + 7/7 (`dist/`
recompilado e commitado). NÃO houve teste de UI ao vivo multiconversa (sem
Docker/Postgres aqui) — validar em produção: enviar em 2–3 conversas, trocar
entre elas durante o processamento, conferir indicador girando, voltar e ver o
replay reconectar sem duplicar texto.

## ❓ Pergunta ao usuário encerra o turno — a IA não "responde a si mesma" (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`, follow-up do PR #63)

**Sintoma (print do usuário):** no Modo Desenvolvedor, o modelo terminou a
resposta com 3 perguntas ("Quais itens quer que eu ataque? Branch separado com
PR ou commit direto na main? Algo específico a incluir?") e, em vez de PARAR
para o usuário responder, a execução CONTINUOU — clonou o repositório e decidiu
tudo sozinha. O usuário não conseguia responder (o composer fica bloqueado
enquanto o run está ativo).

**Causa raiz:** quando o modelo para de chamar ferramentas para perguntar, o
`shouldRepairExecution` (repair.js) interpretava como "execução incompleta" e o
loop injetava `EXECUTION_COMPLETION_REPAIR_NOTE` com `tool_choice='required'` —
FORÇANDO o modelo a chamar ferramenta em vez de deixar a pergunta chegar ao
usuário. Os prompts (EXECUTION_CONTRACT_NOTE: "nada de ficar no plano") ainda
empurravam na mesma direção. Ou seja: o app tratava "perguntar" como falha.

**Correção:**
- `backend/src/agent/repair.js` — novo `endsAwaitingUserReply(text)`:
  detecta que a resposta TERMINA com "?" (após remover avisos padronizados do
  sistema e enfeites de markdown/aspas/parênteses do fechamento). Conservador:
  pergunta retórica no meio seguida de conclusão NÃO conta.
  `EXECUTION_CONTRACT_NOTE` ganhou a exceção explícita: faltou decisão do
  usuário → pergunte e PARE.
- `backend/src/agent/loop.js` — no ramo sem tool calls: se
  `endsAwaitingUserReply(content)` (e NÃO for `forceExecution` — tarefa de
  segundo plano não tem usuário presente para responder; lá o comportamento
  antigo continua), o turno completa naturalmente: sem reparo forçado, sem
  `MISSING_OUTPUT_NOTICE`/`EXECUTION_INCOMPLETE_NOTICE`, sem marcar
  `incomplete`. A pergunta é entregue e o composer libera. A checagem de
  `missingClaimedOutput` (texto afirma download que não existe) continua
  valendo MESMO com pergunta no final — mentir sobre arquivo é pior.
- `backend/src/agent/prompts.js` — QUALITY_BAR ganhou a regra: pergunta que
  depende de decisão da pessoa é o FIM da resposta; nunca continuar executando
  nem responder a própria pergunta no mesmo turno.

**Validação:** `repair.awaiting.test.js` (7 testes novos, incluindo o texto
REAL do bug com lista numerada de perguntas). Suíte backend completa: **142
passam, 0 falham, 2 skips pré-existentes**. Sem mudança de frontend (o
composer já libera quando o run termina — o problema era o run não terminar).

**Comportamento esperado após o deploy:** modelo pergunta → run termina →
usuário responde → a tarefa continua na mensagem seguinte com o contexto da
conversa. No modo `auto` o prompt já orienta a só perguntar diante de ação
destrutiva/fora de escopo — perguntas continuam raras lá.

## 🧊 Modelo "travando na execução" — watchdog contra stream parado (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`)

**Sintoma (recorrente, relatado com prints + .mht):** no meio de uma resposta
longa (Z.ai GLM 5.2, esforço Máx, ~42 etapas de ferramenta), o texto PARA no
meio de uma frase e a interface fica em "Raciocinando..." para sempre. O app
nunca entrega a resposta nem mostra erro — falha grave: "o básico é responder".

**Causa raiz (diferente das anteriores):** nenhuma das 3 vias de streaming do
backend (`loop.js`, `multiModel.js`, `orchestrator.js`) tinha proteção contra
um provedor que PARA de enviar dados SEM fechar a conexão (upstream congelado,
proxy que engoliu a resposta, rede móvel). O `for await (chunk of stream)`
fica pendurado indefinidamente: nenhum erro é lançado, então TODA a máquina de
recuperação que já existia (retry com STREAM_RESUME_NOTE, fallback de modelo,
PROVIDER_TIMEOUT_NOTICE) nunca é acionada. O heartbeat `: ping` de 15s mantém
o SSE "vivo", então o frontend também não percebe nada. NÃO confundir com os
bugs anteriores: limite de etapas (PR #58, outro sintoma — mensagem de limite)
e re-render travando a UI (PR #60, a resposta chegava mas a tela engasgava).

**Correção:**
- `backend/src/agent/streamGuard.js` — **novo, puro (não importa openai =
  testável em qualquer ambiente)**. `guardStreamStall(stream, {timeoutMs,
  onStall})`: repassa os chunks; se NENHUM chegar em `STREAM_STALL_TIMEOUT_MS`
  (padrão 180s, piso 30s — generoso porque modelos de raciocínio podem ficar
  minutos "pensando" sem emitir texto), chama `onStall()` (aborta a requisição
  com reason `'stall'`) e lança `StreamStalledError` (code `STREAM_STALLED`).
  O timer só corre ENQUANTO se espera o próximo chunk (pausa do usuário e
  processamento do corpo do loop não contam). No `finally`, fecha o iterator
  subjacente (break/stop não vaza conexão) e faz catch da promise pendente
  (sem unhandled rejection). Também exporta `PROVIDER_CONNECT_TIMEOUT_MS`
  (padrão 180s): passado como `timeout` nas chamadas de streaming `create()`
  — o padrão do SDK é 10 min até os headers, longo demais.
- `backend/src/agent/provider.js` — `isRetryableStreamError` reconhece
  `code==='STREAM_STALLED'` e as mensagens "stream stalled"/"request timed
  out". Assim o stall cai na recuperação NORMAL: retomar de onde parou (até
  STREAM_RECOVERY_LIMIT), depois modelo de reserva, depois aviso honesto — a
  resposta parcial é SEMPRE salva e entregue.
- `backend/src/agent/loop.js`, `multiModel.js` (participante + coordenador),
  `orchestrator.js` (coordenador) — os 4 `for await` de streaming embrulhados
  no guard, com `onStall: () => activeRequest.abort('stall')`; `timeout` de
  conexão nos `create()` de streaming. O abort com reason `'stall'` NÃO é
  confundido com pause/stop do usuário (`controlInterruptReason` devolve
  'abort' → caminho retryável).
- `frontend/src/hooks/useChat.js` — watchdog espelho no SSE: o servidor manda
  `: ping` a cada 15s; se NADA chegar por 60s (`SSE_STALL_MS`), a conexão
  morreu em silêncio → `reader.cancel()` + throw, e o fluxo cai na reconexão
  automática já existente (`reconnectLiveRun`/`followActiveConversation`), que
  remonta o balão pelo replay. Antes, um SSE morto sem FIN deixava a tela
  travada mesmo com o backend saudável.
- `.env.example` — documenta `STREAM_STALL_TIMEOUT_MS` e
  `PROVIDER_CONNECT_TIMEOUT_MS`.

**Validação:** `backend/src/agent/streamGuard.test.js` (6 testes: repassa
chunks, stall lança e chama onStall preservando o texto já recebido, timer não
corre durante o processamento do chunk, break fecha o stream, erro do provedor
propaga intacto, pisos de config). Suíte backend completa: **135 passam, 0
falham, 2 skips pré-existentes** (com `npm install --ignore-scripts`; sharp
segue bloqueado pelo proxy deste ambiente). Frontend: `node --test` 7/7 +
`npm run build` OK (dist/ recompilado e commitado — é versionado). NÃO deu para
reproduzir um stall real de provedor neste ambiente; validar em produção
deixando uma tarefa longa rodar (o pior caso agora é: 3 min de silêncio →
retomada automática; se o provedor seguir mudo → modelo de reserva → aviso
honesto com o parcial salvo, nunca mais "Raciocinando..." infinito).

## 📸 Miniatura real de página: navegador headless no backend (2026-07-21 — branch `claude/unified-ai-execution-session-25rm4h`, PR #60)

Pedido: "instale um navegador headless" para gerar a MINIATURA real da página
(o item que ficou de fora no PR #60 inicial, que só mostrava endereço + texto).
Agora, quando a IA abre uma página com `web_fetch`, o backend renderiza a página
num Chromium headless e salva um screenshot, exibido no painel de detalhe do
Ambiente de Trabalho.

**Arquivos:**
- `Dockerfile` (raiz) — instala `chromium` + `fonts-liberation` via apt e define
  `ENV CHROMIUM_PATH=/usr/bin/chromium`. **A imagem fica ~alguns 100 MB maior.**
- `backend/package.json` — adiciona `puppeteer-core` (usa o Chromium do sistema;
  NÃO baixa navegador). **⚠️ `package-lock.json` não foi regenerado** (sem rede
  neste ambiente); o Dockerfile usa `npm install` (não `npm ci`), então resolve
  na build. Rodar `npm install` na VPS/local atualiza o lock.
- `backend/src/agent/pageShot.js` — **novo**. Navegador compartilhado (singleton
  com auto-close após 1 min ocioso), `captureThumbnail(url, destPath)`. É
  **best-effort**: import dinâmico do puppeteer-core em try/catch, checa
  `CHROMIUM_PATH` existe; qualquer falha/timeout → retorna false e o `web_fetch`
  segue só com o texto. **SSRF:** interceptação de requisições aborta QUALQUER
  host bloqueado por `isBlockedHost` (mesma regra do web_fetch), inclusive em
  redirecionamentos/JS da página. Viewport 1024×640, JPEG q55, timeout 9s.
- `backend/src/tools.js` — no `runTool`, o `web_fetch` chama `captureThumbnail`
  após o fetch (URL final já validada) e grava em `<ws>/.thumbs/<id>.jpg`,
  devolvendo `thumb` (caminho relativo) no resultado. Import de `captureThumbnail`
  (import circular com pageShot.js → OK, uso só em runtime; testado isolado).
- `backend/src/agent/loop.js` — extrai `thumb` do resultado do web_fetch e manda
  num campo SEPARADO no evento `tool_result` (o `content` é cortado em 2000 chars
  e o caminho poderia se perder).
- `frontend/src/hooks/useChat.js` — guarda `ev.thumb` no bloco da ferramenta.
- `frontend/src/components/ExecutionSession.jsx` — `ResultView` do navegador
  mostra a miniatura clicável (abre em tamanho real) acima do endereço/texto.
- `frontend/src/styles.css` — `.esShot`.
- `.env.example` — documenta `CHROMIUM_PATH`, `WEB_FETCH_SCREENSHOTS` (0 desliga),
  `SCREENSHOT_TIMEOUT_MS`.
- `README.md` — nova linha na tabela de recursos (Ambiente de Trabalho da IA),
  nota de arquitetura sobre o Chromium headless e as 3 variáveis novas na tabela
  de variáveis.

**Decisões:**
- **puppeteer-core + Chromium do apt** (não playwright, não puppeteer completo):
  mais leve e é o caminho clássico p/ "screenshot com Chromium do sistema" em
  Docker. `--no-sandbox --disable-dev-shm-usage` (sem /dev/shm grande no
  container). Navegador reaproveitado entre capturas e fechado no ócio p/ poupar
  RAM da VPS.
- **Miniatura por página, não por pesquisa:** só o `web_fetch` (abrir página)
  gera screenshot; `web_search` (lista de links) não.
- **Custo:** cada `web_fetch` passa a renderizar a página (fetch de texto + render
  no browser). Timeout curto e best-effort limitam o impacto; `WEB_FETCH_SCREENSHOTS=0`
  desliga tudo se a VPS ficar apertada.

**Validação:** `node --check` nos 3 arquivos backend + repro isolado do import
circular e do guard SSRF (público passa, localhost bloqueia). Frontend: `build`
OK + `node --test` (7). **Não** dá p/ testar a captura real aqui (backend sem
deps — proxy bloqueia `npm install` de `openai`/`sharp` com 403). Quem valida de
fato é a build da VPS; conferir na tela após o deploy que a miniatura aparece.

## ⚡ Ambiente de Trabalho da IA: fluidez + prévia de arquivo/imagem/página (2026-07-21 — branch `claude/unified-ai-execution-session-25rm4h`, follow-up do PR #59)

Continuação do #59 (que já está na `main`). Dois pedidos: **(1)** a interface
estava "travando / demorando a atualizar" — não parecia orgânica; **(2)** faltava
a prévia do conteúdo do arquivo / miniatura da imagem / prévia da página no painel
de detalhe. Como o #59 já foi mesclado, este trabalho recomeçou do `origin/main`
no mesmo nome de branch (abre um PR novo).

**(1) Fluidez — o que travava e o que mudou:**
- **Causa raiz:** enquanto a IA responde, o app re-renderiza a cada token (delta)
  e a cada 1s (relógio de `useChat`). Sem memo, TODA mensagem — incluindo o
  `ReactMarkdown` com `rehype-highlight` (recolore blocos de código) de mensagens
  antigas — era re-parseada a cada tique. Era isso que engasgava, sobretudo no
  celular.
- **Correções (`frontend/src/App.jsx`):** novo componente `MessageText` embrulhado
  em `React.memo` (compara pelo texto) — o markdown só reprocessa o que mudou de
  fato. Toda renderização de markdown do chat passou a usá-lo.
- **`frontend/src/components/ExecutionSession.jsx`:** `ExecutionSession` agora é
  `React.memo` com comparador `sameSteps` (compara nº de etapas + status/ended/
  result de cada uma). Como `toolSteps` é recriado a cada render (`.filter`),
  comparar por identidade não bastava — por isso o comparador por conteúdo.
  O relógio virou estado interno (`now`) que só corre quando `live`, em vez de
  depender do `nowTick` do pai (prop `nowTick` removida). No overlay, os
  `useEffect` de auto-seguir/rolar passaram a depender de primitivos
  (`runningIdx`, `steps.length`, `follow`) e não da identidade do array — antes
  disparavam a cada render.
- **CSS (`frontend/src/styles.css`):** transições suaves no cartão/etapas, pulse
  discreto no cartão "ao vivo", fade/rise no overlay, com guarda
  `prefers-reduced-motion`.

**(2) Prévia rica no painel de detalhe:**
- **Backend (`backend/src/agent/loop.js`):** o `write_file` só devolvia `{ok,path,
  size}` (sem conteúdo). Agora o `tool_start` leva também `detail` = conteúdo
  escrito (até 4000 chars) — única mudança de backend, aditiva. `useChat.js`
  guarda `detail` no bloco da ferramenta.
- **Frontend (`ExecutionSession.jsx`, novo `ResultView`):** o resultado é
  parseado e formatado por categoria — **imagem** (`generate_image.saved`) vira
  miniatura clicável (usa `API` + `/download/`); **pesquisa** vira lista de
  resultados (título/resumo/link); **navegador** (`web_fetch`) mostra o endereço
  clicável + prévia do texto da página; **terminal** (`bash`/`run_python`) mostra
  a saída como console (erro se `exitCode≠0`); **leitura**/**lista** mostram
  conteúdo/arquivos; **gravação** mostra o conteúdo salvo + confirmação.
- **Miniatura real de página (screenshot) NÃO foi feita:** `web_fetch` retorna só
  texto; um thumbnail exigiria um navegador headless no backend. Em vez disso, a
  "prévia da página" é endereço + excerto do texto. Fica como possível evolução.

**Persistência:** os `blocks` (etapas) NÃO são salvos no banco — só existem ao
vivo e no replay do stream (reconexão). Ao recarregar do zero, a mensagem mostra
só o texto final (conversa limpa). Comportamento intencional, mantido.

**Validação:** `npm run build` (vite) OK; `node --test src/*.test.js` do frontend
passa (7). Backend: `node --check src/agent/loop.js` OK e o diff é aditivo; os
testes que importam `openai` não rodam NESTE ambiente (proxy bloqueia instalar
`openai`/`sharp` com 403) — quem valida de fato é o build da VPS. Detalhe visual
(pesquisa, terminal, código, navegador, cartões) conferido em preview antes do
commit.
## 🧑‍💻 Reformulação do Modo Desenvolvedor — ambiente dedicado, 6 modos e memória por projeto (2026-07-21 — branch `claude/developer-mode-redesign-b41nz8`)

**Motivação:** o Modo Desenvolvedor parecia amador — "só uma opção que
redirecionava o pedido para uma conversa comum", sem ambiente próprio. O pedido
era aproximá-lo de Codex/Claude Code (área independente, projetos, ferramentas,
memória e fluxo próprios), mantendo compatibilidade com os modelos do OpenRouter.

**O que mudou (backend):**
- `backend/src/agent/prompts.js` — `developerContextFor` passou de 3 para **6
  modos**: `ask` (Perguntar), `plan` (Planejar), `build` (Implementar), `fix`
  (Corrigir erro), `review` (Revisar) e `auto` (Agente autônomo). Exporta
  `DEV_MODES` e `DEV_WRITE_MODES`. Só `build/fix/auto` escrevem (retorna
  `canWrite`); `ask/plan/review` são leitura (`readOnlyProject`). Modos que
  executam agora exigem **plano antes de editar** (`PLAN_BEFORE`: entendimento,
  arquivos, mudanças, riscos, validação) e **resumo profissional ao final**
  (`FINAL_SUMMARY`: alterações, arquivos, testes/resultados, problemas,
  pendências, próximos passos). O modo `fix` orienta buscar a **causa raiz**.
- `backend/src/agent/loop.js` — o gating das ferramentas de escrita do GitHub
  (`github_push`/`github_create_pr`) deixou de olhar `mode !== 'build'` e passou
  a usar `!developerContext.canWrite` (cobre `fix`/`auto`). Regra do `write_file`
  segue por `readOnlyProject` (respeita a permissão da pasta do PC).
- `backend/src/agent/prompts.dev.test.js` — novo teste dos 6 modos, permissões e
  presença de plano/resumo. **Suíte backend: 122 passam, 0 falham, 2 skips
  pré-existentes.**

**O que mudou (frontend):**
- Novo hook `frontend/src/hooks/useDevProjects.js` — **projetos** persistidos no
  navegador (`fred_dev_projects_v1`): nome, descrição, tecnologias, vínculo
  (pasta do PC ou repositório GitHub), regras e **memória permanente**
  categorizada (`MEMORY_FIELDS`: arquitetura, decisões, padrões, problemas
  corrigidos, preferências, próximas etapas). `projectContextText()` compõe
  regras + memória e envia pela via `rules` (que já chega ao system prompt), então
  a IA "lembra" do projeto sem o usuário reexplicar. O contexto do projeto não se
  mistura com conversas comuns.
- Duas colunas recolhíveis no espaço "Desenvolvedor", ao redor do chat (sem
  reescrever o motor de chat): `components/DevProjectRail.jsx` (**Explorador** —
  projeto ativo, vínculo/permissão e arquivos da tarefa via
  `/api/conversations/:id/files`) e `components/DevActivityRail.jsx`
  (**Atividade** em tempo real reaproveitando o "Ambiente de Trabalho da IA" +
  editor da **memória do projeto**).
- `frontend/src/DeveloperPanel.jsx` redesenhado como **lançador**: seleção/criação
  de projeto, campos do projeto, vínculo (pasta/GitHub + branch), seletor visual
  dos 6 modos com selo leitura/escrita e o fluxo de cada modo. Exporta
  `DEV_MODE_ICON`.
- `frontend/src/constants.js` — `DEV_WORK_MODES` (espelha o backend).
- `frontend/src/App.jsx` — hook de projetos, render das colunas no workspace
  `developer`, barra superior ciente do projeto/modo, `startDeveloperTask` compõe
  regras+memória e mapeia o vínculo para `projectId`/`github`, e vincula a
  conversa ao projeto no 1º envio.
- `frontend/src/styles.css` — grid de 4 colunas do ambiente
  (`barra lateral · explorador · chat · atividade`), estilos das colunas,
  explorador, atividade, memória e cartões de modo; colunas somem em telas
  ≤1180px (a entrada continua pelo painel). Tudo por variáveis de tema.

**Verificação:** `npm run build` (frontend) OK; testes backend 122/122 e
frontend 7/7 verdes. **Não** houve teste de UI ao vivo (sem Docker/servidor
neste ambiente).

**Escopo consciente (para as próximas iterações):** editor de código e terminal
como painéis "de verdade" precisariam de endpoints novos para servir/gravar
arquivos do host (hoje a execução é num sandbox Docker por conversa) — por isso o
trabalho real da IA aparece no painel de Atividade e no "Ambiente de Trabalho",
não num editor que não gravaria nada. Memória por projeto é persistida no
cliente e injetada em toda tarefa; uma indexação semântica por projeto no backend
é o passo natural. Ainda em aberto: pontos de restauração/desfazer, permissões
por ação com toggles e repasse do contexto de desenvolvedor às tarefas em
segundo plano.
## 🧩 Sistema Multimodelo — 2+ IAs na mesma mensagem (2026-07-21 — branch `claude/multimodelo-system-h8t0tb`)

**Pedido:** usar dois ou mais modelos de IA simultaneamente na mesma conversa —
não só duplicar a pergunta, mas colaborar/comparar/revisar/sintetizar — com
função por modelo, controle de custos e presets de equipes (spec completa do
usuário em 16 seções).

**O que foi implementado (funcional de ponta a ponta):**
- **Motor novo** `backend/src/agent/multiModel.js` (`runMultiModel`): cada
  participante é uma chamada INDEPENDENTE ao provedor (modelo distinto), com
  streaming individual (eventos SSE `mm_start`/`mm_status`/`mm_delta`/
  `mm_reset`/`mm_round`/`mm_done`), status por modelo (aguardando → analisando →
  respondendo/revisando → concluído/interrompido/erro), tokens, custo e tempo.
  NÃO confundir com o Modo Equipe (`orchestrator.js` = vários ASSISTENTES no
  mesmo modelo) nem com fallback (disponibilidade) — são recursos separados.
- **4 modos:** `compare` (paralelo, lado a lado; a mensagem salva é a junção em
  seções), `council` (paralelo + coordenador consolida concordâncias/
  divergências/erros; síntese streamada como texto principal), `debate` (até 3
  rodadas: cada modelo lê os outros, critica e REESCREVE a própria resposta;
  coordenador fecha) e `pipeline` (sequencial: cada etapa recebe o que as
  anteriores produziram; no Modo Desenvolvedor a 1ª etapa com papel
  implementador/código executa DE VERDADE via `runAgent` com ferramentas, e as
  etapas seguintes revisam — a revisão vira um 2º balão salvo).
- **12 papéis prontos** (`MULTI_ROLES`): principal, revisor, pesquisador,
  código, arquiteto, implementador, segurança, testador, tributário, contábil,
  jurídico, livre — cada um com system prompt próprio; o usuário pode
  sobrescrever com prompt customizado por participante.
- **Custos:** estimativa ANTES do envio no frontend (`estimateMultiCost`, usa
  `price`/`priceOut` do catálogo — `priceOut` é campo NOVO em
  `modelCapabilities.js`), orçamento máximo em US$ com interrupção automática
  (`budgetUsd` → `budgetExceeded`), teto de tokens por modelo (`max_tokens`),
  teto de 6 modelos e 3 rodadas (env `MULTI_MAX_MODELS`/`MULTI_MAX_ROUNDS`),
  alerta $$$ para modelos caros. Custo REAL por modelo gravado no meta.
- **Contexto por política** (`context`): `recent` (padrão, ~8 msgs), `full`
  (~30 msgs), `summary` (usa `conversations.summary_long/short`; sem resumo cai
  para recent) e `none` — o orquestrador decide o que cada modelo recebe, nunca
  o histórico inteiro por padrão.
- **Cancelar UM modelo só:** `POST /conversations/:id/multimodel/cancel {slot}`
  (registro `slotRegistries` por conversa aborta só os AbortControllers daquele
  slot); pausar/continuar/parar geral continuam valendo para tudo (mesmo
  `control` de sempre).
- **Persistência:** coluna nova `messages.multi_meta` (migração
  `006_multimodel.sql`) guarda o JSON por modelo (status/texto/usage/custo/
  tempo) — o GET da conversa devolve como `m.multi` e a interface remonta os
  cartões ao reabrir. Se o JSON passar de 200k, regrava com textos encurtados
  (nunca `.slice()` cego que quebraria o JSON).
- **Presets ("equipes"):** tabela `model_teams` + rotas `GET/POST/DELETE
  /api/model-teams` (máx. 30 por usuário; config re-normalizada no POST).
- **Frontend:** `MultiModelPicker.jsx` (botão na topbar ao lado do
  ContextPicker: modo, modelos+funções, coordenador, rodadas, contexto,
  orçamento, estimativa, equipes salvas; estado em `localStorage
  fred_multimodel`; ligar multimodelo DESLIGA o Modo Equipe — o backend dá
  prioridade ao multimodelo) e `MultiModelBoard.jsx` (cartões por modelo nas
  mensagens com ações: copiar uma resposta, "continuar com este" (troca o
  modelo principal e desliga o multi), "pedir revisão" (pré-preenche o campo),
  "combinar respostas", parar um modelo). No render, modos `compare`/`pipeline`
  NÃO repetem o `content` (o quadro já mostra tudo); `council`/`debate` mostram
  quadro + síntese.
- **Validação:** schema zod `multiModel` no `chat` (validation.js) +
  normalização de verdade em `normalizeMultiModelConfig` (menos de 2 modelos
  válidos → null → fluxo normal de 1 modelo segue intacto).

**Testes/validação:** `backend/src/multiModel.test.js` (7 testes: normalização
e custo); 125 testes de backend passando; build do Vite OK. NÃO houve teste de
UI ao vivo (sem Docker/Postgres nesta sessão) — validar em produção o fluxo
completo com chave OpenRouter real.

**Fora do escopo desta entrega:** "escolher automaticamente o melhor modelo"
(seção 6 da spec) — exigiria um classificador/roteador próprio; o restante da
spec está coberto.

## 🔄 Catálogo de modelos por usuário — OpenRouter voltando a aparecer (2026-07-20 — branch `claude/openrouter-models-sync-wp1krw`)

**Sintoma relatado:** "modelos do OpenRouter que não aparecem no app" — dúvida se
era falta de sincronização.

**Causa-raiz (não era sincronização):** a rota `GET /api/models`
(`backend/src/routes/models.js`) buscava o catálogo SEMPRE com a `base_url` e a
chave do **servidor** (`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` do `.env`),
ignorando o provedor **BYOK de cada usuário**. Como a produção roda
`ALLOW_SHARED_KEY=false` (sem chave de servidor) e o default da base é o DeepSeek,
um usuário com chave própria do OpenRouter recebia um catálogo que NÃO era o dele
(no pior caso, pouquíssimos modelos). Havia ainda um **cache global único**
(`modelsCache`/`modelsCacheAt`) compartilhado entre todos os usuários,
independentemente do provedor de cada um.

**Correção:**
- `backend/src/routes/models.js`: a rota agora resolve
  `getUserProvider(req.userId)` e busca o catálogo na MESMA `base_url`/chave que o
  usuário usa para conversar (o mesmo provider do chat). O cache virou um `Map`
  por chave: `u:<userId>` para quem tem chave própria (o catálogo pode variar por
  conta) e `s:<base>` para quem usa a chave compartilhada do servidor. TTL de 10
  min mantido. Fetch cru preservado (não usa `client.models.list()`) para garantir
  que os campos extras do OpenRouter — `architecture`, `pricing`,
  `supported_parameters` — cheguem intactos ao `registerModelCatalog`
  (é deles que sai a detecção de ferramentas/visão/raciocínio).
- `backend/src/userProvider.js`: `getUserProvider` passou a expor `apiKey` (chave
  crua) no objeto de retorno — uso interno no servidor, para a rota autenticar a
  listagem no provedor do usuário. Aditivo; nenhum consumidor existente muda.

**Verificação:** endpoint real do OpenRouter retorna **339 modelos**; o backend
não descarta nenhum (só exige `id`) e `registerModelCatalog` produz os 339
perfis. `node --check` OK nos dois arquivos; nenhum teste dependia da rota antiga.
NÃO houve teste de UI ao vivo (sem Node/Docker no host desta sessão).

**Não era bug do app (para triagem futura):** cache de 10 min atrasa modelos
recém-adicionados; a aba "Recomendados" do seletor mostra só ~6 (catálogo inteiro
fica na aba "Catálogo"); o "modelo padrão do assistente" e o objetivo "Trabalho
geral" escondem de propósito os ~71 modelos SEM ferramentas (geradores de
imagem/áudio, safety); e a política de dados/provedores da própria conta OpenRouter
pode bloquear modelos na hora de usar ("No endpoints found").

## 🛠️ Modo desenvolvedor / tarefa longa parava no "limite de etapas" (2026-07-20 — branch `claude/dev-mode-long-tasks-issue-dkjnfp`)

**Sintoma:** toda tarefa longa (e todo uso do modo desenvolvedor) morria com
_"Atingi o limite de 60 etapas… dificuldade de extrair os dados… peça em CSV"_,
independente do esforço escolhido. Correções anteriores (aumentar o número) não
resolviam.

**Causa real (2 problemas somados):**
1. `loop.js` calculava `maxSteps = Number(process.env.AGENT_MAX_STEPS || eff.steps)`.
   Como o `.env` tinha `AGENT_MAX_STEPS=30` (vindo do `.env.example`), o **env
   sobrescrevia e cortava em silêncio** o esforço do menu — escolher "Máx" (=60 no
   código) virava 30, e mexer no número do código não tinha efeito. Esse era o "pode
   ser outro problema" que o usuário intuiu.
2. Cada etapa = um turno do modelo (≈uma ferramenta). 60 é pouco para programação
   (clonar → ler dezenas de arquivos → escrever migration/routers/componentes). Ao
   bater o limite, tudo era abortado com uma mensagem **errada** (falava de CSV numa
   tarefa de código) e sem dizer como retomar.

**Correção (`backend/src/agent/loop.js`, `.env.example`):**
- `AGENT_MAX_STEPS` vira **PISO, não teto**: `Math.max(eff.steps, envSteps)`. "Máx"
  vale ≥60 mesmo com env baixo. **NUNCA** voltar a `env || eff.steps`.
- Modo desenvolvedor: orçamento maior via `AGENT_DEV_MAX_STEPS` (padrão 200).
- Teto absoluto `AGENT_HARD_MAX_STEPS` (padrão 1,5× o base): tarefa que **ainda
  rende** (ferramenta ok há ≤2 etapas, rastreado por `lastProductiveStep`/`IDLE_STEP_GRACE`)
  passa do orçamento base até o teto em vez de morrer no meio; se estagnar, encerra.
  Travas de falha (5 seguidas), repetição e pesquisa web **inalteradas**.
- Mensagem de limite honesta e retomável (**Reenviar**), sem o texto de CSV.
- `.env.example`: `AGENT_MAX_STEPS=` em branco (esforço manda), `AGENT_DEV_MAX_STEPS=200`,
  `AGENT_HARD_MAX_STEPS=` documentados.

**Ação de deploy:** conferir o `.env` da VPS — se tiver `AGENT_MAX_STEPS=30`, deixar
em branco para o esforço do menu mandar (agora é inofensivo, mas confunde). Backend-only,
validado com `node --check`.

## 🖥️ Ambiente de Trabalho da IA: execução agrupada em uma sessão (2026-07-20 — branch `claude/unified-ai-execution-session-25rm4h`, PR #59)

Antes, cada chamada de ferramenta virava um cartão solto **"bash 0s"** no chat.
Numa tarefa real, dezenas empilhavam — poluíam a conversa, ocupavam a tela toda
(pior no celular) e não diziam o que a IA fazia (todos com o mesmo nome, sem
contexto). Agora **todas as ferramentas de uma resposta são agrupadas numa única
sessão de execução** (o *Ambiente de Trabalho da IA*).

**Como fica:**
- **Cartão compacto no chat** — enquanto trabalha: "IA trabalhando no projeto" +
  etapa atual + `N etapas · N arquivos · tempo` + botão **Abrir ambiente de
  trabalho**. Ao terminar: "Tarefa concluída" + resumo (`N arquivos · N comandos ·
  nenhum erro · tempo`) + botão **Ver detalhes**.
- **Janela expandida** (overlay em tela cheia) — barra de estatísticas; filtros
  por tipo (Terminal · Código · Arquivos · Pesquisa · Navegador); lista de etapas
  humanizadas com ícone por categoria e status (concluída/executando/erro); etapa
  em execução destacada e acompanhada ao vivo; painel de detalhe com a entrada
  (comando/arquivo/consulta/URL) e o resultado de cada ação. Fechar (X) minimiza
  de volta ao cartão.

**Arquivos:**
- `frontend/src/components/ExecutionSession.jsx` — **novo**. `ExecutionSession`
  (cartão compacto) + `WorkspaceOverlay` (janela ao vivo). Mapa `TOOL_META`
  traduz cada ferramenta (`bash`, `run_python`, `write_file`, `read_file`,
  `list_files`, `zip_outputs`, `web_search`, `web_fetch`, `generate_image`,
  `consultar_cnpj`) → categoria + rótulo humano; fallback genérico para nomes
  desconhecidos.
- `frontend/src/App.jsx` — no render das mensagens, os blocos `type:'tool'` são
  agrupados numa só `<ExecutionSession>` (posicionada no 1º bloco de ferramenta);
  o texto continua inline. Removido o `import { ToolStep }` (agora só o
  `ExecutionSession`). `live = busy && última mensagem` OU alguma etapa `running`.
- `frontend/src/styles.css` — bloco novo no fim (`.esCard*`, `.esOverlay`,
  `.esWindow`, `.esSteps`, `.esStep*`, `.esDetail*`, `.esFilters`, etc.), com
  media query `max-width:640px` (janela em tela cheia; lista vira faixa superior).

**Decisões:**
- **`ToolStep` (em `components.jsx`) foi mantido** como export, só deixou de ser
  usado — remover era risco desnecessário. Se ninguém mais consumir, pode sair
  depois.
- A janela **reconstrói** terminal/arquivos/pesquisa/navegador a partir dos
  eventos que o backend JÁ emite por ferramenta (`tool_start` com `preview` e
  `tool_result` com `content` até 2000 chars, ver `backend/src/agent/loop.js`).
  **Não** é streaming byte-a-byte de terminal real. Nenhuma mudança de backend
  foi necessária — só apresentação. Evolução futura: o backend mandar preview do
  conteúdo do arquivo editado / miniatura da página aberta para enriquecer o
  painel de detalhe.
- Mostra só ações **operacionais observáveis** — nunca o raciocínio interno do
  modelo, conforme pedido.

**Validação:** `npm run build` (vite) compila sem erros e `node --test src/*.test.js`
passa (7 testes). Layout dos três estados conferido em preview visual (dark) antes
do commit. O `dist/` é versionado neste repo, então foi recompilado e commitado
junto. Falta a conferência visual em produção após o deploy da VPS.

## 🏷️ Logos de provedor no seletor de modelos (2026-07-20) — NÃO VALIDADO LOCALMENTE

Cada modelo da lista mostra o logo oficial do provedor antes do nome, e o filtro
**Fornecedor** virou um dropdown próprio com os mesmos logos (o `<select>` nativo
não renderiza imagem).

**Arquivos:**
- `frontend/public/providers/*.png` — 18 logos (164 KB). A pasta `public/` não
  existia no projeto; foi criada agora. O `vite build` copia o conteúdo dela para
  o `dist/`, então os logos entram na imagem de produção (conferido no
  `frontend/Dockerfile`: `COPY . .` + `npm run build`, e `.dockerignore` não
  exclui `public/`).
- `frontend/src/components/ProviderIcon.jsx` — mapeia a família (prefixo do id
  do modelo) → arquivo local; sem logo conhecido, cai num monograma (a inicial).
- `frontend/src/components/FamilySelect.jsx` — dropdown de Fornecedor com logo.
- `frontend/src/styles.css` — bloco novo no fim (`.mpProvIcon`, `.mpProvMono`,
  `.mpFamSelect`, `.mpFamBtn`, `.mpFamPanel`, `.mpFamOpt`).
- `frontend/src/components.jsx` — 3 edições: os 2 imports, `<ProviderIcon>` como
  primeiro filho do `.mpItem` na `row`, e o `<select>` de Fornecedor → `<FamilySelect>`.

**Decisão: os logos são LOCAIS, não CDN.** O patch original puxava de
`https://unpkg.com/@lobehub/icons-static-png@latest/dark/<slug>.png`. Descartado:
tag `@latest` de CDN quebra sozinha sem aviso (mesma razão do item 11 da seção 6),
e asset de terceiro entrega o IP de cada visitante do app a quem hospeda a CDN —
o que num site público com login e LGPD é pior do que os 164 KB economizados. Os
PNGs saíram do protótipo `Seletor de Modelo (offline).html`; arte do conjunto
estático da LobeHub, variante *dark* (ícone claro) — por isso o ladrilho
`.mpProvIcon` é escuro fixo (`#161c2b`) em todos os temas, inclusive nos claros.

**⚠️ NÃO VALIDADO LOCALMENTE — a seção 7 exige `vite build` antes de commitar, e
não deu:** não há Node instalado no host (só dentro do container) e o Docker local
está desativado desde que o app foi para a VPS. A conferência foi ESTÁTICA: JSX
balanceado, variáveis CSS usadas existem (`--r-sm`, `--r-md`, `--panel`,
`--panel2`, `--line`, `--fs-xs`, `--accent`, `--muted`, `--text`) e o `.mpItem` já
é `flex-direction:row; align-items:center`, que é o que joga o ícone para a
esquerda. **Quem validou de fato foi o `npm run build` da VPS** no deploy — se
estiver lendo isto e o build passou, o código compila; resta o visual.

**Pontos observados na tela:**
1. **Risco de corte no dropdown de Fornecedor — RESOLVIDO (2026-07-20).** O
   `.mpFamPanel` deixou de ser `position:absolute` dentro do `.mpPanel`
   (`overflow:hidden`) e passou a `position:fixed` ancorado ao botão via
   `getBoundingClientRect()`, com estilo inline calculado em `FamilySelect.jsx`.
   Agora ele **escapa do clipping** do painel e **vira para cima** quando falta
   espaço embaixo (`maxHeight` ajustado ao espaço disponível), então a lista
   nunca é cortada na borda do painel nem sai da viewport. Fecha em
   scroll/resize (o menu fixo se soltaria do botão que rola junto); o
   `scroll` é capturado (`true`) para pegar também contêineres internos. O CSS
   mantém um fallback `absolute` caso o cálculo de posição não rode. Validado
   com `vite build` (passa).
2. **Microsoft (Phi) e Nous** não têm logo no conjunto — caem no monograma.

**Deploy é na VPS** (`fredericostudio.com.br`), não mais local: `bash atualizar.sh`
lá dentro, que faz `git pull` da `main` + rebuild. Instrução de `docker restart`
no frontend é resquício do setup antigo de desenvolvimento e NÃO se aplica —
em produção o frontend é bundle estático servido pelo Caddy (serviço `web`).

## 🔄 Processamento contínuo: sair/voltar sem perder o andamento (2026-07-20 — branch `claude/chat-async-continuous-processing-un1xho`, PR #54)

O chat agora é um **fluxo contínuo de verdade**: o processamento roda no servidor
independentemente da conexão do front. Se o usuário sai da página, minimiza no
celular, troca de aba ou perde a rede, a tarefa NÃO para — e ao voltar (mesmo
dispositivo/sessão) ele **reconecta ao andamento ao vivo**, com os botões de
pausar/parar funcionando, como se nunca tivesse saído. Se a tarefa terminou
enquanto ele estava fora, a resposta completa aparece na hora.

> **Nota de integração:** esta frente foi **rebaseada sobre o PR #53** (a
> modularização grande: `server.js` → `routes/*`, `App.jsx` → `hooks/*`). Por
> isso as mudanças vivem nos módulos novos, não no monólito antigo.

**O que já existia (não regredir):** o backend já mantinha o run vivo após a
desconexão — o `send()` do POST `/chat` vira no-op quando o cliente some
(`clientGone`), mas `runAgent` continua e salva o resultado; heartbeat `: ping`
a cada 15s; só cancela na desconexão se `CANCEL_ON_DISCONNECT=true`.

**O que faltava e foi adicionado — reconexão ao andamento AO VIVO:**
- `backend/src/liveStream.js` (NOVO): pub/sub + buffer de replay por conversa, em
  memória. `openLiveStream(id)` abre no início do run; `publish(event)` guarda no
  buffer (teto 5000 eventos / 3 MB) e faz fan-out; `subscribe(fn, fromSeq)`
  reproduz o que já passou e assina os próximos; `finish()` segura o buffer por
  90s (carência p/ reconexão tardia). Testes: `liveStream.test.js`.
- `backend/src/routes/conversations.js`: o `send()` do POST `/chat` também faz
  `live.publish(event)`; `finally` chama `live.finish()`. Nova rota SSE
  **GET `/conversations/:id/stream`** (replay + ao vivo, sem disparar run).
  GET `/conversations/:id` agora devolve **`active`** (`isConversationActive`).
- `frontend/src/hooks/useChat.js`: consumo do SSE virou `consumeChatStream`
  (reusado no envio E na reconexão). `reconnectLiveRun` **remonta o balão do
  zero** (replay completo) para não duplicar; `followActiveConversation` religa
  se cair e no fim recarrega a versão canônica do banco. Exposto via
  `followActiveRef` (ponte entre hooks).
- `frontend/src/hooks/useConversations.js`: `openConversation` reconecta quando
  `data.active` e **restaura o modelo salvo** da conversa (antes o seletor caía
  no padrão ao reabrir — bug relatado no teste do celular).
- `frontend/src/App.jsx`: cria o `followActiveRef` e o passa aos dois hooks.

**Desenho (por que assim):** buffer em memória por processo (um único backend).
Se um dia houver réplicas, trocar por pub/sub compartilhado (Redis). A remontagem
do balão é sempre do zero no replay — mais simples e à prova de duplicação; o
`done` no fim reconcilia com o banco.

## 🏗️ Prioridades técnicas: pgvector, hardening HTTP, zod, CI e quick wins (2026-07-20, PR #53 — MERGEADO)

Implementação dos itens de alta prioridade + quick wins da revisão técnica:

**1. Busca semântica com pgvector (escala).** A busca de memórias/chunks
carregava TODAS as linhas do usuário na RAM do Node e calculava cosseno em JS.
Agora `backend/src/memory/vectorStore.js` habilita a extensão `vector`, cria
colunas `embedding_vec vector(384)` + índices **HNSW** e a busca vira
`ORDER BY embedding_vec <=> $query LIMIT n` no banco (searchMemories,
searchChunks e findSimilar em `memoryService.js`). Desenho (não regredir):
- O BYTEA `embedding` continua sendo a FONTE DA VERDADE (reindex/fallback);
  `embedding_vec` é projeção para o índice, espelhada em cada gravação
  (`saveEmbeddingVec`) e preenchida em segundo plano no boot (`backfillVectors`).
- **Fallback automático:** sem a extensão (postgres puro) ou com embeddings
  degradados, tudo segue no caminho JS antigo — nada quebra.
- Compose (dev e prod) agora usa a imagem `pgvector/pgvector:pg16`. Volume
  antigo do `postgres:16-alpine`: rodar `REINDEX DATABASE studio;` uma vez após
  a troca (alpine→debian muda a libc/collation; comentário no próprio compose).

**2. Hardening HTTP (server.js).** `helmet` (CSP desligada — o backend só serve
JSON/SSE), CORS restrito (o fallback `*` foi REMOVIDO; sem `FRONTEND_URL` /
`BETTER_AUTH_URL` nenhuma origem externa é aceita — produção e dev são
mesma-origem via proxy), `trust proxy = 1`, rate limit geral
(`RATE_API_PER_MIN`, padrão 600/min/IP) e limiter apertado SÓ nos POSTs de
`/api/auth` (`RATE_AUTH_PER_15MIN`, padrão 50/15min — o GET de sessão roda a
cada carregamento e não pode ser freado).

**3. Validação estruturada com zod (`backend/src/validation.js`).** Middleware
`validate(schema)` + schemas "loose" (campos desconhecidos passam) aplicados a
13 rotas de escrita (chat, tasks, assistants, clients, templates, memories,
schedules, control...). Mensagens em pt-BR (`z.config(z.locales.pt())`) no
formato `{ error }` que o frontend já entende. Testes em `validation.test.js`.

**Quick wins:** CI no GitHub Actions (`.github/workflows/ci.yml` — testes do
backend com glob `src/**/*.test.js`, testes + build do frontend, install com
`--ignore-scripts`); `ErrorBoundary` no frontend (tela amigável + recarregar em
vez de tela branca); healthcheck do backend nos dois compose (via `node -e
fetch`, a imagem não tem curl); retenção da tabela `usage`/`usage_daily`
(`USAGE_RETENTION_DAYS`, padrão 365, varredura diária em `privacy.js`);
`TERMS_VERSION` agora tem fonte única em `backend/src/privacy.js`, exposta em
`/api/health` (`termsVersion`) e lida pelas páginas legais do frontend
(o valor em `LegalPages.jsx` virou só fallback offline).

Validado: 102 testes backend + 7 frontend verdes, build de produção ok, boot
completo contra Postgres 16 real com pgvector (migrations + índice + backfill +
SQLs de busca com vetores sintéticos), cadastro/login reais exercitando os
validadores e o 429 do limiter de auth.

**Modularização (itens 4 e 7 — feita em seguida, na mesma branch/PR #53):**
- `server.js`: **1713 → 189 linhas.** As ~50 rotas foram movidas VERBATIM para
  15 routers por domínio em `backend/src/routes/` (account, models, assistants,
  pcFolders, inbox, clients, templates, memories, provider, connectors,
  analytics, conversations, tasks, schedules, backup). `routes/helpers.js`
  concentra o compartilhado: `makeRouter()` (o mesmo shim async de sempre —
  todo router NOVO deve usá-lo, nunca `Router()` cru), multer/antivírus,
  `loadAssistant`, `ensureConversation`, limite diário. O server.js ficou só
  com middlewares (segurança/auth/seed), montagem dos routers e boot. Os
  timers das rotinas agendadas agora são armados no boot (`startSchedulers()`),
  DEPOIS das migrations.
- `agent.js`: **2027 → 40 linhas** — fachada que re-exporta os mesmos 33
  símbolos; nenhum importador mudou. Código dividido em 10 módulos em
  `backend/src/agent/`: loop (652), prompts (334), outputs (332),
  orchestrator (293), repair (105), control (102, ÚNICO dono do estado de
  pausar/continuar/parar), webResearch (93), provider (71), vision (60),
  persistence (57). Extração mecânica conferida por diff multiset (zero linha
  alterada/perdida).
- Prompts DOCPRO (10 versões, ~430 linhas) extraídos para
  `backend/prompts/docpro/*.txt`; o novo `backend/src/seed.js` carrega
  `atual.txt` e usa os antigos SÓ para migrar assistentes com prompt padrão
  antigo. Para editar o prompt do DocPro: mexa em `atual.txt` e renomeie o
  anterior para `vN.txt` (o teste do qaFixes valida o valor carregado).
- `App.jsx`: **1822 → 1057 linhas.** Custom hooks em `frontend/src/hooks/`
  (useChat 248, useConversations 112, useFileUploads 103, useAssistants 91,
  useTasks 62, useSpeech 35) e subcomponentes em `frontend/src/components/`
  (ContextPicker, ClientPicker, MemoryTrace). O App continua dono do JSX e do
  estado de UI; hooks recebem dependências por parâmetro.
- Validação da modularização: 102 testes backend + 7 frontend verdes, build
  ok, boot real contra Postgres com smoke test de TODAS as rotas dos 15
  routers, lint no-undef zerado e verificação VISUAL com Playwright (landing,
  login real, aceite LGPD, chat carregado, página /privacidade com a versão
  dos termos vinda de /api/health) — sem nenhum erro de JS de página.

**Rodada de code review (10 achados verificados) + correções, na mesma branch:**
- COOP do helmet desligado (`crossOriginOpenerPolicy: false`): o header zerava
  o `window.opener` do popup OAuth do GitHub e o postMessage
  'fred-github-connected' nunca chegava ao painel.
- Recall do pgvector: novo `knnCandidates()` em vectorStore.js (único dono do
  SQL KNN) roda em transação com `SET LOCAL hnsw.ef_search` alto e
  `hnsw.iterative_scan='relaxed_order'` quando o pgvector ≥ 0.8 suporta
  (detectado em runtime). Se o índice devolver menos que `limit` candidatos
  (usuário pequeno ou truncamento pós-filtro), cai na varredura JS completa; e
  linhas SEM vetor (período degradado/backfill pendente) são varridas como
  RESÍDUO em JS e somadas ao resultado — nada fica invisível.
- `reindexAll()` sem userId agora reindexa TODOS os usuários (antes, o
  `WHERE user_id=?` com undefined→null não casava nada e a troca de modelo de
  embeddings "concluía" sem regravar um vetor sequer).
- `toVectorLiteral` avisa (uma vez, no log) quando a dimensão do embedding ≠
  vector(384) — a troca de EMBEDDING_MODEL não desliga mais o índice em
  silêncio. Índices HNSW + backfill agora rodam em SEGUNDO PLANO no boot (base
  restaurada sem índice não trava mais o app.listen).
- Limites do zod ajustados: orchestrateIds 20→100 (o modo Equipe manda todos os
  assistentes por padrão) e memória 20k→100k com mensagem própria em pt-BR.
- Validações manuais mortas removidas dos 6 routers (o zod é o único dono de
  tipo/tamanho; checagens de NEGÓCIO como isConversationId ficam no handler).
- `updateMemory` só regrava embedding_vec quando o conteúdo mudou (editar
  pin/importância não toca mais no índice HNSW).
- Inbox: regex gulosa que mutilava nomes com "_" trocada por casamento de
  comprimento fixo (`\d+_\d+_[\w-]{6}_`), na listagem e na conversão.
- Frontend: useTermsVersion usa `${API}/api/health` (respeita VITE_API_URL);
  deleteAssistant ganhou o guard Array.isArray de loadAssistants; payload do
  chat unificado num literal só (team via spread condicional).

Pendências da revisão que ficaram para depois (médio prazo): TypeScript
gradual, logs estruturados (pino), testes E2E permanentes no CI (a verificação
Playwright foi manual, no sandbox da sessão) e o `importStatus` global único do
indexer (um import por vez para o app inteiro, herdado do design mono-usuário).

## 🛡️ Antivírus nos uploads (ClamAV) + selos de segurança + hardening (2026-07-20, PR #50 — MERGEADO)

Todo arquivo enviado pelos usuários agora passa pelo **ClamAV** antes de ser
salvo — anexos do chat (`/api/conversations/:id/upload`), caixa de entrada
(`/api/inbox/:client/upload`) e importação de memória (`/api/memories/import`).
Arquivo infectado é recusado com o nome da ameaça; quando a varredura acontece,
a resposta traz `scanned:true` e o frontend mostra "✓ Arquivos verificados pelo
antivírus" (App.jsx/InboxPanel.jsx).

**Divulgação da segurança (pedido do usuário):**
- Tela de login (`LoginScreen.jsx` + `auth.css`, classe `loginTrust`): faixa de
  selos abaixo do cartão — "Arquivos verificados por antivírus", "Conexão
  criptografada" e "Compromisso com a LGPD" (este linka para `/privacidade`,
  página criada pela frente LGPD).
- Landing (`Landing.jsx`, bloco TRUST): 6 cartões em grade 3×2 — dados
  isolados, chave própria (BYOK), credenciais protegidas, **arquivos
  verificados (ClamAV)**, **conexão segura (HTTPS)** e **LGPD**.
- Regra de honestidade: só anunciar o que está ativo. Desativou o ClamAV?
  Remova o selo do login e o cartão da landing.

O PR #50 foi mesclado na main em 2026-07-20, já com a resolução do conflito
contra a frente LGPD (#47–#49) — as duas conviveram no mesmo dia e mexeram em
`server.js`, `LoginScreen.jsx`, `Landing.jsx` e neste arquivo. Deploy na VPS:
`bash atualizar.sh`; primeiro boot do clamav baixa assinaturas (~5 min).

**Desenho (não regredir):**
- `backend/src/clamav.js` fala o protocolo **INSTREAM** do clamd direto por TCP
  (sem dependência nova). Config por env: `CLAMAV_HOST` (vazio = desligado),
  `CLAMAV_PORT` (3310), `CLAMAV_TIMEOUT_MS`, `CLAMAV_REQUIRED`.
- **Fail-open de propósito:** se o clamd estiver fora do ar (ex.: baixando
  assinaturas no primeiro boot, ~5 min), o upload passa SEM verificação e com
  `scanned:false` — o app nunca trava por causa do antivírus. Quem quiser
  fail-closed usa `CLAMAV_REQUIRED=true` (recusa com 503).
- Produção: serviço `clamav` no `docker-compose.prod.yml`, ligado por padrão
  (`CLAMAV_HOST=${CLAMAV_HOST-clamav}` — a sintaxe `-` sem `:` permite
  desativar com `CLAMAV_HOST=` vazio no `.env`). Volume `clamav_db` persiste as
  assinaturas. RAM: ~1–1,5 GB (docs recomendam VPS de 4 GB).
- Dev: mesmo serviço sob `profiles: ["antivirus"]` — só sobe com
  `docker compose --profile antivirus up` + `CLAMAV_HOST=clamav` no `.env`.
- Se desativar o antivírus, retirar o cartão "Arquivos verificados" de
  `frontend/src/Landing.jsx` (não anunciar o que não existe).
- Testes: `backend/src/clamav.test.js` (clamd falso em TCP; roda com
  `node --test src/clamav.test.js`). Teste manual: arquivo EICAR (VPS-DEPLOY.md
  Passo 8.4).
- `VPS-DEPLOY.md` ganhou o **Passo 8** (hardening): unattended-upgrades,
  fail2ban, SSH só com chave e o guia do antivírus.

## 🛡️ LGPD — consentimento, direitos do titular e retenção (2026-07-20, PRs #47–#49)

O app (já em produção) ganhou a camada de conformidade com a LGPD, pedida pelo
usuário a partir de um checklist que foi auditado contra o código real (muita
coisa JÁ existia: chaves cifradas AES-256-GCM, senha com hash do Better Auth,
hard delete de conversa com cascade, cadastro mínimo). Tudo MERGEADO na main:
PR #47 (camada completa), #48 e #49 (correções após teste real do usuário no
celular — ver bullets abaixo).

**O que foi adicionado:**
- **Documentos legais**: `frontend/src/LegalPages.jsx` → rotas públicas
  `/privacidade` e `/termos` (roteadas em `main.jsx`; funcionam no Vite e no
  Caddy via fallback de SPA). Links no rodapé da landing, no cadastro e no app.
  `TERMS_VERSION` ('2026-07-20') existe em DOIS lugares que precisam andar
  juntos: `LegalPages.jsx` e `backend/src/privacy.js` — mudar os textos de
  forma relevante = mudar a versão nos dois → todos reaceitam.
  ⚠️ O controlador está como "Frederico Assessoria Contábil" e o contato
  `contabil@fredericoassessoria.com.br` — o usuário deve conferir razão social.
- **Consentimento (art. 8º)**: checkbox opt-in no cadastro (LoginScreen, POST
  `/api/consent` logo após o signUp); login social/contas antigas caem no
  `ConsentGate` (modal bloqueante no App, via GET `/api/consent` →
  `needsConsent`). Registro em `user_consents` (migration `005_lgpd.sql`) com
  versão, IP, user-agent e data — histórico, não flag.
- **Direitos do titular (art. 18)**: `backend/src/privacy.js` + rotas em
  `server.js`: GET `/api/account/export` (JSON completo, SEM segredos nem
  embeddings), DELETE `/api/account/conversations` (apaga tudo; 409 se alguma
  conversa ainda responde), DELETE `/api/account` (hard delete total: destrói
  workspaces/containers/inbox em disco e `DELETE FROM "user"` — as FKs ON
  DELETE CASCADE levam o resto; exige `{confirm: email}` no corpo). UI:
  `PrivacyPanel.jsx` (menu Administração → "Privacidade e dados").
  Correção pós-teste (PR #48): o diálogo de excluir conta NÃO exibe o e-mail
  cadastrado — mostrá-lo anulava a confirmação por digitação (era copiar e
  colar); a pessoa precisa SABER o e-mail com que entra.
- **deleteConversationDeep** unificou a exclusão profunda (rota antiga de
  apagar conversa agora também remove TAREFAS não-running da conversa — antes
  uma tarefa na fila RECRIAVA a conversa apagada via ensureConversation).
  Correção pós-teste do usuário (PR #49): fatos extraídos com
  `review_auto_memory` ligado vivem em `memory_suggestions`, não em `memory` —
  a exclusão profunda agora limpa as DUAS tabelas, e "Apagar todo o histórico"
  passa uma vassoura final em tudo com `source_type='auto'` (pega órfãos de
  conversas apagadas antes da correção; memórias manuais/importadas ficam).
  Após atualizar, o usuário deve clicar "Apagar tudo" de novo para varrer os
  órfãos que sobraram do teste.
- **Retenção (minimização)**: `CONVERSATION_RETENTION_DAYS` (0 = desligado;
  varredura a cada 6 h em `sweepOldConversations`; documentado no .env.example
  e README).
- **Aviso no chat**: hint fixo no composer ("as mensagens vão ao provedor de
  IA — evite dados sensíveis") com link para /privacidade.
- **Logs**: indexer de memória não imprime mais o título da conversa.
- Cookies: só o essencial de sessão (sem analytics) → banner de cookies NÃO é
  necessário; a política explica isso.

## 🔌 Conector GitHub — primeiro conector do app (2026-07-19)

O app ganhou **Conectores** (Configurações → Conectores), começando pelo
GitHub: o usuário conecta a conta com um token (PAT) e a IA passa a clonar
repositórios, alterar o código e enviar de volta (push/Pull Request) — pelo
chat ou pelo modo desenvolvedor.

**Desenho de segurança (não regredir):**
- Token cifrado por usuário em `user_connectors` (migration `004_connectors.sql`),
  AES-256-GCM com a mesma `ENCRYPTION_KEY` do BYOK; o GET da API só devolve
  estado/conta, nunca o token.
- **O token NUNCA entra no sandbox.** Clone/fetch/pull/push rodam no BACKEND
  (`backend/src/connectors/github.js`, `runGit` com spawn) sobre o workspace da
  conversa (bind-mount do sandbox). A autenticação vai por `http.extraheader`
  POR INVOCAÇÃO — nunca na URL nem no `.git/config` (que o modelo enxerga).
  Toda saída de git passa por `scrubSecrets` antes de voltar ao modelo.
- O modelo edita arquivos e usa git LOCAL (status/diff/commit) pelo bash do
  sandbox; `git push` pelo bash falha de propósito (sem credencial lá).
- Após escrita do backend no repo, `chown -R 1000:1000` (regra da casa: o exec
  do sandbox roda como uid 1000).
- Nomes de repo/branch validados (`isValidRepoFullName`/`isValidBranchName`)
  contra injeção de flag/caminho; `git pull` só `--ff-only` (nunca cria merge).

**Peças:**
- Backend: `connectors/github.js` (ferramentas `github_list_repos`,
  `github_clone` → `/workspace/repo/<nome>`, `github_push`, `github_create_pr`;
  API REST com erros traduzidos), rotas `/api/connectors*` no `server.js`
  (PUT valida o token no GitHub antes de salvar), roteamento `github_*` no
  `runTool` (tools.js). `agent.js`: ferramentas só entram quando o usuário TEM
  conexão (`hasGithubConnection`); em plan/review as de escrita (push/PR) ficam
  de fora (`GITHUB_WRITE_TOOLS`); `developerContextFor` aceita
  `developer.github={repo,branch}` com nota que manda clonar primeiro e, no
  build, commitar/enviar ao final. Dockerfile do backend agora instala `git`.
- Frontend: `ConnectorsPanel.jsx` (conectar/testar/desconectar; exporta
  `GitHubIcon` SVG — lucide não tem mais ícones de marca), `DeveloperPanel.jsx`
  (repositórios GitHub no seletor de projeto com prefixo `gh:`, seletor de
  branch, aviso "conecte a sua conta"), `App.jsx` (botão Conectores no menu,
  `developer.github` no corpo do chat, repo na barra do modo desenvolvedor).
- Envs opcionais: `GITHUB_CLONE_TIMEOUT_MS` (300s), `GITHUB_GIT_TIMEOUT_MS` (120s).
- **Conexão em 1 clique (OAuth)** — pedido do usuário após o PR #45 ("não quero
  colar chave; quero clicar, logar no GitHub e conectar sozinho"): botão
  "Conectar com GitHub" → popup → autorização → conectado. Fluxo próprio (NÃO
  usa o Better Auth): `GET /api/connectors/github/start` (redireciona ao
  authorize com `state` anti-CSRF em memória, uso único, 10 min, amarrado ao
  userId logado) → `GET /api/connectors/github/callback` (troca o code pelo
  token `gho_...`, salva pelo MESMO `saveGithubConnection` cifrado e devolve
  uma página que faz `postMessage` + fecha o popup; o painel escuta e
  recarrega). Requer um **OAuth App dedicado** (o do login não serve — o GitHub
  só aceita um callback por app): `GITHUB_CONNECTOR_CLIENT_ID/SECRET` no `.env`,
  callback `<BETTER_AUTH_URL>/api/connectors/github/callback` (instruções no
  .env.example). Sem essas envs, o painel cai no modo token (em `<details>`
  "alternativa") e avisa o admin. `GET /api/connectors` devolve `oauth:true`
  quando configurado. Cookie de sessão viaja no redirect (SameSite=Lax +
  navegação top-level), então o callback sabe quem é o usuário.
- Testes: `connectors.github.test.js` (validações puras + scrub). Suíte 86/88
  (2 pulados sem Postgres); build Vite ok.
- Próximos conectores sugeridos: Google Drive, Notion — seguir o mesmo padrão
  (tabela `user_connectors`, provider novo, painel no mesmo drawer).

## 🧪 GIMP avaliado e REMOVIDO — inviável headless no sandbox (2026-07-19, PRs #37–#39)

Instalamos o GIMP a pedido e testamos a fundo (13 baterias ao vivo). Conclusão:
**não é usável para automação de imagem neste ambiente**, e foi removido.
- A **GIMP 3.0** (única no Debian atual) mudou muito a API de Script-Fu em
  relação à 2.10 documentada: procedures renomeadas/removidas
  (`gimp-image-get-active-drawable`, `file-png-save`, `plug-in-gauss`, até a
  introspecção `gimp-pdb-proc-exists`). Praticamente não há exemplos 3.0 online.
- **Python-Fu quebrado**: o módulo `gi` (PyGObject) não importa no ambiente de
  plug-ins do GIMP.
- O startup dava para resolver (pré-aquecer o `pluginrc` no build → ~4,5s com
  `xvfb-run`), mas **qualquer erro de script trava até o `TOOL_TIMEOUT_MS` de
  45s** do sandbox, tornando a descoberta da API impraticável.
- **Decisão:** removido do Dockerfile e do inventário (#39). Para imagem em
  lote, o caminho é **imagemagick / Pillow / OpenCV** (headless, rápidos,
  testados — o ImageMagick fez blur gaussiano perfeito no teste). NÃO reinstalar
  o GIMP sem uma necessidade que só ele atenda e um plano para o timeout de 45s.

## 🛡️ Correção do SSRF residual no `web_fetch` (2026-07-19, mesclado em 2026-07-21 — PR #40)

Fecha a **pendência §0** (SSRF residual, aberta desde a revisão de 2026-07-16).
Uma análise crítica do repositório levantou vários pontos de segurança; ao
conferir cada alegação contra o código, a maioria já estava mitigada (o
`isBlockedHost` já cobria faixas privadas IPv4/IPv6, e o `web_fetch` já revalida
cada redirect com `redirect: 'manual'`). Os formatos numéricos decimal/octal/hex
citados como vetores **já eram neutralizados** pelo parser WHATWG de URL (ele
normaliza `http://2130706433/` para `127.0.0.1` antes do filtro). Mas dois furos
reais foram encontrados e corrigidos em `backend/src/tools.js`:

1. **Bypass por IPv6 entre colchetes** (não visto pela análise): o hostname de
   uma URL IPv6 chega **com colchetes** (`[::1]`), e o filtro comparava com
   `::1` sem colchetes — então TODO literal IPv6 (loopback, ULA, link-local e a
   forma IPv4-mapeada `[::ffff:127.0.0.1]`, que o parser normaliza para
   `[::ffff:7f00:1]`) escapava e alcançava a rede interna. Correção: remover os
   colchetes antes de comparar (`stripIpv6Brackets`), tratar IPv4 mapeado nas
   formas pontilhada e hexadecimal (`mappedIpv4`), cobrir toda a faixa
   link-local `fe80::/10` (antes só `fe80` literal) e somar multicast/reservado
   (`224/4`, `240/4`) ao bloqueio IPv4 (`isBlockedIpv4`).
2. **DNS rebinding**: filtro por texto não basta — um domínio público pode
   resolver para IP interno. Novo `assertHostResolvesPublic` resolve o hostname
   via DNS e valida CADA IP retornado antes de conectar, a cada redirect. O
   `AbortSignal` é respeitado também durante a resolução (cancelamento
   continua funcionando). Resta uma janela TOCTOU mínima entre resolver e
   conectar — é a mitigação padrão; um pinning de IP na conexão fica como
   trabalho futuro, se necessário.

**Testes:** novo `backend/src/tools.ssrf.test.js` (8 casos: bypasses corrigidos
+ regressão de endereços públicos que devem seguir liberados). O teste de
cancelamento (`tools.pathResolution.test.js`) passou a usar IP literal, que pula
o DNS via `net.isIP` e exercita o repasse do sinal de forma determinística.
Suíte do backend: 88 passam, 0 falham (2 pulados exigem PostgreSQL).

**NÃO alterado de propósito:** a senha `studio` do Postgres nos `docker-compose*`
é fixa; trocá-la no repositório quebraria o deploy em produção em execução — é
mudança de operação (variável `POSTGRES_PASSWORD` + atualização do banco) a
cargo do operador.

## 🎨 Kits de design de documentos + endurecimento por QA ao vivo (2026-07-19, PRs #24–#35)

Frente para elevar a QUALIDADE e a CONFIABILIDADE dos documentos gerados
(Word/Excel/PDF), toda verificada AO VIVO na produção (login real, assistente
"Documentos profissionais", modelo real, arquivos baixados e inspeccionados
byte a byte).

### Três kits de design prontos no sandbox (mesma identidade visual)
Instalados na imagem do sandbox (`sandbox/Dockerfile` copia para
`site-packages`), evitam o modelo reinventar o estilo na mão:
- **`docpro.py`** → `from docpro import Relatorio` (Word): capa, títulos com barra
  lateral, tabelas sem bordas verticais com cabeçalho colorido + zebra, callouts,
  KPIs, rodapé "Página X de Y" e conversão a PDF.
- **`xlspro.py`** → `from xlspro import Planilha` (Excel): tabelas com cabeçalho
  `1A3C6E` + zebra, formatos R$/%/milhar, congelar cabeçalho, linha TOTAL,
  múltiplas abas e gráficos (barras/linhas/pizza).
- **`pdfpro.py`** → `from pdfpro import RelatorioPDF` (PDF, reportlab): capa em
  página própria, tabelas estilizadas, callouts e rodapé "Página X de Y".
- **`docpro.Sobrio`** → `from docpro import Sobrio` (Word SÓBRIO/registrável — ata,
  contrato, alteração contratual): estilo Normal que **já nasce JUSTIFICADO**
  (`jc=both`), Times New Roman 12, entrelinha 1,5, margens oficiais, ZERO cor,
  rodapé paginado. Métodos: `titulo`, `secao`, `paragrafo`, `item`, `fecho`,
  `assinaturas`, `salvar` (+PDF). A justificação é estrutural, não depende do
  modelo lembrar (#35).
- Paleta comum: `1A3C6E`/`2E75B6`/`262626`/`595959`/`F2F6FA`/`D9E2EC`.

### Prompt do assistente "Documentos profissionais" (DOCPRO_PROMPT, hoje v10)
Versão migra automática por usuário (`seedDocProAssistant`: LEGACY/V2…V9 → atual,
sem tocar em prompts personalizados). Evolução:
- **v6 (#28):** ensina os TRÊS kits com exemplos concretos (antes só Word) — o
  modelo importava xlspro/pdfpro mas escrevia tabela com openpyxl cru.
- **v7 (#29):** exige preencher TODAS as colunas, calcular colunas derivadas
  (Total = Qtd×Preço) e incluir linha de TOTAL geral; fórmulas apontando a célula
  real.
- **v8 (#30):** gráfico de pizza/participação em formato LONGO (categoria por
  linha), não coluna de totais por período.
- **v9 (#33):** ZERO PLACEHOLDER passa a proibir preenchimento geográfico
  genérico ("Cidade/Estado", "Rua Nova") — usar local concreto (ex.: Palmas/TO);
  primeira tentativa de justificar o documento sóbrio via instrução no prompt.
- **v10 (#35):** a regra de documento SÓBRIO passa a mandar usar
  `from docpro import Sobrio` (justificação estrutural, ver acima), em vez de
  instruir o modelo a alinhar cada parágrafo — o modelo ignorava a instrução.

### Validação (`validateOutputs`/`check_charts` em `agent.js`)
- **Gráfico com série de valores vazia (#29):** resolve as refs dentro de
  `<val>` e reprova (`ok:false`) quando o intervalo plotado não tem número —
  pega a coluna declarada no cabeçalho mas deixada vazia. Não gera falso
  positivo em categorias de texto.

### Kits à prova de crash (#31) — o bug mais grave desta frente
Uma linha com nº de valores ≠ cabeçalho estourava `IndexError` no kit e **matava
a tarefa inteira → zero arquivo entregue**. Corrigido nos três:
- `xlspro.tabela`: célula além do cabeçalho é escrita sem formato, sem crash.
- `docpro.tabela` / `pdfpro.tabela`: normalizam cada linha para a largura do
  cabeçalho (completam curtas, cortam extras) — python-docx e reportlab exigem
  tabela retangular.
- `xlspro.grafico_*`: erro claro quando o 2º arg não é o dict de `p.tabela()`.

### Gráficos excluem a linha TOTAL (#32)
`_grafico` incluía a linha "Total" como fatia/barra gigante (= soma das demais).
`tabela()` devolve `info["total"]` e `_grafico` exclui essa última linha.

### Provas ao vivo (produção, após cada deploy)
- **Excel pesado** (12 meses, 3 abas, DRE, 3 gráficos): 0 falhas; participação
  soma 100%; DRE com margem coerente; faturamento anual bate; pizza por produto;
  gráficos sem a linha Total.
- **Word longo:** 7 tabelas estilizadas, callouts info/alerta/crítico, rodapé
  paginado, sem placeholder.
- **PDF:** capa própria, tabela com TOTAL somado, callout, "Página X de Y".
- **Ata registrável (sóbria):** zero cor, estrutura jurídica completa, dados
  concretos (Palmas/TO) e — com o helper `Sobrio` (v10) — corpo JUSTIFICADO com
  garantia estrutural (Normal `jc=both`, verificado no docx gerado). Reforço só
  no prompt (v9) não bastava: o modelo ignorava a justificação; embutir no kit
  resolveu. Resíduo conhecido: o modelo às vezes ainda escreve um bairro genérico
  ("Bairro Novo") — é conteúdo, não formatação, e "Bairro Novo"/"Rua Nova" são
  nomes reais, então não dá para barrar na validação sem falso positivo.

### Também nesta frente (rounds anteriores da mesma branch)
- **#23:** geração de arquivo após pesquisa web (causa-raiz, todos os modelos):
  `tools=[]` removia o `run_python` depois de um web_search; passou a filtrar só
  as ferramentas web (`WEB_TOOL_NAMES`).
- **#24:** documentos com tabelas (regra forte) + resultado não se perde ao sair
  da página (backend continua e salva; frontend faz `recoverPendingReply`).
- **#25/#26/#27:** design profissional de Word e nascimento dos kits docpro,
  depois xlspro/pdfpro.

## 🛡️ Endurecimento de QA — geração de documentos, contexto longo e multi-modelo (2026-07-19)

Auditoria de caça a bugs (relatório em `docs/RELATORIO_BUGS_QA.md`) seguida da
correção de todos os achados. Suíte do backend verde (79 testes) + novos testes
em `backend/src/qaFixes.test.js` e `toolProtocol.test.js`. Destaques:

- **Validação de Excel que mentia (crítico):** `validateOutputs` lia a *string*
  da fórmula (openpyxl) e nunca via `#REF!`/`#DIV/0!`, dando "ok" falso. Agora
  recalcula com LibreOffice (recálculo-ao-abrir), faz lint das fórmulas e, sem
  recálculo disponível, rotula "verificação parcial" em vez de alegar sucesso.
  Passou a validar `.xlsm`, cobre `.docx` vazio e tem teto de células.
- **Contexto longo:** `estimateTokens` ficou ciente de alfabeto (não subestima
  mais 2–3× em japonês/árabe/cirílico); `trimForTokens` corta pelo custo real;
  modelos `:free` de janela grande não são mais rebaixados a 18k (`contextBuilder`).
- **Multi-modelo:** especialistas rodam em PARALELO (controle com `Set` de
  requisições ativas); parecer truncado é continuado e/ou marcado; briefing com
  limites maiores e corte visível; **failover automático de modelo**
  (`MODEL_FALLBACKS` + modelo-base) quando o provedor cai, sem perder o trabalho.
- **Robustez:** coletor de lixo de disco (`.tmp_*` órfãos + `OUTPUT_RETENTION_DAYS`),
  `guardCommand` mais robusto, detecção de arquivo novo por `mtime:size`, avisos
  do sistema fora dos arquivos materializados, aviso honesto sobre macros VBA.
- Novas envs (todas opcionais, padrões seguros): ver `.env.example` e README.

### Bugs de produção + validações extras (mesma frente, PR #22)

Testes **ao vivo na produção** (login real, modelos reais, arquivos baixados e
inspecionados) revelaram e corrigiram mais bugs de nível de app:

- **Vazamento do protocolo de ferramenta no chat** (consulta de CNPJ): o stream
  guard era desligado no modo SEM ferramentas (`enabled=false` repassava tudo),
  então `<tool_call>/<function=run_python>/`código python-docx vazavam. Agora o
  guard suprime o protocolo **sempre** (`toolProtocol.js`).
- **Loop de repetição** do modelo (eco do prompt): freio `looksDegenerate` corta
  a saída degenerada com aviso (`agent.js`).
- **Formatação estourando a tela no mobile:** `overflow-wrap`/`word-break` no
  conteúdo; `pre`/tabelas rolam na caixa (`frontend/src/styles.css`).
- **Modelo executava o código em vez de salvar:** ao pedir para GERAR/SALVAR um
  programa, o modelo rodava o script (só imprimia o help) e não gravava o `.py`;
  reforço no prompt e no reparo de execução para ESCREVER o arquivo em outputs.
- **Validação de gráficos do Excel:** `validateOutputs` lê os `xl/charts/*.xml`
  e marca o arquivo como não-ok quando um gráfico tem referência quebrada
  (intervalo invertido tipo `C2:B2`, aba inexistente, sem série/refs) — o
  recálculo de fórmulas não cobria gráficos.
- **`recalc_took`:** reconhece o recálculo mesmo quando TODAS as fórmulas viram
  erro (antes exigia valor numérico e descartava o pior caso, o all-error).

**Verificado em produção após deploy da branch:** ÷0 agora dá
`ok:false, "1 célula com erro de fórmula"` (antes "ok, 1 abas"); code-gen com
contexto de 25k reteve o requisito enterrado E salvou o `.py`; guard, repetição
e CSS sem incidentes na bateria Word/Excel/PDF/código. Estado dos achados e das
provas: `docs/RELATORIO_BUGS_QA.md`. **Gap aberto:** o app não confere o valor
numérico que o modelo afirma no texto vs. o da fórmula no arquivo.

## ✅ SaaS COMPLETO E EM PRODUÇÃO (2026-07-18)

As 5 fases da transformação em SaaS estão CONCLUÍDAS e o app está NO AR:

- **Fase 1** — PostgreSQL (migração do SQLite).
- **Fase 2** — Login por usuário (Better Auth: e-mail/senha + GitHub/Google).
- **Fase 3** — Isolamento por usuário (multi-tenant) + BYOK + limites (pastas do
  PC por usuário, `RATE_MSGS_PER_DAY`, `MAX_SANDBOXES_PER_USER`).
- **Fase 4** — Página de apresentação (landing) antes do login, com a seção
  "modelo de verdade" (acesso transparente ao modelo).
- **Fase 5** — Produção na VPS com Docker + Caddy (HTTPS automático).

**PRODUÇÃO AO VIVO:**
- URL: **https://fredericostudio.com.br** (domínio no Registro.br; registro **A**
  na raiz apontando para o IP da VPS).
- **www com certificado próprio**: `www.fredericostudio.com.br` tem bloco no
  Caddyfile (via `WWW_DOMAIN` no compose de produção) que emite o certificado e
  redireciona (308) para a raiz. O DNS do `www` já apontava para a VPS; para
  ativar, rodar `bash atualizar.sh` no servidor.
- Hospedagem: **Contabo** Cloud VPS (Ubuntu + Docker). Sobe via
  `docker-compose.prod.yml`: serviços `postgres` + `backend` + `web` (Caddy);
  o backend não é exposto (só pelo proxy).
- Modo: **PÚBLICO com BYOK** (`ALLOW_SHARED_KEY=false`) — cada usuário cadastra
  a própria chave em Configurações → Provedor de IA. Sem chave do servidor.
- Segredos (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`) vivem no `.env` **do servidor**
  (nunca no repo). Login social (GitHub/Google) **não** configurado em produção —
  só e-mail/senha (para ativar: preencher credenciais no `.env` + callback
  `https://fredericostudio.com.br/api/auth/callback/{provider}`).
- **Botões sociais agora são automáticos**: o backend só registra os provedores
  com credenciais no `.env` e publica a lista em `/api/health` →
  `socialProviders`; a tela de login só mostra os botões que funcionam. Antes,
  clicar em Google/GitHub sem credenciais dava 500 silencioso e o spinner
  travava o formulário inteiro (parecia que até o cadastro estava quebrado —
  o `signIn.social` da Better Auth devolve `{ error }` em vez de lançar, e o
  retorno não era tratado).

**Operação (no servidor, pasta do projeto):**
- Atualizar: `git pull && docker compose -f docker-compose.prod.yml up -d --build`.
- Backup: `docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U studio studio > backup.sql` + `tar czf workspaces.tgz workspaces`. Guia: `VPS-DEPLOY.md`.

**Melhorias recentes de qualidade (já na main):** ferramenta `consultar_cnpj`
(#7), busca gratuita mais robusta com fallback DuckDuckGo (#8), e revisão do
system prompt — pesquisa humanizada, persona com voz/público, deduplicação e
tom mais humano em todas as camadas mantendo os guarda-corpos (#9–#11).
- **Deploy/operação** (#14, #17): `docker-compose.prod.yml` e `VPS-DEPLOY.md`
  atualizados para login multiusuário + Postgres; `atualizar.sh` (na VPS:
  `git pull` + rebuild + limpeza + status), preservando dados.
- **Câmera no chat** (#18): `CameraCapture.jsx` — foto pela webcam (getUserMedia)
  no desktop e câmera traseira no celular, com "enviar da galeria" de reserva e
  compressão canvas→JPEG. A foto entra pelo mesmo pipeline de anexo
  (`uploadSelectedFiles`); `sendMessage` usa pedido padrão quando só há anexo.
  `uploadsNote` (agent.js) instrui OCR automático de imagem + tratar foto
  borrada com gentileza.
- **Visão multimodal real** (#19): em `agent.js`, quando o modelo TEM visão
  (`capabilities.vision`), as imagens dos uploads vão como `image_url` (base64,
  máx. 4 / 8 MB) na última mensagem do usuário; modelos sem visão seguem no OCR.
  Fallback: `isUnsupportedVisionError` → remove imagens e refaz (OCR).
  `modelCapabilities.js`: detecção de ferramentas aceita tools/tool_choice/
  functions; `FALLBACK_MODELS` atualizada. As capacidades por modelo continuam
  detectadas automaticamente do OpenRouter (não há lista manual).

**Pendências/ideias futuras:**
- Se for divulgar amplamente (indexado), adicionar **confirmação de e-mail** e/ou
  **aprovação de conta** — hoje qualquer um se cadastra (recomendado divulgar
  "por link"). O sandbox executa código com internet: manter a VPS dedicada.
- Migration 004: `user_id` NOT NULL após confirmar todos os inserts com dono.

---

## 0.-1 FASE 3 — CONCLUÍDA — Isolamento por usuário (2026-07-18)

**Parte 1 (fundação)** — commit `8022cec`: migration 003 adiciona `user_id`
(NULLABLE) às 11 tabelas de topo + índices; cria `user_settings` (BYOK) e
`usage_daily`; `crypto.js` (AES-256-GCM: encryptSecret/decryptSecret/maskSecret).

**Parte 2a (isolamento central) — CONCLUÍDA E TESTADA:** cada usuário só vê/mexe
nos PRÓPRIOS dados. Feita com 2 subagentes sob contrato: `server.js` (todas as
rotas escopadas por `req.userId`; posse verificada em `WHERE id=? AND user_id=?`
→ 404; seeds de assistentes/templates/docpro agora POR USUÁRIO via
`ensureUserSeeded` + middleware; `ensureConversation` retorna null p/ id de outro
dono → 404) e `agent.js`/memória (assinaturas com `userId` primeiro:
`saveMessage(userId,...)`, `persistAssistantReply(userId,...)`,
`runAgent/runOrchestrator({userId,...})`, memoryService `fn(userId,...)`; queries
de memory/chunks escopadas por `user_id` ALÉM do `scope`). `migrate.js` ganhou
advisory lock (serializa migração entre processos). **Testado:** teste A-contra-B
por HTTP (16/16: B recebe 404 em tudo de A; cada um vê o próprio; seed por
usuário) + suíte 42/42.

**Parte 2b (BYOK) — CONCLUÍDA E TESTADA** — commits `1747da7` (backend) e
`86cf216` (frontend): cada usuário usa a PRÓPRIA chave de API. `userProvider.js`
(`getUserProvider(userId)` → chave do usuário decriptada de `user_settings`, ou
`SERVER_KEY` se `ALLOW_SHARED_KEY!==false`); `agent.js` usa `provider.client`;
sem chave → orienta ir em "Provedor de IA". Rotas `GET/PUT /api/provider` e
`POST /api/provider/test` (GET só devolve a chave mascarada). Tela
`ProviderPanel.jsx` no frontend. Armazenamento criptografado verificado.

**Parte 2c (limites + isolamento do sandbox) — CONCLUÍDA E TESTADA** (2026-07-18):
- **⚠️ CORRIGIDO o vazamento das PASTAS DO PC:** `sandbox.js` deixou de usar um
  cache GLOBAL. Agora `loadPcFolders()` agrupa por usuário (`pcFoldersByUser`) e
  `pcFolderMounts(userId)` monta SÓ as pastas daquele usuário; sem `userId`,
  nenhuma pasta (default seguro). O `userId` viaja em `sandboxOptions` de
  `runAgent`→`runTool`→`execInSandbox`→`getContainer`→`createContainer`.
  `tools.js` resolve caminhos `/mnt/pc/...` pelas pastas do usuário atual.
  **Testado:** dois usuários A/B com pastas próprias — cada um só vê a sua, e sem
  userId retorna zero.
- **Limite diário de mensagens:** `RATE_MSGS_PER_DAY` (env; 0 = sem limite,
  padrão). `usage_daily` conta por usuário/dia (UPSERT atômico
  `ON CONFLICT ... RETURNING`, sem perda em concorrência — testado). Aplicado no
  `POST /api/conversations/:id/chat` e no `POST /api/tasks` (429 ao estourar).
- **Limite de sandboxes por usuário:** `MAX_SANDBOXES_PER_USER` (padrão 2). Ao
  abrir o (N+1)-ésimo, o mais antigo do mesmo usuário é encerrado (LRU). O
  `session` do sandbox agora guarda `userId`.
- **Correção de isolamento:** `POST /api/tasks` passou a verificar a posse da
  conversa (404 se for de outro usuário) — antes só criava sem checar o retorno.

**FALTA na Fase 3 (itens menores, isolamento já se sustenta):**
- **Workspaces por CAMINHO de usuário** (`workspaces/<userId>/<conv>`): hoje o
  workspace é por convId. O isolamento se sustenta (convId é PK único, posse
  verificada antes; as pastas do PC agora são por usuário), então é só
  organização de diretórios — cosmético. Se for feito, precisa migrar os
  workspaces existentes.
- `maybeReindexOnModelChange` chama `reindexAll()` sem userId → hoje é no-op
  (reindex por troca de modelo virou por-usuário; decidir como disparar).
- Migration 004 futura: tornar `user_id` NOT NULL depois de confirmado que todo
  INSERT passa o dono. Preferências de memória seguem GLOBAIS (aceitável por ora).

## 0.0 ATUALIZACOES MAIS RECENTES (2026-07-17)

Leia primeiro o estado de transformacao SaaS na secao seguinte.

- **Acesso movel por Tailscale corrigido:** o print mostrava o Chrome do celular
  em `localhost:5173`; nesse aparelho, localhost aponta para o proprio celular e
  a conexao e recusada. O Tailscale Serve estava ativo e o defeito adicional era
  `BETTER_AUTH_URL=http://localhost:5173`, que gerava callback OAuth para o PC.
  A instalacao local agora usa a URL HTTPS do Serve como base canonica. O login
  social envia um callback final absoluto para a mesma origem em que foi iniciado,
  evitando voltar acidentalmente para localhost. README e `.env.example`
  documentam a configuracao e os callbacks de GitHub/Google. Validacao: pagina
  abriu pela URL HTTPS do Tailscale, callback do GitHub passou a usar o host
  `.ts.net`, 7 testes de frontend passaram, build Vite concluiu e `/api/health`
  respondeu normalmente.
- **Correcao critica de chamadas de ferramentas e downloads:** o PDF
  `Frederico AI Studio.pdf` mostrou o Nemotron devolvendo uma chamada
  `run_python` inteira como texto (`<tool_call>...codigo...</tool_call>`). O
  frontend exibiu esse protocolo como resposta, a ferramenta nunca foi
  executada e nenhum DOCX foi criado. A causa nao era apenas visual: alguns
  provedores/modelos emitem uma imitacao textual quando deveriam preencher
  `delta.tool_calls`.
- **Adaptador defensivo no streaming:** `backend/src/toolProtocol.js` agora
  reconhece o formato textual XML/JSON, inclusive quando o marcador chega
  dividido entre varios fragmentos. O protocolo e ocultado antes de chegar a
  tela, nomes de ferramentas sao conferidos contra a lista realmente oferecida
  e chamadas validas sao convertidas em chamadas estruturadas. Formatos
  incompletos ou ferramentas desconhecidas nao sao executados; ha uma tentativa
  forcada pelo protocolo nativo e depois uma falha curta com a acao Reenviar.
- **Entrega de arquivo virou criterio de sucesso:** pedidos de DOCX, XLSX, PDF
  ou outro arquivo ficam como execucao incompleta quando nenhum arquivo real
  aparece em `/workspace/outputs`, mesmo que o modelo nao tenha escrito um
  caminho. Arquivo existente gera cartao de download; resposta vazia com
  arquivo recebe uma conclusao curta. O frontend recebe `execution_failed`,
  marca a resposta e, ao usar Reenviar, remove do banco a tentativa quebrada,
  seus arquivos e o contexto de memoria derivado antes de repetir o pedido.
- **Prompts revisados:** todos os assistentes recebem um contrato central de
  execucao e experiencia: ferramenta so pelo protocolo nativo, nada de codigo,
  XML, argumentos ou promessas repetidas no chat, conclusao pelo resultado e
  falha em linguagem comum. O inventario enorme do sandbox so entra em consultas
  sobre ambiente ou no modo desenvolvedor. O assistente `Documentos
  profissionais` ganhou prompt versionado `2026-07-17-v2`, orientado a entregar,
  validar e anexar o arquivo; prompts personalizados pelo usuario sao
  preservados.
- **Memoria e historico protegidos:** respostas antigas com protocolo textual
  sao saneadas ao carregar a conversa, montar contexto, indexar memoria e
  exportar PDF/DOCX. Isso evita que o erro reapareca por contaminacao do
  historico. As mensagens originais continuam no banco ate o usuario reenviar
  ou editar, evitando apagar dados sem consentimento.
- **OpenRouter:** chamadas com ferramentas exigem provedores que aceitem os
  parametros solicitados (`require_parameters`). A ordenacao fixa por
  `throughput`, que podia preferir um endpoint menos confiavel para ferramentas,
  foi removida. `OPENROUTER_PROVIDER_SORT` continua disponivel como escolha
  explicita.
- **Validacao desta correcao:** 51 testes do backend e 4 testes do parser SSE
  passaram nos containers reais (55 no total), alem do build Vite de producao.
  O prompt v2 foi confirmado no PostgreSQL, `/api/health` ficou saudavel e o
  frontend respondeu HTTP 200. O teste visual automatizado chegou a tela de
  login; o fluxo autenticado nao foi executado com uma conta artificial.
- **Controles de execucao e pesquisa web na main:** o PR #4 integrou o commit
  `d242c23`. Pausar, continuar e parar agora controlam a execucao real; parar
  tambem cancela ferramentas em andamento, e a pesquisa web filtra URLs
  repetidas e tem limites por etapa e por tarefa para evitar loops.
- **README atualizado na main:** a pagina principal agora descreve PostgreSQL,
  Better Auth, sandbox com rede habilitada, configuracao atual, seguranca e o
  limite conhecido de multi-tenancy. Foram removidas as afirmacoes antigas sobre
  SQLite, ausencia de login e sandbox sem rede.
- **Validacao das correcoes de execucao:** 42 testes passaram; 1 teste de
  persistencia de DOCX foi pulado sem PostgreSQL de teste. O frontend compilou
  dentro do container e backend (`/api/health`) e frontend (HTTP 200) foram
  verificados apos o deploy.

### Regra obrigatoria de handoff e GitHub

Para TODA modificacao futura de codigo, comportamento, configuracao ou
documentacao relevante:

1. Atualizar este `CONTINUIDADE.md` no mesmo conjunto de mudancas.
2. Revisar o diff e validar o que foi alterado.
3. Criar um commit descritivo em portugues, apenas com os arquivos da tarefa.
4. Enviar o commit ao GitHub na mesma sessao (`git push`).

Nao incluir automaticamente `frontend/dist/`, lockfiles alterados por ambiente,
notas soltas ou arquivos de outra frente de trabalho. Eles so entram mediante
revisao explicita.

> Documento de handoff para continuar o desenvolvimento em uma nova sessão.
> Última atualização: 2026-07-17. Leia isto ANTES de qualquer mudança.
>
> **2026-07-17 — Faxina de documentação:** removidas menções a recursos que
> NÃO existem mais no app — o **Calendário fiscal** (obrigações de Tocantins:
> GIAM/ICMS, SPED Fiscal) e os apps embutidos de viés fiscal (NF-e, conciliação,
> comparador de regimes). Eles foram retirados do código no commit `bbd2d19`
> ("torna o app um estúdio geral"); só sobravam nestas anotações e nos
> comentários do `sandbox/Dockerfile` (também neutralizados agora). O app é um
> **estúdio geral**, sem viés contábil/fiscal.

## 0. ESTADO ATUAL — Transformação em SaaS multi-tenant (2026-07-17)

> **LEIA PRIMEIRO.** O app está sendo transformado de single-user (sem login) em
> **SaaS multi-tenant**, seguindo o plano em `PROMPTSAAS.md` (5 fases). Abaixo, o
> ponto exato em que paramos.

**Fases (do `PROMPTSAAS.md`):**
1. ✅ **PostgreSQL** — CONCLUÍDA e testada (rodando na máquina do usuário).
2. ✅ **Better Auth (login e-mail/senha + GitHub + Google)** — CONCLUÍDA e testada
   pelo usuário (login pelo GitHub funcionando, IA respondendo).
3. ⏳ **Isolamento por usuário (multi-tenancy) + BYOK** — PRÓXIMA. Não iniciada.
4. ⏳ **Landing page** — não iniciada.
5. ⏳ **Produção (VPS + domínio)** — não iniciada.

**O que a Fase 1 fez (commit `15e6ebd`):** trocou SQLite (better-sqlite3, síncrono)
por **PostgreSQL** (`pg`, assíncrono). `backend/src/db.js` virou uma casca de
compatibilidade sobre o `pg` (mantém `db.prepare(sql).get/all/run`, mas agora
tudo é `await`; traduz `?`→`$n`; transação real via AsyncLocalStorage). Schema em
`backend/migrations/*.sql` + runner `backend/src/migrate.js` (roda no boot).
Decisões: datas e JSON ficam como **TEXT** (preserva o comportamento antigo);
embeddings viram **BYTEA**; `rowid`→coluna `seq BIGSERIAL` nas mensagens;
`MAX(a,b)`→`GREATEST`; `COUNT/SUM` viram string no pg (usar `Number()`); GROUP BY
estrito. Compose ganhou serviço `postgres:16-alpine`. **`getSettings()` e
`pcFolderMounts()` continuam SÍNCRONOS via cache em memória** (carregado no boot),
para não quebrar em cascata. Shim no `server.js` encaminha rejeições de handlers
async ao middleware de erro (Express 4 não faz isso — sem ele, um erro de query
derrubava o processo). `/api/backup` agora usa `pg_dump`.

**O que a Fase 2 fez (commits `8a3f20a`, `cd9516a`, `92601d1`):** login com
**Better Auth** (v1.6.x) usando o mesmo Postgres. Backend: `backend/src/auth.js`
(instância `betterAuth` + middleware `requireAuth` que põe `req.userId`);
`migrations/002_better_auth.sql` (tabelas `user/session/account/verification`,
schema gerado pela CLI oficial — nomes camelCase entre aspas); no `server.js` o
handler `/api/auth/*` é montado ANTES do `express.json`, e todas as rotas `/api`
exigem login (exceto `/api/health` e `/api/auth/*`). Removidos a senha única
antiga (APP_PASSWORD) e a rota `/api/login`. Frontend: `authClient.js`,
`AuthGate.jsx` (portão que mostra login ou app), `LoginScreen.jsx` (e-mail/senha
+ GitHub/Google, ícones de marca em SVG inline), `auth.css`; o `App.jsx` recebe
`user` por prop e ganhou botão "Sair". Como o app usa `fetch` relativo, o cookie
de sessão vai automaticamente em toda chamada (inclusive SSE).

**Variáveis novas no `.env`** (ver `.env.example`): `DATABASE_URL`, `DATA_DIR`,
`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `GITHUB_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`. O usuário criou os OAuth Apps (GitHub/Google) com
callbacks `http://localhost:5173/api/auth/callback/{github,google}` (dev). Os
segredos (BETTER_AUTH_SECRET, ENCRYPTION_KEY) vieram de `openssl rand -hex 32`.
**`ENCRYPTION_KEY` ainda NÃO é usada** — ela é para o BYOK da Fase 3 (criptografar
a chave de API de cada usuário com AES-256-GCM).

**Pendências conhecidas / próximos passos:**
- **Fase 3** é a próxima: coluna `user_id` em toda entidade de topo (conversas,
  assistentes, memórias, chunks, análises, configurações, tasks, schedules,
  pc_folders, clients, templates, inbox), posse verificada na query
  (`WHERE ... AND user_id=$userId`, 0 linhas → 404), workspaces por usuário
  (`WORKSPACE_ROOT/<userId>/<conversationId>` + bind com `HOST_WORKSPACE_ROOT`),
  chave do Map de sandboxes vira `${userId}:${conversationId}`, memória escopada
  ao usuário, e **BYOK** (`user_settings` com a chave criptografada por
  `ENCRYPTION_KEY`; `agent.js` usa a chave do usuário logado). Script opcional
  `import-sqlite.mjs` para migrar os dados antigos do dono.
- **Login no celular (Tailscale):** hoje os callbacks OAuth são só `localhost`.
  Para o celular, adicionar a URL do Tailscale/domínio nos apps do GitHub/Google
  e ajustar `BETTER_AUTH_URL`/`FRONTEND_URL`.
- **Dado antigo:** ao subir a versão nova, o banco Postgres começa VAZIO (os
  dados do SQLite antigo não migram sozinhos — é o esperado no multi-tenant).

**Validação feita:** Fase 1 testada contra um Postgres real (migrations, transação
commit/rollback, BYTEA, ON CONFLICT, ordenação/truncamento por `seq`, rotas da
API) + suíte 36/36. Fase 2 testada via API server-side da Better Auth (cadastro,
login, senha errada rejeitada) e **confirmada pelo usuário no navegador** (login
GitHub + IA respondendo). Os testes de banco pulam sozinhos se não houver Postgres.

**Ambiente Windows do usuário:** roda por `docker compose up --build` (o
`iniciar.bat` teve os finais de linha corrigidos para CRLF via `.gitattributes`
no commit `617d369`). Mudou o `.env`? Precisa recriar o container do backend
(`docker compose up` de novo). Trocou de branch e o site mostra versão antiga?
`docker compose down` + `up --build` (o container do frontend não recria sozinho).

---

## 0. PONTO ATUAL (2026-07-16) — protótipo v2, ícones/cor, faxina de CSS

Sessão focada em aplicar o **protótipo aprovado no claude.ai/design**
(`Frederico AI Studio v2.dc.html`) no app real, com validação ao vivo por
estilo computado (o screenshot do painel não funciona nesta sessão).

- **Camada `v2.css`** (novo arquivo, importado POR ÚLTIMO em `main.jsx`): refino
  visual sobre as classes do `styles.css` + componentes novos. Vence empates por
  ordem de carga. Cabeçalho do arquivo documenta a arquitetura. **Regra das 7
  paletas:** cores saem de `var(--accent/--muted/--line)` ou `color-mix` — nunca
  hex fixo, senão Claro/Sépia herdam azul.
- **Protótipo v2 aplicado:** breadcrumb `cliente › conversa` na topbar; rodapé da
  sidebar com status do servidor (verde/âmbar, derivado de `unprotected`); **chips
  do composer** (Pesquisa web, Esforço, Ditar, Executar em 2º plano) — o menu ⚙
  (`.cmpMenu`) foi **eliminado** por ser redundante com os chips; separador de data
  + cabeçalho do assistente nas mensagens; marca com ladrilho "F"; botão enviar
  `ArrowUp`; seletor de cliente custom `ClientPicker` (no lugar do `<select>`).
- **Ícones Lucide + cor por assistente:** o campo `emoji` (banco/API) agora guarda
  o **nome de um ícone Lucide** (`ASSISTANT_ICONS` em `constants.js`). COMPAT: se o
  valor não for um nome de ícone conhecido (`isAssistantIcon`), renderiza como
  TEXTO — assistentes antigos com emoji continuam funcionando, sem migração de
  banco. Nova coluna `assistants.color` (ALTER TABLE em try/catch, `db.js`);
  `server.js` INSERT/UPDATE incluem `color`; GET usa `SELECT *` (flui sozinho).
- **`QUALITY_BAR`** (backend `agent.js`): padrão de qualidade em PT-BR (raciocínio,
  honestidade sobre incerteza, anti-fabricação de fontes, tratar conteúdo externo
  como dado não-confiável). Injetado nos 3 caminhos de resposta ao usuário
  (resposta única + coordenador de equipe direto + síntese). Enxugado p/ não
  duplicar `SANDBOX_RULES` nem a regra de idioma.
- **Faxina de CSS (SUPERSEDE o aviso de §0/2026-07-14 sobre `.cmpMenu` e
  `.composer button`):** o `styles.css` tinha ~4 gerações sobrepostas do composer;
  a antiga (fonte de 3 bugs) foi removida e consolidada numa geração única. 16
  classes órfãs removidas. **ARMADILHA (custou 3 regressões):** remover a geração
  antiga derruba props load-bearing que a nova não tem (`display:flex`, `flex:1`,
  `font:inherit`, `color`, e o `outline:none` que suprimia a regra global de
  foco). Ao consolidar CSS: verificar o RENDER (geometria/fonte/cor), não uma
  lista de props; e migrar TODA prop que só a regra antiga tinha.
- **Armadilhas de deploy confirmadas:** HMR do Vite está morto (inotify não passa
  no bind mount do Windows) → editar `frontend/src` exige `docker restart
  frederico-ia-studio-frontend-1`. Backend NÃO tem bind mount do código → editar
  `backend/src` exige `docker compose build backend`. Os dois falham em silêncio.

### Trabalho de OUTRAS sessões incluído no commit e revisado em 2026-07-16

O commit `49b9ac6` empacotou muita coisa que já estava na árvore sem commit.
Foi revisado por leitura de diff (3 frentes) + suíte de testes (40/40 passam:
36 backend `node --test` + 4 frontend `sse.test.js`) + build/boot. Resumo:

- **Controle de concorrência por conversa** (`agent.js`): `acquireConversationControl`
  / `releaseConversationControl` (idempotente) / `isConversationActive`. Impede 2
  respostas simultâneas na mesma conversa; `DELETE`, `POST /tasks` e `/chat` retornam
  **409** se a conversa está ativa (o DELETE protege a FK de mensagens/arquivos).
- **Modo Equipe com Executor** (`agent.js runOrchestrator`): quando a tarefa exige
  ferramentas, um assistente "executor" roda o `runAgent` de verdade usando os
  pareceres da equipe como briefing (antes a equipe só gerava texto).
- **Capacidades de modelo** (`modelCapabilities.js`): `buildModelCallPlan` bloqueia
  modelo sem `text`/sem `tools` quando a tarefa exige (mensagem amigável), degrada
  tools/reasoning não suportados, e faz fallback p/ texto quando o provedor responde
  "no endpoints support tool use".
- **Modo desenvolvedor** (`DeveloperPanel.jsx` + `App.jsx`): plan/build/review sobre
  uma pasta de PC montada, com Missão (`brief`) e Regras (`rules`); injeta
  `developer:{mode,projectId,rules}` no body do chat.
- **Rotinas com timezone** (`scheduling.js`): `scheduleDue` usa `APP_TIMEZONE` (não
  UTC), com clamp de dia mensal. **Classificação de tarefas** (`taskOutcome.js`):
  `done`/`error`/`canceled` em vez de sempre "concluída".
- **Turnos de baixo sinal** (`memory/retrievalPolicy.js`): saudações/confirmações
  curtas não disparam recuperação de memória nem ferramentas.
- **`tools.js` endurecido** (MELHORA a segurança): `web_fetch` valida host a cada
  redirect + limite de tamanho; `write_file` recusa gravar fora do workspace;
  caminhos de pasta de PC confinados por `resolveMountedPcPath`.
- **Resiliência de streaming** (`agent.js`): retry em 408/429/5xx + timeouts, com
  retomada. **Reparo de entrega**: materializa `.md/.txt` prometido mas não criado.
- **`sse.js` (frontend)**: parser de SSE sem estado, tolerante a proxy sem separador
  final e a evento malformado (relevante pro duplo proxy do Tailscale).

## 0.1 PONTO 2026-07-14 — o que foi feito depois da v. de memória

Branch `claude/new-session-ohbtj0`, PR #1. Tudo validado (esbuild/node --check)
e enviado. Desde a versão de memória, foi adicionado/corrigido:

- **Reforma visual (ChatGPT/Claude/Jan.ai):** abre em tela de boas-vindas
  (conversa "rascunho" — registro só no 1º envio via `ensureConversation`,
  single-flight); barra lateral **recolhível** (`sideHidden`); busca de
  conversas (procura em TODOS os clientes via `?all=1`); tela de boas-vindas
  com cards; campo de mensagem arredondado.
- **Layout da barra lateral:** conversas + ferramentas num único scroll
  (`.sideScroll`) — histórico com espaço garantido, nada cortado.
- **Caixa de mensagem:** todos os botões agrupados num **menu único**
  (`.cmpMenu`, ícone SlidersHorizontal): Anexar, Pesquisa web, Esforço,
  Ditar, Segundo plano. Só menu + textarea + enviar visíveis. CUIDADO: a regra
  base `.composer button{height:48px;width:52px}` sobrescreve botões novos —
  use seletores mais específicos (`.composer .cmpMenuBtn`, `.cmpMenuPanel .cmpItem`).
- **Seletor de modelos:** filtros (família via `<select>`, lançamentos/NOVO,
  grátis, contexto, capacidades), favoritos (localStorage), ordenar por
  novos/baratos. `/api/models` expõe created, context, price, vision, free.
- **7 temas** (claro/escuro + slate/indigo/emerald/amber/sepia) via classes
  `.t-<id>` + `theme` state; botão Tema abre seletor.
- **Esforço da IA** (baixo/medio/alto/extra/max): reasoning effort (OpenRouter)
  + maxSteps + nudge. Enviado no body do chat; aliases p/ nomes antigos.
- **Correção de bugs (revisão com 4 agentes):** symlink escape (safeJoin +
  realInside), BLOCKED_PATHS/isDangerousHostPath, SSRF no web_fetch,
  execInSandbox (error handler + demux + cap), getContainer single-flight,
  vazamento de memória entre clientes (findSimilar por escopo + 'passage'),
  guardas Array.isArray no front, etc.
- **Economia de tokens** (`economy_mode`, LIGADO por padrão): contexto ~8k,
  histórico 20, extração de memória só a cada 4 msgs.
- **Recursos novos:** Ferramentas/apps embutidos (EMBEDDED_APPS: documento
  profissional, planilha a partir de dados, OCR de imagens/PDF, dashboard de
  dados, proposta/contrato — todos GENÉRICOS, sem viés fiscal), assistente
  "Documentos profissionais" (seed único via settings.seeded_docpro, Word Design
  em python-docx), Rotinas agendadas (tabela `schedules` + agendador 1x/min),
  Caixa de entrada de documentos por cliente (data/inbox).
- **Heartbeat SSE** (": ping" a cada 15s) contra "Upstream idle timeout".
- **Acesso no celular:** app agora usa **mesma origem** (API relativa "" +
  Vite `server.proxy` /api → `backend:3001`; `host:true`, `allowedHosts:true`;
  compose usa `VITE_PROXY_TARGET`). Habilita Tailscale/HTTPS numa porta só.

- **Reforma do seletor de modelos + ícones** (commit `20e298d`, 2026-07-14):
  ModelPicker agora é guiado pela **finalidade** do trabalho (Trabalho geral,
  Documentos e planilhas, Economia, Analisar imagens, Criar imagens, Criar
  vídeo) em vez de taxonomia de famílias na 1ª tela; guarda modelos recentes
  (localStorage `fred_recent_models`); filtros avançados recolhíveis. Emojis
  trocados por ícones `lucide-react` (mapa `QUICK_ACTION_ICON` no App.jsx,
  rótulos `FAMILY_META` sem emoji). Removido código morto de "novos modelos"
  (`isNewModel`/`daysAgo`/`Date.now`). Validado com `vite build` (produção OK).

**✅ CONCLUÍDO — Acesso pelo celular via Tailscale Serve + HTTPS** (2026-07-14,
testado e confirmado pelo usuário no celular Motorola Edge 60 Pro):
- `tailscale serve` ativo: `https://frederico.tail609192.ts.net/` → proxy
  `http://127.0.0.1:5173`, modo **"tailnet only"** (só aparelhos da tailnet do
  usuário; nada exposto à internet pública). Cadeado HTTPS válido no celular.
- Cadeia completa verificada: HTTPS Tailscale → Vite (5173, proxy `/api`) →
  backend (3001). SSE do chat passa pelos 2 proxies (X-Accel-Buffering:no,
  Cache-Control:no-transform, heartbeat 15s).
- **Sem senha** (`auth:false`) — aceitável SÓ por ser tailnet-only. Para liberar
  a terceiros, ativar `APP_PASSWORD`.
- Próximo passo opcional (não feito): fazer `tailscale serve` + Docker subirem
  sozinhos com o Windows. NÃO testado de ponta a ponta em Docker por sessão
  anterior sem Docker; ESTA sessão rodou com Docker Desktop ativo e tudo no ar.
- **Armadilha resolvida:** `git config core.autocrlf` deve ficar **true** (repo
  usa LF, working tree Windows usa CRLF). Com `false`, `git add` inflava o diff
  de ~570 p/ ~2600 linhas de ruído CRLF. Não setar autocrlf=false neste repo.

## 1. O que é o projeto

**Frederico AI Studio**: aplicativo web de chat agêntico em PT-BR, conectado a
APIs compatíveis com OpenAI (o usuário usa **OpenRouter**), com **um sandbox
Docker por conversa** que executa Python/bash e gera **arquivos reais**
(xlsx, docx, pdf, imagens, zip) baixáveis no chat. Roda via `docker compose`.

- **Repositório**: `fredabsd-svg/Frederico-IA-Studio` (GitHub)
- **Branch de trabalho**: `claude/new-session-ohbtj0` — TODO push vai para ela
- **PR #1 aberto** contra `main` (main é um commit vazio criado só como base)
- Último commit: `20e298d` — reforma do seletor de modelos + ícones (2026-07-14).
  Acesso pelo celular via Tailscale/HTTPS funcionando (ver §0).

## 2. Sobre o usuário (Frederico) — como trabalhar com ele

- **Contador de formação** (mencionou CRC TO-006157/O-8), mas o app é um
  **estúdio geral** (sem viés contábil/fiscal): usa para documentos, planilhas,
  análise de dados, propostas e relatórios em geral.
- **Leigo em programação**: explicar passo a passo, sem jargão, em PT-BR.
- Ambiente: **Windows**, Docker Desktop, pasta do projeto clonada via git em
  `C:\Users\conta\Downloads\Frederico-IA-Studio\Frederico-IA\Frederico-IA-Studio`.
- Atualiza com: `git pull` + duplo clique em **`iniciar.bat`** (reconstrói) +
  Ctrl+Shift+R no navegador. **Sempre terminar respostas com essas instruções**
  quando houver mudança de código (dizer se backend mudou → rebuild).
- `.env` dele: chave do **OpenRouter** (`DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1`,
  `DEEPSEEK_MODEL=deepseek/deepseek-chat`). Usa DeepSeek V3 e GPT-4o.
- Manda **prints** quando algo dá errado; responder com diagnóstico + correção.
- Plano futuro dele: servidor caseiro com **notebook Linux + Tailscale**
  (guia pronto em `NOTEBOOK-SERVIDOR.md`; alternativa VPS em `VPS-DEPLOY.md`).

## 3. Stack e estrutura

- **Backend** (`backend/src/`, Node 20 ESM): Express, dockerode, better-sqlite3,
  multer, nanoid, openai SDK, @xenova/transformers (embeddings locais).
  - `server.js` — todas as rotas HTTP + SSE + auth + fila de tarefas
  - `agent.js` — loop agêntico (streaming token a token), orquestrador (modo
    Equipe), regras do sandbox, freio de loop de erros, validador de arquivos
  - `tools.js` — ferramentas: run_python, bash, write/read/list, zip_outputs,
    web_search/web_fetch (backend), generate_image (via IMAGE_MODEL)
  - `sandbox.js` — ciclo de vida dos containers (1 por conversa)
  - `auth.js` — login por senha (APP_PASSWORD; desligado sem ela)
  - `memory/` — **sistema de memória de longo prazo** (ver §5)
- **Frontend** (`frontend/src/`, React 19 + Vite 8, versões FIXADAS):
  `App.jsx` (principal), `MemoryPanel.jsx` (Cérebro), `components.jsx`
  (ToolStep/Slider/Modal/ModelPicker/Collapsible), `constants.js`, `styles.css`
- **Sandbox** (`sandbox/Dockerfile`): python:3.12-slim + pandas, openpyxl,
  xlsxwriter, python-docx, reportlab, weasyprint(+libs pango), matplotlib,
  PyMuPDF, ocrmypdf, ghostscript, camelot, pdf2image, pytesseract(por),
  **ffmpeg** (edição de vídeo/áudio). Sem rede, uid 1000, limites.
- **Deploy**: `docker-compose.yml` (dev: 5173/3001) e `docker-compose.prod.yml`
  (Caddy com HTTPS automático + frontend buildado + backend sem porta pública).
- Utilitários Windows: `iniciar.bat` (limpa + sobe + abre navegador), `parar.bat`.

## 4. Funcionalidades já entregues (todas funcionando)

Assistentes personalizados (Studio com templates e sliders) · Biblioteca de
templates de pedido (+ salvar mensagem como template) · Clientes/Projetos
(conversas e memória isoladas por cliente) · Modo Equipe (orquestrador
multi-assistente) · **Memória de longo prazo** (§5) · Fila de tarefas em 2º
plano (sobrevive a reinício) · Pesquisa na internet (botão globo; Google via
GOOGLE_API_KEY/CSE_ID ou DuckDuckGo) · Ditado por voz (Web Speech pt-BR) ·
Geração/edição de imagens (generate_image, IMAGE_MODEL padrão
google/gemini-2.5-flash-image, prévia no chat) · Edição de vídeo (ffmpeg) ·
Validador automático de xlsx/pdf/docx gerados (selo no cartão) · Exportar
conversa em PDF/Word · Backup .tar.gz de um botão · Análises (tokens por
assistente/modelo/conversa) · Pausar/Continuar/Parar · Streaming ao vivo +
chips de ferramenta expansíveis (mostram código executado e resultado) ·
Editar mensagem estilo ChatGPT (trunca conversa) · Copiar mensagem ·
Mensagens longas recolhíveis · Seletor de modelos com busca e categorias
(⭐ melhores p/ planilhas; 🆓 free separados) · Erros da API traduzidos
(429/401/402...) · Login por senha p/ produção · Arquivos como cartões no
chat · Upload como chips · Tela responsiva (gaveta mobile) · Tema claro/escuro.

## 5. Sistema de memória (recém-entregue — usuário AINDA NÃO TESTOU)

- **Módulos** em `backend/src/memory/`: `embeddings.js` (locais,
  Xenova/multilingual-e5-small ~112MB baixado 1x p/ ./data/models; fallback
  automático para busca por palavras), `memoryService.js` (CRUD tipado:
  perfil/preferencia/projeto/fato/manual + ranking sim+recência+importância+
  fixada + dedupe + settings + guard de segredos looksSensitive em add E
  update), `indexer.js` (após cada resposta: chunk com embedding + escopo do
  cliente; LLM barato [EXTRACT_MODEL] gera resumo/tags e extrai fatos;
  importação de exports do Claude/ChatGPT/json genérico/txt/md/html),
  `contextBuilder.js` (monta contexto por prioridade respeitando
  context_target_tokens, padrão 60k, configurável até 1M+).
- **Rotas**: `/api/memories` (GET busca/POST/PUT/DELETE, /export, /import,
  /reindex), `/api/memory-config`; legadas `/api/memory` mantidas.
- **UI**: painel "Cérebro do Assistente" (MemoryPanel.jsx).
- **Decisões da revisão adversarial** (5 fixes aplicados): chunks têm coluna
  `scope` (isolamento por cliente); apagar/truncar conversa apaga chunks e
  resumos; remover cliente move chunks p/ global; fallback do EXTRACT_MODEL
  depende da base URL; MemoryPanel valida res.ok.
- **Testes**: suíte E2E de 37 casos passou (script no scratchpad da sessão
  antiga — recriar se precisar; testa modo degradado, não o modelo real).

## 6. Decisões/armadilhas técnicas que NÃO podem regredir

1. Binds do sandbox usam `HOST_WORKSPACE_ROOT` (caminho do HOST, não do container).
2. Todo write no workspace: `chownSync(1000,1000)` (exec roda como uid 1000).
3. Timeout mata o container; próximo exec recria sozinho; reaper de 30min.
4. Backend em node:20-**slim** (alpine quebra better-sqlite3).
5. Desconexão SSE: usar `res.on('close')` com `writableEnded` — `req.on('close')`
   dispara imediatamente e matava toda resposta no 1º token (bug histórico grave).
6. Streaming: reenviar ao histórico só {role, content, tool_calls}; emitir
   fallback via delta se o modelo não gerar texto (senão balão vazio).
7. SANDBOX_RULES no prompt: cada run_python é processo novo (sem estado);
   narrar antes de cada ferramenta; ffmpeg disponível; generate_image p/ imagens.
8. Freio: 5 falhas consecutivas de ferramenta → interrompe com o último erro.
9. Orçamento de etapas do agente (`loop.js`): `AGENT_MAX_STEPS` é **PISO, não
   teto** — `Math.max(eff.steps, envSteps)`, nunca reduz o esforço escolhido
   ("Máx" vale ≥60 mesmo com env baixo). NUNCA voltar a `env || eff.steps` (o env
   sobrescrevia e cortava "Máx" para 30 em silêncio — causa real de "modo
   desenvolvedor/tarefa longa bate no limite" mesmo depois de "aumentar o número").
   Modo desenvolvedor: `AGENT_DEV_MAX_STEPS` (padrão 200). Teto absoluto:
   `AGENT_HARD_MAX_STEPS` (padrão 1,5x o base) — tarefa AINDA produtiva (ferramenta
   ok há ≤2 etapas, `lastProductiveStep`) passa do base até o teto em vez de morrer
   no meio. Mensagem de limite honesta e retomável (sem o papo antigo de CSV).
   `AGENT_HISTORY_LIMIT=60` (env).
10. Validação de caminhos com `insideBase()` (startsWith + separador) — nunca
    voltar ao startsWith puro (path traversal).
11. Frontend: dependências com versões fixadas (nunca "latest").
12. Nome de arquivo de upload: converter latin1→utf8 (acentos).
13. Container names sem `container_name` fixo no compose (evita conflito).
14. Nenhum asset de CDN no frontend — logos e imagens ficam em `frontend/public/`
    e entram no bundle pelo `vite build`. URL de CDN com `@latest` quebra sozinha
    sem aviso (mesma razão do item 11), e asset de terceiro entrega o IP de cada
    visitante a quem hospeda a CDN — inaceitável num site público com LGPD.

## 7. Regras de trabalho (processo)

- Commits em português, descritivos; atualizar este arquivo e enviar o commit ao
  GitHub na branch de trabalho atual, na mesma sessão.
- Validar antes de commitar: `node --check` em todo backend + bundle do
  frontend com esbuild (`npx esbuild frontend/src/App.jsx --jsx=automatic
  --bundle --external:react ...`) + `py_compile` em scripts Python embutidos.
- Nunca expor chaves/tokens; nunca salvar dados sensíveis; avisos de
  segurança/LGPD mantidos no README.
- Não quebrar funcionalidades existentes; migrações de banco sempre
  não-destrutivas (ALTER TABLE em try/catch).
- Respostas ao usuário: PT-BR, passo a passo, com seção "Atualize aí" no final.

## 8. Pendências / próximos passos sugeridos

0. ✅ **[RESOLVIDO em 2026-07-19] SSRF residual no `web_fetch`** (`tools.js`,
   `isBlockedHost`): o bloqueio filtrava por **texto do hostname** e deixava passar
   IPv6 entre colchetes (`http://[::1]/`) e o IPv4-mapeado; o **DNS rebinding**
   também não era coberto. Corrigido: colchetes desembrulhados, IPv4-mapeado
   tratado, faixa link-local completa, e resolução de DNS com validação de cada
   IP antes do fetch (`assertHostResolvesPublic`). Ver a entrada de log no topo
   deste arquivo. Os formatos decimal/hex/octal já eram neutralizados pelo parser
   de URL. **Ainda pendente nesta linha:** `ENVIRONMENT_QUERY_RE` (`agent.js`) é
   amplo demais e dispara um `bash` de auditoria no sandbox em mensagens comuns —
   estreitar.
1. **Usuário testar a memória** (git pull + iniciar.bat; 1ª conversa baixa o
   modelo de embeddings ~112MB) — perguntar "quem sou eu?" após algumas conversas.
2. Testar **importação** do export do Claude (conversations.json).
3. Futuro: consolidação/decaimento de memórias; indexação retroativa das
   conversas antigas da instalação; geração de vídeo (fal.ai/Replicate);
   multiusuário (contas separadas); montar o notebook-servidor com Tailscale.

## 9. Estado do git

- **Atualizado 2026-07-20:** a `main` está em produção com a frente LGPD
  completa mergeada (PRs #47, #48 e #49 — ver a primeira seção deste arquivo).
  O fluxo de trabalho recente: branch `claude/*` por frente de trabalho →
  PR → merge na main na mesma sessão. Validação usada nos PRs LGPD:
  `node --check` no backend, testes com `node --test` (backend 29 pass /
  frontend 7 pass) e `vite build` limpo. Obs.: no ambiente de dev remoto o
  `npm ci` do backend precisa de `--ignore-scripts` (o binário do sharp não
  baixa atrás do proxy — não afeta o Docker do usuário).
- **Deixados de fora de propósito** (não commitar sem intenção clara):
  - `frontend/dist/` — saída de build (não versionar).
  - `frontend/package-lock.json` (M): só teve remoção de binários de plataforma
    pelo `npm install` do container Linux; `package.json` não mudou.
  - Notas soltas no root: `CONTINUIDADE-MEU.md`, `CRITICA-DESIGN.md`,
    `monitor_rotinas_dominio.py`, `guia_rotinas_automaticas_dominio.md`.
- `backend/node_modules` local desta sessão de dev tinha transformers sem o
  binário sharp (limitação do ambiente de dev, NÃO afeta o Docker do usuário).
