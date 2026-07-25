# Auditoria técnica de produção — Frederico AI Studio

**Data:** 2026-07-25 · **Branch:** `claude/frederico-audit-production-gduf4s`
**Base:** `d56082f` (main) · **Método:** leitura do código, execução das suítes,
PostgreSQL real local, boot do backend, requisições HTTP reais.

---

## 1. Resumo executivo

O Frederico AI Studio é um sistema **maduro e bem construído** na maior parte: o
tratamento de caminhos, o bloqueio de SSRF, o endurecimento do container, a criptografia
de segredos, o protocolo de ferramentas e o reparo de respostas estão em nível de
produção, com testes de verdade por trás. O problema **não** era falta de cuidado — era um
conjunto de premissas de instalação **pessoal** que sobreviveram à virada para
**multiusuário**.

Cinco delas eram materiais:

1. **O workspace físico e o mapa de sandboxes não tinham dono.** A única barreira contra
   acesso cruzado era a checagem de posse no banco nunca falhar. (F-01)
2. **Um usuário derrubava os sandboxes de todos.** Mexer nas próprias pastas do PC
   chamava `destroyAllSandboxes()`. (F-02)
3. **O backup não levava a chave mestra.** Restaurar devolvia o banco íntegro com **todos
   os segredos ilegíveis**. (F-05)
4. **Administrador era uma string de e-mail não verificada.** Quem registrasse aquele
   endereço baixava o backup de todos os usuários — sem deixar registro. (F-06)
5. **Uploads em memória:** ~1 GB de Buffer possível numa única requisição, sem teto total,
   sem cota, sem limite de concorrência. (F-07)

As cinco foram **corrigidas, testadas e commitadas**. Junto vieram containers órfãos
(F-03), a política honesta do antivírus (F-10) e um CI que passou a exercitar
PostgreSQL real, as 20 migrações e todos os testes do frontend (F-08, F-09).

O sexto risco crítico — **F-04, o `docker.sock` montado no backend** — foi corrigido numa
segunda rodada, com um guarda validador dedicado (§3, F-04). Permanecem abertas as lacunas
de teste e de frontend (F-11 a F-23), que são ausências de cobertura, não defeitos
reproduzidos.

**Classificação final: 🟡 AMARELO — apto com restrições.** Critérios e condições em §6.

**Testes:** 578 no total (backend 497, frontend 37, guarda do Docker 40, Python 4),
**todos passando**, com PostgreSQL real e **zero pulados**. Linha de base antes da
auditoria: 452 no backend (2 pulados), 34 no frontend — dos quais o CI executava 10.

---

## 2. Matriz de riscos

| ID | Achado | Sev. | Status |
| --- | --- | --- | --- |
| F-01 | Workspace e sandbox sem dono na chave física | 🔴 Crítica | ✅ Corrigido |
| F-02 | `destroyAllSandboxes()` global disparado por ação de um usuário | 🔴 Crítica | ✅ Corrigido |
| F-03 | Containers órfãos após queda do backend | 🟠 Alta | ✅ Corrigido |
| F-04 | `/var/run/docker.sock` montado no backend | 🔴 Crítica | ✅ **Corrigido** (guarda validador) |
| F-05 | Backup sem a chave mestra → restauração perde todos os segredos | 🔴 Crítica | ✅ Corrigido |
| F-06 | Admin por e-mail não verificado, sem auditoria | 🔴 Crítica | ✅ Corrigido |
| F-07 | Upload em memória (~1 GB/requisição), sem cota nem concorrência | 🟠 Alta | ✅ Corrigido |
| F-08 | CI sem PostgreSQL: 20 migrações nunca exercitadas | 🟠 Alta | ✅ Corrigido |
| F-09 | CI rodava 3 dos 7 arquivos de teste do frontend | 🟡 Média | ✅ Corrigido |
| F-10 | Arquivo apresentado como aceito sem dizer que não foi verificado | 🟠 Alta | ✅ Corrigido |
| F-11 | Sem quarentena/reprocesso do que passou em modo degradado | 🟡 Média | ⚠️ Aberto |
| F-12 | Sem teste integrado de SSE / concorrência entre conversas | 🟠 Alta | ⚠️ Aberto |
| F-13 | Sem provedor HTTP simulado completo | 🟡 Média | ⚠️ Aberto |
| F-14 | Sem teste de retomada após interrupção real do processo | 🟠 Alta | ⚠️ Aberto |
| F-15 | Pipeline multimodelo sem coordenador durável | 🟠 Alta | ⚠️ Aberto |
| F-16 | Sem suíte de relevância de memória com casos negativos | 🟡 Média | ⚠️ Aberto |
| F-17 | Sem bateria adversarial de injeção de prompt | 🟠 Alta | ⚠️ Aberto |
| F-18 | Docling não exercitado com corpus documental real | 🟡 Média | ⚠️ Aberto |
| F-19 | Fluxo GitHub sem teste com git local | 🟡 Média | ⚠️ Aberto |
| F-20 | `App.jsx` com 62 `useState`; sem code splitting (932 KB, 1 chunk) | 🟡 Média | ⚠️ Aberto (catraca no CI) |
| F-21 | CSS em camadas sobrepostas, sem inventário | 🟢 Baixa | ⚠️ Aberto |
| F-22 | Desempenho de runtime não medido (carregamento, consultas, RAM) | 🟡 Média | ⚠️ Parcial |
| F-23 | Validação de artefato sem bateria de arquivos reais | 🟡 Média | ⚠️ Aberto |
| F-24 | `CONTINUIDADE.md` misturava histórico e estado atual | 🟢 Baixa | ✅ Corrigido |

---

## 3. Achados corrigidos

### F-01 — Workspace e sandbox sem dono na chave física

- **Severidade:** Crítica · **Status:** Corrigido
- **Evidência:** `sandbox.js` (versão anterior) — `workspaceFor(id)` montava
  `path.join(root, conversationId)`; `sessions` era `Map<conversationId, …>`;
  `destroyConversation(conversationId)` e `execInActiveSandbox(conversationId, …)` idem.
- **Arquivo e linhas:** `backend/src/sandbox.js:149-163, 75, 199-222, 424-432` (antes).
- **Fluxo afetado:** upload, ferramentas, sandbox, GitHub, Docling, exportação, anexos.
- **Causa raiz:** o modelo de dados virou multiusuário (`user_id` em toda tabela na
  migração 003), mas a **chave física** continuou a de instalação pessoal — uma conversa.
- **Impacto:** defesa em camada única. Qualquer rota futura que esquecesse o
  `WHERE user_id=?`, qualquer falha parcial no `destroyConversation`, ou uma colisão de id
  (o `:id` da URL é **escolhido pelo cliente**, validado só por
  `/^[A-Za-z0-9_-]{6,128}$/`) exporia arquivo de um usuário a outro. Não foi possível
  reproduzir vazamento pelas rotas atuais — a checagem no banco está correta em todas.
  Por isso: **risco de arquitetura confirmado**, exploração pelas rotas de hoje **não
  reproduzida**.
- **Como reproduzir (a fragilidade):** com o código antigo, `workspaceFor('abcdef')`
  devolvia o **mesmo** diretório para qualquer usuário; só a rota impedia o encontro.
- **Correção implementada:** layout `WORKSPACE_ROOT/users/<userDirName(userId)>/<conversa>`;
  `workspaceFor(conversationId, userId)` com `userId` **obrigatório**
  (`WORKSPACE_SCOPE_REQUIRED`); `userDirName()` injetivo (ids inseguros viram
  `h_<sha256[0:40]>`); `sessionKey(userId, conversationId)` no mapa de sandboxes, no
  single-flight, no cap por usuário, no reaper e no `destroyConversation`; `userId`
  propagado por ~20 pontos de chamada (rotas, agente, ferramentas, GitHub, Docling,
  anexos, monitor); migração automática dos diretórios legados no boot e no primeiro
  acesso, sem sobrescrever destino existente.
- **Testes adicionados:** `sandbox.isolation.test.js` (11 casos) e
  `routes/upload.http.test.js` (isolamento em rota real).
- **Resultado:** 578 testes passando, 0 falhas.
- **Risco de regressão:** **médio** — mudança de assinatura ampla. Mitigado por
  `userId` obrigatório (um chamador esquecido **falha**, não grava em caminho sem dono) e
  por `grep` exaustivo dos pontos de chamada.
- **Rollback:** reverter `78fd482` e mover os diretórios de volta
  (`docs/OPERATIONS.md` §4).
- **Pendências:** os diretórios legados de conversas **sem dono no banco** ficam onde
  estão (nada é adivinhado nem apagado); o log do boot informa quantos são.

### F-02 — `destroyAllSandboxes()` global disparado por ação de um usuário

- **Severidade:** Crítica · **Status:** Corrigido
- **Evidência:** `routes/pcFolders.js:51,57,63` chamava `destroyAllSandboxes()` no POST,
  PUT e DELETE de pastas do PC; `sandbox.js:53-61` iterava **todo** o mapa.
- **Fluxo afetado:** qualquer execução em andamento, de qualquer usuário.
- **Causa raiz:** a invalidação de cache foi escrita quando havia um usuário só.
- **Impacto:** negação de serviço cruzada — o usuário A adiciona uma pasta e mata o
  sandbox do usuário B no meio de uma geração de planilha. Perda de trabalho em andamento.
- **Como reproduzir:** dois usuários com sandbox ativo; A chama
  `POST /api/pc-folders`; o container de B é removido.
- **Correção implementada:** `destroySandboxesForUser(userId)` filtra por
  `entry.userId`. `destroyAllSandboxes()` continua exportado apenas para
  manutenção/testes, fora do alcance de rota de usuário.
- **Testes adicionados:** *"mudar as pastas do PC de um usuário NÃO derruba o sandbox de
  outro"* — dois usuários, três sandboxes, verifica quais foram removidos.
- **Risco de regressão:** baixo. **Rollback:** reverter `78fd482`.

### F-03 — Containers órfãos após queda do backend

- **Severidade:** Alta · **Status:** Corrigido
- **Evidência:** `sessions` é um `Map` em memória; os containers rodam `sleep infinity`.
  Não havia label nem reconciliação. `AutoRemove: true` só age no **stop**.
- **Impacto:** queda do backend/host deixava containers vivos, invisíveis ao reaper e ao
  cap por usuário, consumindo RAM/CPU até intervenção manual.
- **Correção implementada:** labels
  `com.frederico.{app,user,conversation,instance,manager-version}`;
  `selectOrphanContainers()` (função **pura**) escolhe o que remover: só containers com a
  label do app **e** de outra instância, ou desta instância mas fora do mapa e além da
  carência; `reconcileSandboxes()` no boot (carência 0) e a cada 15 min;
  métricas em `/api/health`.
- **Testes adicionados:** dois casos — inclusive um com container de terceiro
  (`postgres`) na lista, provando que **nunca** é selecionado.
- **Risco de regressão:** baixo para instalação de processo único (a suposição do app).
  Com dois backends no mesmo daemon, é preciso `SANDBOX_RECONCILE_ON_BOOT=false` —
  documentado em `docs/OPERATIONS.md`.

### F-04 — `/var/run/docker.sock` montado no backend

- **Severidade:** Crítica · **Status:** Corrigido (segunda rodada, 2026-07-25)
- **Evidência:** `docker-compose.prod.yml` e `docker-compose.yml` →
  `volumes: - /var/run/docker.sock:/var/run/docker.sock` no serviço `backend`.
- **Impacto:** o socket do Docker equivale a root no host — basta criar um container com
  `Privileged: true` e `/` montado. Uma RCE no processo Node deixava de ser "comprometeu o
  backend" e virava "comprometeu a máquina".
- **Superfície de entrada:** dependências npm, parsing de upload,
  `spawn('git'|'pg_dump'|'tar'|'chown')`, Chromium headless do `web_fetch`, e conteúdo
  controlado pelo modelo chegando a essas bordas.
- **Por que o plano original não bastava:** a primeira rodada recomendou um
  `docker-socket-proxy` de prateleira. Esses proxies filtram **método e caminho**; como o
  app precisa de `POST /containers/create`, liberar a rota libera junto o corpo que cria o
  container privilegiado. **Filtrar rota não fecharia o buraco** — a correção precisava ler
  e validar o corpo da requisição.
- **Correção implementada:** serviço `docker-guard/` (Node, **sem dependências npm** — a
  menor superfície possível no processo que carrega o privilégio). É o único container com
  o socket; o backend fala HTTP com ele (`DOCKER_HOST=tcp://docker-guard:2375`). Como o
  dockerode fala o mesmo protocolo por TCP ou socket, o código de sandbox do backend não
  mudou. O guarda aplica:
  1. **allowlist de rotas** — só ping, version, inspect de imagem, list/create/start/kill/
     wait/remove/inspect de container e create/start/inspect de exec. `build`,
     `images/create`, `volumes`, `networks`, `commit`, `swarm`, `plugins`, `attach`,
     `archive` e `containers/{id}/update` são 403;
  2. **validação do corpo de `/containers/create`** — recusa `Privileged`, `CapAdd`,
     `Devices`, GPU, `PidMode`, `IpcMode`/`UTSMode`/`UsernsMode` do host, `CgroupParent`,
     `Sysctls`, `NetworkMode: host|container:*`, volume nomeado e `Mounts` não-bind;
  3. **endurecimento obrigatório (fail-closed)** — exige `CapDrop:[ALL]`,
     `no-new-privileges:true` e `PidsLimit`/`Memory`/`NanoCpus` dentro de tetos;
  4. **binds** — origem tem de estar sob a raiz autorizada (com `..` normalizado e sem
     confundir prefixo), e há blocklist absoluta de `/`, `/var/run`, `/proc`, `/sys`,
     `/dev`, `/etc`, `/root`, `/usr`, `/var/lib/docker` e qualquer `docker.sock`;
  5. **posse por label** — operar container/exec exige `com.frederico.app`; alvo
     desconhecido é recusado. Um backend comprometido não derruba o Postgres do compose;
  6. **imagem** — só `SANDBOX_IMAGE`.
  O `hijack`/upgrade do exec (por onde toda ferramenta executa) é validado uma vez e vira
  túnel de bytes, preservando o protocolo de frames do Docker.
- **Como reproduzir (antes):** com o socket no backend, um `POST /containers/create` com
  `{"HostConfig":{"Privileged":true,"Binds":["/:/host"]}}` daria root no host. Hoje o
  guarda responde 403 e a requisição **não chega** ao daemon — é exatamente o que os testes
  verificam.
- **Testes adicionados:** `docker-guard/src/policy.test.js` (28 casos, um por fuga
  conhecida) e `docker-guard/src/server.test.js` (12 casos — proxy real contra um daemon
  Docker **falso** num socket unix, incluindo o hijack do exec);
  `backend/src/sandbox.dockerAccess.test.js` (2). O job `compose` do CI reprova o build se
  alguém devolver o socket ao backend em qualquer um dos `docker-compose`.
- **Resultado:** 578 testes passando, 0 falhas.
- **Risco de regressão:** **médio-baixo** no caminho feliz (o backend não mudou de
  biblioteca nem de chamadas), **mas** o guarda passa a ser um ponto no caminho de toda
  execução de ferramenta: se a política recusar algo legítimo, a ferramenta falha. Mitigado
  por (a) todo pedido legítimo do `createContainer` atual estar coberto por teste, (b) toda
  recusa ser registrada com motivo (`[guard] RECUSADO ...`), (c) `/api/health` mostrar o
  modo vigente.
- **Rollback:** devolver `- /var/run/docker.sock:/var/run/docker.sock` ao backend e remover
  `DOCKER_HOST`. O backend volta a falar direto com o daemon (e o CI passa a reprovar, de
  propósito).
- **Pendências:** Docker rootless/Podman continua recomendado como camada extra — reduz o
  impacto de uma falha no *próprio* guarda. Egress do sandbox segue sem allowlist (F-05b).

### F-05 — Backup sem a chave mestra

- **Severidade:** Crítica · **Status:** Corrigido
- **Evidência:** `routes/backup.js:32-33` (antes) — o `tar` levava apenas o dump e
  `WORKSPACE_ROOT`. `crypto.js:46-48` guarda a chave em `DATA_DIR/encryption.key`, fora
  dos dois.
- **Impacto:** **perda de dados silenciosa na recuperação de desastre.** O banco volta
  íntegro; `decryptSecret()` devolve `null` para toda chave de IA e todo token de
  conector. Nenhuma mensagem explica o porquê.
- **Como reproduzir:** o teste faz exatamente isso — cifra num `DATA_DIR`, tenta decifrar
  noutro sem a chave (`null`), copia a chave e decifra com sucesso.
- **Correção implementada:** `encryption.key` entra no pacote quando vive em arquivo;
  quando vem de `ENCRYPTION_KEY` **não** é copiada e o manifesto avisa que o backup
  depende dela; `manifest.json` com formato, versão, data, versão do schema (última
  migração aplicada) e `sha256` de cada arquivo; `verifyExtractedBackup()`;
  trava contra backups simultâneos (antes ambos disputavam
  `/tmp/frederico-db-<data>.sql` e o download saía truncado); staging exclusivo removido
  sempre, inclusive se o cliente aborta.
- **Testes adicionados:** `backup.test.js` (6 casos, incluindo o ciclo completo).
- **Risco de regressão:** baixo. **Pendências:** não há restauração automatizada — o
  procedimento é manual e deliberado (`docs/BACKUP_RESTORE.md`).

### F-06 — Administrador por e-mail não verificado, sem auditoria

- **Severidade:** Crítica · **Status:** Corrigido
- **Evidência:** `routes/helpers.js:31-34` (antes) —
  `isAdmin(req) { return email === ADMIN_EMAIL }`. `auth.js:47` habilita
  `emailAndPassword` **sem** `requireEmailVerification`.
- **Fluxo afetado:** `/api/backup` (banco + workspaces + chave mestra de todos),
  `/api/admin/free-tier/*`, `PUT /api/docling/config`.
- **Impacto:** quem se cadastrasse com o endereço administrativo — antes do dono, ou
  depois de trocar o e-mail da própria conta — teria acesso aos dados de todos os
  usuários. Nenhuma ação administrativa deixava rastro.
- **Correção implementada:** migração 020 (`user_roles`, `admin_audit`); autoridade é o
  papel **preso ao ID**; `ADMIN_EMAIL` vira bootstrap de uso único (só enquanto não
  existir nenhum admin); `ADMIN_USER_ID` fixa por id; `requireAdmin()` +
  `recordAdminAction()` em todas as rotas administrativas, **auditando também as
  recusas**; falha de banco nunca concede acesso.
- **Testes adicionados:** `routes/admin.test.js` (6 casos), incluindo a tentativa de
  sequestro do e-mail administrativo.
- **Risco de regressão:** baixo — o administrador atual recebe o papel automaticamente no
  primeiro acesso e não perde nada.
- **Pendências:** `ADMIN_REQUIRE_VERIFIED_EMAIL` fica `false` por padrão porque esta
  instalação não envia e-mail de verificação; ligá-lo sem provedor de e-mail deixaria o
  app sem administrador.

### F-07 — Upload em memória, sem teto total, cota ou concorrência

- **Severidade:** Alta · **Status:** Corrigido
- **Evidência:** `routes/helpers.js:41` (antes) —
  `multer({ storage: multer.memoryStorage(), limits: { fileSize: 50MB, files: 20 } })`.
  `routes/conversations.js` fazia `fs.writeFileSync(target, file.buffer)` e
  `hashBuffer(file.buffer)`.
- **Impacto:** ~1 GB de Buffer numa requisição, mais cópias do hash e do antivírus. Duas
  requisições em paralelo derrubam por OOM uma VPS de 2–4 GB. Nenhuma cota de disco por
  usuário.
- **Correção implementada:** `multer.diskStorage()` com staging exclusivo por requisição;
  recusa pelo `Content-Length` **antes de ler o corpo**; teto do total real; teto de
  envios simultâneos por usuário; cota de disco por usuário; hash e varredura por
  streaming; limpeza garantida no `finally` e varredura horária de abandonados.
- **Testes adicionados:** `uploads.test.js` (11) e `routes/upload.http.test.js` (5,
  integrado com Express + Postgres + multipart real).
- **Risco de regressão:** **médio** — o caminho do upload foi reescrito. Mitigado pelo
  teste integrado ponta a ponta, que valida nome com acento, hash, tamanho, isolamento e
  ausência de temporários.

### F-08 / F-09 — CI sem PostgreSQL e com 3 dos 7 testes do frontend

- **Severidade:** Alta / Média · **Status:** Corrigidos
- **Evidência:** `.github/workflows/ci.yml` (antes) — nenhum serviço de banco; o job do
  frontend listava `src/authUrls.test.js src/sse.test.js src/alibabaCredentialCsv.test.js`
  (10 de 34 casos). As 20 migrações nunca rodavam no CI.
- **Correção implementada:** job de integração com `pgvector/pgvector:pg16` (mesma imagem
  da produção) que aplica as migrações do zero, confere idempotência, tabelas essenciais e
  cascade, roda a suíte completa e **falha se algum teste for pulado**; smoke de boot real
  com `/api/health`; verificação do portão de autenticação (9 rotas → 401); frontend com
  todos os arquivos de teste + build + catraca de bundle; matriz Node 20/22 (que já
  pegou uma regressão real: o glob do `node --test` não existe no Node 20 — ver §7);
  validação dos dois
  `docker-compose` e build da imagem; `count-tests.mjs` publicando a contagem real.
- **Resultado:** as 20 migrações verificadas em banco vazio; 26 tabelas essenciais;
  0 testes pulados.

### F-10 — Arquivo aceito sem informar que não foi verificado

- **Severidade:** Alta · **Status:** Corrigido
- **Evidência:** `clamav.js` (antes) devolvia `scanned:false` quando o clamd caía, mas o
  significado ("aceito **sem** verificação") não chegava distinto ao cliente, e não havia
  política escrita por ambiente.
- **Correção implementada:** `scanPolicy()` (desligado / degradável / obrigatório),
  `scanStatus` por lote (`verificado` | `degradado` | `sem-antivirus`), métricas de saúde,
  exposição em `/api/health`, remoção imediata do arquivo infectado e política por ambiente
  documentada em `docs/SECURITY.md` §7.
- **Testes adicionados:** 3 casos, incluindo *"o lote NUNCA se declara verificado quando o
  antivírus não analisou"*.
- **Pendências:** a interface ainda não exibe o selo diferenciado — o backend passou a
  informar, o frontend precisa consumir (**F-11**).

### F-24 — Documentação misturando histórico e estado atual

- **Severidade:** Baixa · **Status:** Corrigido
- **Evidência:** `CONTINUIDADE.md` com 2.640 linhas, contendo SQLite, `APP_PASSWORD` e
  fases concluídas ao lado do estado vigente.
- **Correção implementada:** histórico **preservado** em `docs/CHANGELOG_HISTORY.md`; novo
  `CONTINUIDADE.md` curto (estado, branch, última validação, riscos abertos, próximos
  passos); `docs/ARCHITECTURE.md`, `SECURITY.md`, `OPERATIONS.md`, `BACKUP_RESTORE.md`,
  `TESTING.md` criados; `.env.example` atualizado com as variáveis que faltavam
  (`ADMIN_USER_ID`, `ADMIN_REQUIRE_VERIFIED_EMAIL`, `UPLOAD_*`, `SANDBOX_RECONCILE_*`,
  `CLAMAV_*`).

---

## 4. Riscos abertos

### F-05b — Egress do sandbox sem allowlist quando a rede é habilitada

- **Severidade:** Média · **Status:** Aberto
- Com `networkEnabled`, o container entra na rede padrão do Docker, sem restrição de
  destino — alcança Postgres e docling-service da rede do compose. Mitigação: rede
  dedicada sem rota interna, ou proxy de egress. `docs/SECURITY.md` §4.3.

### F-15 — Pipeline multimodelo sem coordenador durável

- **Severidade:** Alta · **Status:** Aberto
- **Evidência:** `agent/multiModel.js` mantém o estado das etapas em variáveis locais do
  `runMultiModel`. O checkpoint persistido é o do `runAgent` de **uma** etapa
  (`agent/checkpoint.js`, um por conversa).
- **Impacto:** reiniciar o backend no meio de um pipeline não retoma a próxima etapa
  pendente — só o run interno da etapa que estava em curso, se houver checkpoint.
- **Correção proposta:** tabela `pipeline_runs` com `pipeline_run_id`, `current_stage`,
  `completed_stages`, `pending_stages`, `artifact_versions`, `status`, `checkpoint`,
  `updated_at`; retomada no boot; a rota `/resume` passa a consultá-la antes do checkpoint
  do agente. O versionamento por etapa já existe (`snapshotArtifactVersion`) e serve de
  base.
- **Por que não foi feito:** é uma feature nova com migração e mudança de fluxo, não uma
  correção — não cabia junto das correções críticas sem inflar o risco de regressão.

### Demais lacunas de teste e frontend

F-11 (quarentena do modo degradado), F-12 (SSE integrado), F-13 (provedor simulado),
F-14 (retomada após kill real), F-16 (relevância de memória com casos negativos),
F-17 (bateria adversarial de injeção), F-18 (corpus documental do Docling),
F-19 (git local), F-20/F-21 (decomposição do `App.jsx` e inventário de CSS),
F-22 (desempenho de runtime), F-23 (validação de artefato com arquivos reais).

Todas estão descritas em `docs/TESTING.md` §6 e `docs/ARCHITECTURE.md`. **Nenhuma foi
reproduzida como defeito** — são ausências de cobertura e de trabalho, não bugs
confirmados. O que a auditoria **não** pode afirmar, por não ter executado: que o Docling
lida bem com PDF escaneado/DRE/PGFN, que o pipeline preserva o arquivo entre revisores sob
reinício, que a memória não recupera contexto irrelevante nos casos difíceis, e que o CSS
se comporta em todas as paletas e no mobile real.

---

## 5. Impacto em dados, produção e atualização

| Aspecto | Efeito |
| --- | --- |
| **Dados existentes** | Preservados. Os workspaces legados são **movidos** (nunca copiados por cima nem apagados); em conflito, o legado fica onde está e o incidente é logado. Nenhuma migração remove coluna, tabela ou linha. |
| **Migração nova** | `020_admin_roles_audit.sql` — só cria `user_roles` e `admin_audit`. Não escreve nenhuma linha: o administrador atual recebe o papel no primeiro acesso a uma rota administrativa. |
| **Compatibilidade de API** | Uma adição: `scanStatus` na resposta de upload. Nenhum campo removido. |
| **Novos códigos de erro** | 409 (backup já em andamento), 413 (`upload_request_too_large`, `upload_quota_exceeded`), 429 (`upload_too_many_concurrent`). |
| **Comportamento novo no boot** | Migração de layout de workspace + remoção de containers órfãos do app. |
| **Atualização** | Backup → `git pull` → `up -d --build` → conferir no log `[workspace] migração de layout:` e `[sandbox] reconciliação:` → `/api/health`. |
| **Rollback** | Reverter o código; as migrações são aditivas e a versão anterior roda contra o schema novo. O layout de workspace precisa ser desfeito à mão (`docs/OPERATIONS.md` §4). |

---

## 7. Regressão pega pelo próprio CI novo

O primeiro run do CI reprovou três jobs — e a causa foi uma **regressão introduzida por
esta auditoria**, exposta exatamente pelo mecanismo que ela adicionou:

- **Sintoma:** `Could not find '.../src/**/*.test.js'`, exit 1, em ~15 s.
- **Causa:** os scripts padronizados usavam `node --test 'src/**/*.test.js'`. A expansão de
  glob pelo próprio runner só existe a partir do **Node 22**; no **Node 20** — a versão da
  imagem de produção (`node:20-slim`) — o padrão entre aspas chega literal.
- **Por que não apareceu antes:** a validação local rodou em Node 22.
- **O que pegou:** a matriz Node 20/22 do job `backend-unit`, adicionada nesta auditoria.
  O job em Node 22 passou; o em Node 20 falhou. Sem a matriz, a quebra chegaria à `main`
  e só apareceria em produção.
- **Correção:** `backend/scripts/run-tests.mjs` e `frontend/scripts/run-tests.mjs` fazem a
  descoberta dos arquivos em JS e passam caminhos explícitos ao `node --test` —
  independente da versão. `count-tests.mjs` usa o mesmo runner, para a contagem bater com
  o que o CI executa.
- **Confirmação do resto:** no mesmo run, o passo de migrações **passou** (20 aplicadas,
  reexecução no-op, 26 tabelas essenciais, cascade), assim como `lint`, `artifacts` e
  `compose`.

Vale registrar: é o comportamento desejado de um CI. A alternativa — descobrir isso num
`docker compose up` da VPS — era o cenário anterior.

---

## 6. Classificação final

### 🟡 AMARELO — apto para produção **com restrições**

**Por que não vermelho:** os cinco riscos críticos de multiusuário foram corrigidos com
teste que reproduz o problema; migrações, boot e portão de autenticação passaram a ser
verificados em CI com PostgreSQL real; a recuperação de desastre deixou de ser uma perda
silenciosa de segredos.

**Por que ainda não verde:** com o F-04 corrigido, **não há mais risco crítico aberto**.
O que impede o verde agora é só a segunda condição do enunciado: testes essenciais
listados no próprio escopo — SSE integrado, retomada após interrupção real do processo,
pipeline multimodelo retomável, injeção adversarial — **não foram executados**. Não se
classifica como pronto enquanto isso for verdade.

**Condições para operar em amarelo:**

1. `docker-guard` no ar, com `/api/health` mostrando `sandbox.docker.modo = "guarda"`.
   Host dedicado continua recomendado — agora como defesa em profundidade, não como
   única barreira.
2. `CLAMAV_REQUIRED=true`.
3. `ADMIN_USER_ID` fixado, e `user_roles` conferido depois do primeiro boot.
4. `UPLOAD_USER_QUOTA_MB` definido.
5. `ENABLE_PC_FOLDERS` desligado.
6. Backup automatizado **com** a chave mestra e restauração testada em host limpo.
7. `/api/health` monitorado (antivírus degradado, órfãos, `unhandledRejections`).
8. Um único processo de backend (ou `SANDBOX_RECONCILE_ON_BOOT=false` e ciência de que
   SSE, cancelamento e fila não são compartilhados entre réplicas).

**Para chegar ao verde**, em ordem de prioridade:

| # | Item | Achado |
| --- | --- | --- |
| 1 | Teste integrado de SSE: duas conversas, troca rápida, reconexão | F-12 |
| 2 | Provedor HTTP simulado completo | F-13 |
| 3 | Retomada após interrupção real do processo | F-14 |
| 4 | Coordenador durável do pipeline multimodelo | F-15 |
| 5 | Bateria adversarial de injeção de prompt | F-17 |
| 6 | Suíte de relevância de memória com casos negativos | F-16 |
| 7 | Egress controlado quando a rede do sandbox é habilitada | F-05b |
| 8 | Docker rootless/Podman (camada extra sobre o guarda) | F-04 |
| 9 | Validação de artefato com arquivos reais | F-23 |
| 10 | Decomposição do `App.jsx` + code splitting | F-20 |
