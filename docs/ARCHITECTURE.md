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

- **Eventos ao frontend:** `token`, `tool`, `tool_result`, `file`, `status`, `execution_failed`, `free_queue`, `free_status`, `done`, `error`.
- **Persistido:** `messages` (+`execution_meta`, `memory_meta`, `multi_meta`), `files`, `usage`, `usage_daily`, `execution_checkpoints`, `conversation_chunks`.
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
- **Persistido:** `multi_meta` na mensagem final; checkpoints por etapa via `runAgent`.
- **Lacuna crítica (não corrigida nesta auditoria):** o pipeline **não tem coordenador durável**.
  O checkpoint é do `runAgent` de **uma etapa**; não há `pipeline_run_id`/`current_stage`/
  `completed_stages` persistidos. Se o backend reiniciar no meio, a próxima etapa pendente
  **não** é retomada. Ver F-15.

---

## 6. Fluxo de ferramentas (`tools.js`)

| Ferramenta | Onde roda | Rede |
| --- | --- | --- |
| `run_python`, `bash`, `zip_outputs` | Sandbox Docker | Desligada, salvo autorização do turno |
| `write_file`, `read_file`, `list_files` | Backend (dentro do workspace) | — |
| `web_search`, `web_fetch` | Backend | Sim, com bloqueio de SSRF |
| `consultar_cnpj` | Backend (BrasilAPI/ReceitaWS) | Sim |
| `generate_image` | Backend (provedor do usuário) | Sim |
| `github_*` | Backend (o token **nunca** entra no sandbox) | Sim |

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
- **Testes:** `src/sandbox.isolation.test.js` (11 casos), `src/sandbox.id.test.js`.

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
embeddings.js    → @xenova/transformers local; degrada para busca lexical se indisponível
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

## 12. Hierarquia de prompts (`agent/prompts.js`, `promptRegistry.js`, `promptPolicy.js`)

Ordem real de montagem, do mais forte ao mais fraco:

1. núcleo global imutável (`global-core@3.1.0`);
2. contrato de ferramentas (`tool-contract@3.1.0`) — só as ferramentas **autorizadas**;
3. perfil do assistente (`protectedProfilePrompt` — prompt do usuário **não** amplia permissão);
4. modo de trabalho (desenvolvedor / multimodelo / artefato);
5. memória → `untrustedContext()`;
6. repositório e arquivos → `untrustedContext()`;
7. respostas de outros modelos → `untrustedContext()` + `MULTI_ARTIFACT_PROTOCOL`;
8. pedido atual do usuário;
9. resultados de ferramentas (role `tool`).

`promptPolicy.js` decide o que entra por turno; `toolProtocol.js` limpa protocolo de
ferramenta que vaze como texto (`sanitizeToolProtocolText`), na exibição **e** na exportação.
- **Testes:** `agent/promptPolicy.test.js`, `agent/promptRegistry.test.js`, `agent/prompts.dev.test.js`, `toolProtocol.test.js`, `agent/assistantPolicy.test.js`.
- **Lacuna:** não há bateria adversarial de injeção (README malicioso, delimitador fechado
  à força, resposta maliciosa de outro modelo). Ver F-17.

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

- **Testes:** `agent/checkpoint.test.js`, `agent/executionState.test.js`, `agent.control.test.js`.
- **Lacuna:** não há teste de retomada após **interrupção real do processo** (matar o Node no
  meio e continuar). Ver F-14.

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
- **Testes:** `connectors.github.test.js`, `hooks/useDevProjects.test.js`.
- **Lacuna:** não há teste de clone/commit/push com um servidor git local. Ver F-19.

---

## 15. Copiloto (Nino) e Companion

- `companion/monitor.js` observa o git da conversa por `execInActiveSandbox` — **observa sem
  materializar container** (a versão anterior criava um sandbox a cada ciclo de polling e
  podia derrubar o do modo dev).
- `companion/health.js` amostra memória/CPU; `incidents.js`, `errorDigest.js`, `bugAnalysis.js`,
  `suggestions.js`, `permissions.js` alimentam a Central de Diagnósticos.
- Chat do copiloto isolado do chat principal (migrações 017–019).

---

## 16. Frontend

```
main.jsx → AuthGate → App.jsx (1.497 linhas)
  ├─ hooks/: useChat (SSE), useConversations, useAssistants, useTasks, useFileUploads,
  │          useDevProjects, useDocling, useCompanion, useCopilot, useCopilotChat, useSpeech
  ├─ componentes de painel: SettingsHub, DeveloperPanel, MemoryPanel, ProviderPanel,
  │          MultiModelBoard/Picker, DoclingPanel, CopilotWorkspace, Companion, ...
  └─ CSS: styles.css + v2.css + 8 arquivos temáticos (auth, camera, companion,
          copilot, dev-handoff, docling, landing, nino, promptcoach)
```

**Medições de 2026-07-25** (não corrigidas nesta auditoria):
- `App.jsx`: 62 `useState`, 13 `useEffect`, 12 `useRef` num único componente.
- Bundle: **932 KB** de JS num **único chunk** (287 KB gzip) + 183 KB de CSS.
  Sem code splitting, sem `React.lazy`.
- Sem virtualização de listas; Markdown reparseado durante o streaming.
- **Catraca no CI:** teto de 1.000 KB — impede crescimento silencioso enquanto a
  decomposição não é feita. Ver F-20 e F-21.

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

Verificado no CI por `backend/scripts/check-migrations.mjs`: banco vazio → 20 migrações →
reexecução no-op → 26 tabelas essenciais → escrita/leitura/cascade.

---

## 18. Desempenho — linha de base medida

| Métrica | Valor em 2026-07-25 | Orçamento adotado |
| --- | --- | --- |
| JS do frontend | 932 KB (287 KB gzip), 1 chunk | ≤ 1.000 KB (catraca no CI) |
| CSS | 183 KB (31 KB gzip) | sem teto ainda |
| Suíte backend | ~5 s (495 casos) | ≤ 60 s |
| Suíte frontend | ~0,3 s (34 casos) | ≤ 30 s |
| Migrações em banco vazio | < 2 s | ≤ 30 s |
| Sandboxes simultâneos por usuário | 2 (`MAX_SANDBOXES_PER_USER`) | — |
| Runs simultâneos por usuário | 5 (`MAX_ACTIVE_RUNS_PER_USER`) | — |
| Uploads simultâneos por usuário | 2 (`UPLOAD_MAX_CONCURRENT_PER_USER`) | — |
| RAM por requisição de upload | ~0 (streaming) — era até ~1 GB | — |

Não medidos nesta auditoria: tempo de carregamento inicial no navegador, tempo para abrir
uma conversa longa, consultas lentas do Postgres, RAM do backend sob carga. Ver F-22.
