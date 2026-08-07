# Segurança — modelo de ameaça e controles

> Atualizado em **2026-07-25** pela auditoria de produção.
> Achados numerados (F-nn) estão em `docs/AUDITORIA_2026-07.md`.

---

## 1. Perímetro

| Fronteira | Controle |
| --- | --- |
| Internet → app | Caddy (TLS automático). O backend **não** expõe porta. |
| Cliente → API | Sessão Better Auth obrigatória em toda `/api` exceto `/health` e `/auth/*`. CORS restrito a `FRONTEND_URL`/`BETTER_AUTH_URL` (sem eles, `origin:false` — nenhuma origem externa). |
| Força bruta | Rate limit por IP: 600 req/min em `/api`, 50 POST/15 min em `/api/auth`. Limite diário de mensagens por usuário opcional. |
| Usuário → usuário | Toda query escopada por `user_id`; workspace físico e sandbox escopados pelo dono (§3). |
| Backend → sandbox | Container sem privilégios, sem rede por padrão (§4). |
| Sandbox → host | Único ponto de contato: o bind do próprio workspace. |
| Backend → internet | Bloqueio de SSRF em `web_fetch` (§6). |

---

## 2. Segredos

| Segredo | Onde vive | Proteção |
| --- | --- | --- |
| Chaves de IA do usuário (BYOK) | `user_ai_providers` | AES-256-GCM (`crypto.js`) |
| Tokens de conector (GitHub) | `user_connectors` | AES-256-GCM |
| Chave mestra | `ENCRYPTION_KEY` (env) **ou** `DATA_DIR/encryption.key` (0600) | Env tem prioridade; o arquivo é gerado no primeiro boot quando não há env |
| Segredo de sessão | `BETTER_AUTH_SECRET` | env |

Regras aplicadas no código:
- a UI **nunca** recebe a chave inteira (`maskSecret`);
- a exportação LGPD (`exportUserData`) **exclui** credenciais de propósito;
- saída de `git` passa por `scrubSecrets(out, token)` em stdout **e** stderr;
- **o token do GitHub nunca entra no sandbox** — clone/pull/push rodam no backend.

**Backup e a chave mestra:** ver `docs/BACKUP_RESTORE.md`. Resumo: quando a chave vive em
arquivo, ela **entra** no pacote (que passa a ser segredo); quando vem de `ENCRYPTION_KEY`,
ela **não** é copiada e o manifesto avisa que o backup depende dela.

---

## 3. Isolamento multiusuário

Três camadas independentes — nenhuma delas é a única barreira:

1. **Banco:** todo `SELECT/UPDATE/DELETE` de dado de usuário carrega `WHERE user_id=?`.
   `ensureConversation` recusa adotar uma conversa de outro dono (404, sem revelar existência).
2. **Disco:** `WORKSPACE_ROOT/users/<dono>/<conversa>/`. `workspaceFor()` **exige** o dono
   (`WORKSPACE_SCOPE_REQUIRED` se faltar) e `userDirName()` é injetivo — dois usuários nunca
   compartilham diretório, nem por sanitização com colisão.
3. **Sandbox:** o mapa de sessões é indexado por `(usuário, conversa)`; o cap por usuário, o
   single-flight, o reaper e o `destroyConversation` seguem a mesma chave. As pastas do PC
   montadas são só as **daquele** usuário (`pcFolderMounts(userId)`).

Ação de um usuário **não** afeta outro: `destroySandboxesForUser()` substituiu o
`destroyAllSandboxes()` global que era disparado ao mexer nas pastas do PC (F-02).

Provas: `backend/src/sandbox.isolation.test.js` (11 casos) e
`backend/src/routes/upload.http.test.js` (upload real de dois usuários).

---

## 4. Sandbox Docker — análise de ameaça

### 4.1 O que já protege o container

| Controle | Valor |
| --- | --- |
| Usuário | `sandbox` (uid 1000), nunca root |
| Capabilities | `CapDrop: ['ALL']` |
| Escalada | `no-new-privileges:true` |
| Rede | `NetworkDisabled` por padrão; abrir exige autorização **do turno** e **recria** o container (a permissão não vaza entre turnos) |
| Processos | `PidsLimit: 256` |
| Memória / CPU | `SANDBOX_MEMORY` (1–2 GB), `NanoCpus` |
| Montagens | Só o workspace da própria conversa + pastas do PC do próprio usuário. O socket do Docker **nunca** é montado dentro do sandbox |
| Vida | `AutoRemove`, reaper de 30 min, cap de 2 por usuário |
| Saída | Teto de 8 MB acumulados no backend (evita OOM com `yes`) |
| Comandos | `GUARD_PATTERNS` bloqueia destrutivos/escalada — defesa em profundidade, não a fronteira |

### 4.2 O risco original: `/var/run/docker.sock` no backend (F-04 — CORRIGIDO)

Até 2026-07-25 o `docker-compose.prod.yml` montava o socket do Docker no container do
backend. **Quem controla esse socket controla o host** (é possível criar um container privilegiado com
`/` montado). Ou seja: uma RCE no processo Node deixa de ser "comprometeu o backend" e
passa a ser "comprometeu a máquina".

**Superfície de ataque do backend** (por onde uma RCE poderia entrar): dependências npm,
parsing de upload, `spawn('git'|'pg_dump'|'tar'|'chown')`, Chromium headless do `web_fetch`,
e conteúdo controlado pelo modelo chegando a essas bordas.

### 4.3 A correção: o guarda validador (`docker-guard`)

**Status: F-04 CORRIGIDO.** O backend não monta mais o socket. Quem o detém é um serviço
dedicado — `docker-guard/` — e o backend fala HTTP com ele
(`DOCKER_HOST=tcp://docker-guard:2375`).

#### Por que não um proxy de socket pronto

Os proxies conhecidos de socket Docker filtram por **método e caminho**. O app precisa
legitimamente de `POST /containers/create`; liberar essa rota libera junto o **corpo** que
cria um container privilegiado com `/` montado. **Filtrar rota não fecha o buraco.** Por
isso o guarda lê e valida o corpo — é o que o plano anterior desta seção não previa.

#### O que o guarda faz

| Camada | Regra |
| --- | --- |
| **Allowlist de rotas** | Só o que o sandbox usa: ping, version, inspect de imagem, list/create/start/kill/wait/remove/inspect de container, create/start/inspect de exec. Tudo mais é 403 — inclusive `build`, `images/create`, `volumes`, `networks`, `commit`, `swarm`, `plugins`, `attach`, `archive` (ler/escrever arquivos dentro de containers) e `containers/{id}/update` (afrouxar limites depois de criado). |
| **Corpo de `/containers/create`** | Recusa `Privileged`, `CapAdd`, `Devices`, `DeviceRequests` (GPU), `PidMode`, `IpcMode` (host), `UTSMode`, `UsernsMode`, `CgroupParent`, `Sysctls`, `NetworkMode: host` ou `container:*`, volumes nomeados e `Mounts` que não sejam bind. |
| **Endurecimento obrigatório** (fail-closed) | **Exige** `CapDrop: [ALL]`, `no-new-privileges:true`, `PidsLimit`, `Memory` e `NanoCpus` dentro de tetos. Um backend comprometido não consegue pedir um container "mole". |
| **Imagem** | Só `SANDBOX_IMAGE`. Não dá para subir nada do registry. |
| **Binds** | Toda origem precisa estar sob a raiz de workspace autorizada, com `..` normalizado antes da comparação e sem confundir prefixo (`/ws-outro` **não** está dentro de `/ws`). Blocklist absoluta: `/`, `/var/run`, `/proc`, `/sys`, `/dev`, `/etc`, `/root`, `/usr`, `/var/lib/docker` e **qualquer caminho terminado em `docker.sock`**. |
| **Posse por label** | Operações sobre um container/exec específico só passam se o alvo tiver `com.frederico.app=frederico-ai-studio`. Um backend comprometido não derruba o Postgres nem lê outro container. Exec é resolvido até o container dono. Fail-closed: alvo desconhecido = recusa. |
| **Label obrigatória na criação** | Sem ela o container ficaria invisível para a reconciliação de órfãos e para a checagem de posse. |

O `hijack`/upgrade do exec — por onde **toda** execução de ferramenta passa — é validado
uma vez e então vira túnel de bytes, preservando o protocolo de frames do Docker.

O guarda **não tem dependências npm**: só `http`/`net` do Node. O processo que carrega o
privilégio tem a menor superfície possível.

#### O que isso muda na prática

Antes: RCE no backend ⇒ **root no host**.
Depois: RCE no backend ⇒ o atacante consegue, no máximo, o que o sandbox já podia fazer —
criar/derrubar sandboxes do próprio app, sem privilégio, sem capabilities, sem montar nada
fora do workspace e sem tocar em containers de terceiros.

#### Provas

`docker-guard/src/policy.test.js` (28 casos) e `docker-guard/src/server.test.js` (12 casos,
proxy real contra um daemon Docker **falso** num socket unix). Cada teste de bloqueio
verifica também que a requisição **não chegou** ao daemon. O CI ainda reprova o build se
alguém devolver o socket ao backend em qualquer um dos `docker-compose`.

#### Configuração

| Variável (no serviço `docker-guard`) | Padrão | Papel |
| --- | --- | --- |
| `GUARD_WORKSPACE_ROOT` | `HOST_WORKSPACE_ROOT` | Raiz autorizada dos binds, **no caminho do host** |
| `GUARD_ALLOW_PC_FOLDERS` | `false` | Libera binds fora do workspace (instalação pessoal). A blocklist continua valendo |
| `GUARD_EXTRA_BIND_ROOTS` | vazio | Restringe as pastas do PC a raízes declaradas |
| `GUARD_MAX_MEMORY_MB` / `GUARD_MAX_CPUS` / `GUARD_MAX_PIDS` | 8192 / 4 / 1024 | Tetos por container |
| `GUARD_LOG_ALLOWED` | `false` | Registra também o que passou (depuração) |

Toda recusa é registrada com motivo (`[guard] RECUSADO ...`). `/api/health` mostra em
`sandbox.docker` se o backend está atrás do guarda (`modo: "guarda"`) ou com o socket na
mão (`modo: "socket-direto"`) — este último ainda é possível em desenvolvimento local e
emite aviso no boot em produção.

#### Camadas ainda recomendadas (defesa em profundidade)

O guarda remove a escalada trivial. Duas medidas adicionais valem num ambiente hostil:

1. **Docker rootless ou Podman** para o daemon dos sandboxes — o socket passa a valer os
   privilégios de um usuário sem poder, não de root. Reduz o impacto de uma falha *no
   próprio guarda*.
2. **Host dedicado** continua sendo boa prática, ainda que não seja mais a única barreira.

### 4.4 Egress quando a rede é habilitada

Com `networkEnabled`, o container ganha a rede padrão do Docker — **sem** allowlist de
destino. Um script gerado pelo modelo pode alcançar a rede interna do compose (Postgres,
docling-service). Mitigação recomendada: rede Docker dedicada sem rota para a rede do
compose, ou egress via proxy com allowlist. **Risco aberto F-05.**

---

## 5. Autorização administrativa

**Antes:** ser administrador era ter o e-mail igual a `ADMIN_EMAIL`. Como o cadastro por
e-mail/senha não exige verificação, quem registrasse aquele endereço — antes ou depois do
dono — baixava o backup completo (banco + workspaces + chave mestra de **todos**), mexia no
modo gratuito e na configuração global do Docling. Nada disso deixava registro (F-06).

**Agora** (migração 020):

| Camada | Regra |
| --- | --- |
| Autoridade | Tabela `user_roles` (papel preso ao **ID** do usuário) |
| `ADMIN_USER_ID` | Fixa o admin por id — **modo recomendado em instalação pública** |
| `ADMIN_EMAIL` | Apenas **bootstrap**: o titular reivindica o papel na primeira rota administrativa, e **só enquanto não existir nenhum admin**. Depois disso o e-mail não autoriza mais nada |
| `ADMIN_REQUIRE_VERIFIED_EMAIL` | Opcional (padrão `false` — ligar sem envio de e-mail configurado deixaria o app sem admin) |
| Auditoria | `admin_audit` registra ação, usuário, e-mail, IP, user-agent e detalhe — **inclusive as recusas** |
| Falha de banco | Nunca concede acesso (nega e loga) |

Trocar o e-mail da conta administrativa **não** perde o papel; criar outra conta com o mesmo
e-mail **não** ganha o papel. Provas em `backend/src/routes/admin.test.js`.

Para transferir o papel: `DELETE FROM user_roles WHERE role='admin';` e reivindicar de novo,
ou inserir a linha do novo administrador diretamente.

---

## 6. Rede de saída do backend (SSRF)

`web_fetch` valida **antes de cada conexão e a cada redirecionamento** (máx. 4):
- `isBlockedHost`: localhost, `.local`, `.internal`, faixas privadas, link-local
  (`169.254.0.0/16` — metadados de nuvem), CGNAT, multicast, IPv6 (`::1`, ULA `fc00::/7`,
  link-local `fe80::/10`) e IPv4 mapeado em IPv6 (`::ffff:127.0.0.1` e a forma hexadecimal);
- `assertHostResolvesPublic`: resolve o nome e confere **cada IP** (anti-DNS-rebinding);
- teto de bytes (`WEB_FETCH_MAX_BYTES`, 1,5 MB) e recusa de conteúdo não textual.

Resta a janela TOCTOU entre resolver e conectar — mitigação padrão do ecossistema.
Testes: `backend/src/tools.ssrf.test.js`.

O **navegador headless** do backend (miniatura de página do `web_fetch` e
impressão em PDF do Modo Design) passa pela mesma guarda: `guardRoute` em
`agent/pageShot.js`, reaproveitada por `design/pdf.js` em vez de duplicada. Ali
os redirecionamentos são seguidos À MÃO (`route.fetch({maxRedirects:0})`), porque
o `page.route()` do Playwright **não** é chamado no destino de um
redirecionamento — uma porta ingênua reabriria SSRF por 302 para
`169.254.169.254`. Testes: `backend/src/agent/pageShot.test.js`.

---

## 6.1 Modo Design — HTML gerado por IA no navegador

O artefato de um projeto de design é código não confiável, e roda em dois
navegadores. As defesas, em resumo (detalhe em `docs/DESIGN_STUDIO.md`):

| Onde | Controle |
| --- | --- |
| Prévia no navegador do usuário | `Content-Security-Policy: sandbox allow-scripts` na resposta **e** `sandbox="allow-scripts"` no `<iframe>` — sem `allow-same-origin` em nenhum dos dois, o que põe o documento em ORIGEM OPACA (sem cookie de sessão, sem `localStorage`, sem o DOM do app) |
| URL da prévia | capacidade de 32 caracteres aleatórios, na única rota de API sem sessão; regenerável por `POST /api/design/projects/:id/preview-token` |
| Impressão em PDF | Chromium do backend com a guarda de rede do §6; o conteúdo entra por `setContent` (about:blank, origem opaca), sem navegação de topo |
| Antes de renderizar | `contentMatchesType` confere que o conteúdo salvo bate com o `output_type` |
| Marca e ajustes do usuário | cor só em hex, nome de fonte sem aspas/`;`, medida dentro da faixa do token — todos entram dentro de CSS |
| Ponte de edição (v2) | injetada **só na prévia**, nunca na exportação; é constante (nada interpolado); o descritor do elemento que ela envia passa por `sanitizeTarget` antes de virar prompt. A interface valida a mensagem pela JANELA (`event.source === iframe.contentWindow`) — numa origem opaca, `event.origin` chega como "null" e não prova nada |

Regressões guardadas em `backend/src/routes/design.http.test.js` (cabeçalhos) e
`e2e/tests/design.spec.js` (atributo do iframe, no navegador de verdade).

---

## 7. Uploads e antivírus

Ver `docs/OPERATIONS.md` §3 para os limites. Política do antivírus:

| Ambiente | Configuração | Comportamento com o clamd fora do ar |
| --- | --- | --- |
| Pessoal/local | `CLAMAV_HOST` vazio | Sem varredura; a API responde `scanStatus: "sem-antivirus"` |
| Público, primeiro deploy | `CLAMAV_REQUIRED=false` | Aceita e marca `scanStatus: "degradado"` — enquanto o clamd baixa assinaturas (~5 min) |
| **Público, regime** | **`CLAMAV_REQUIRED=true`** | **Recusa o envio (503)** em vez de entregar arquivo não analisado |

Regra inegociável: **um arquivo nunca é apresentado como verificado se não foi analisado.**
`/api/health` expõe a política vigente, se houve degradação e o horário do último erro.
Arquivo infectado é apagado do disco imediatamente.

---

## 8. Conteúdo não confiável e injeção de prompt

Memória recuperada, conteúdo de repositório, texto de página web, saída de ferramenta e
resposta de outro modelo entram embrulhados por `untrustedContext()` — como **dado**, nunca
como instrução. O prompt personalizado do usuário passa por `protectedProfilePrompt` e não
amplia permissões: as ferramentas oferecidas ao modelo saem de `assistantPolicy.js`, não do
texto do prompt.

### 8.1 O que o wrapper garante

`untrustedContext()` (em `backend/src/agent/promptRegistry.js`) neutraliza, no conteúdo e
nos atributos do cabeçalho, a marcação que o modelo poderia ler como **estrutura do
aplicativo**:

| Marcação | Por que importa |
| --- | --- |
| `<untrusted-context>` (abertura **e** fechamento, em qualquer forma tolerante: `</untrusted-context foo="1">`, `</ …>`, `< /…>`, sem `>`) | Fechar o delimitador faz o dado fingir que acabou e que quem volta a falar é o aplicativo. Abrir um bloco falso tem o efeito espelhado: o fechamento legítimo encerra o bloco forjado e o resto do payload parece estar fora da caixa. |
| `<trusted-instruction>` | O marcador oposto: forjá-lo promove dado a ordem. |
| `<tool_call>`, `<function=…>`, `<function name=…>` | `loop.js` converte protocolo **textual** de ferramenta achado no texto do modelo em chamada **nativa**. Sem neutralizar na entrada, bastava o modelo repetir um trecho da página lida para o comando do atacante virar execução real no sandbox. |

O casamento é limitado a esses nomes de propósito: escapar marcação genérica mutilaria HTML,
XML e código legítimos — e num domínio contábil/fiscal o conteúdo **é** o dado.

### 8.2 Bateria adversarial (F-17 — FECHADO)

`backend/src/agent/promptInjection.adversarial.test.js` — 33 casos escritos do ponto de
vista do atacante, cobrindo os quatro vetores previstos no F-17: README malicioso no
repositório, memória envenenada em turno anterior, delimitador fechado à força e resposta
maliciosa de outro modelo no pipeline multimodelo. Inclui a **cadeia completa** (página lida
→ eco do modelo → execução) e os casos de não-regressão que provam que dado legítimo
atravessa o wrapper sem perda.

Rodada contra o código anterior à correção, a bateria acusa **15 falhas**. Duas eram reais e
foram corrigidas nesta frente:

1. O escape do delimitador só cobria a forma canônica `</untrusted-context>`; qualquer
   variação tolerante escapava da caixa.
2. **Resultado de ferramenta ia CRU para o contexto** (`role: 'tool'`), sem wrapper nenhum —
   apesar de esta seção já afirmar o contrário. Era o maior canal de texto de terceiros do
   app (`web_fetch`, `read_file`, `bash`, `github_clone`) e a cadeia mais curta até execução.

### 8.0 Autorização de publicação no GitHub — decisão do usuário, não do modelo

`autorização do usuário ≠ disponibilidade técnica da ferramenta`. As duas passaram a ser
verificadas separadamente, num único lugar (`agent/githubAccess.js`), e o pré-voo que
libera a ferramenta é o MESMO que a interface exibe e o que o prompt anuncia.

Controles:

| Superfície | Regra |
| --- | --- |
| Origem | Ação explícita do usuário: o botão **Autorizar publicação** (que mostra repositório, branch, destino e ações antes de confirmar) ou a confirmação de um `ask_user` cujo escopo o **backend** carimba a partir do vínculo — nunca do texto do modelo. |
| Escopo | Repositório + branch + branch base + ações (`push`, `create_pr`). Não vale para outro repositório, outra branch ou outra base. Não é permissão global. Com **branch de trabalho derivada** (Fase 23), o escopo é conferido contra a branch EFETIVA — uma autorização emitida para a branch protegida não publica o trabalho, e vice-versa. |
| Branch protegida | Em modo de escrita, o agente nunca commita direto em `main`/`master`/`develop`/…: o trabalho vai para uma branch própria da tarefa e o PR tem a protegida como base (`agent/workBranch.js`). O caminho legado de autorização por texto do turno continua exigindo branch explícita no vínculo — a derivação não amplia o alcance dele. |
| Re-validação | O backend normaliza tudo (`normalizeGithubWriteAuthorization`): campos desconhecidos e ações fora do enum são **descartados**, branch inválida (ex.: `--force`) é recusada. O frontend não amplia nada. |
| Modo | Só `build`/`fix`/`auto` podem publicar; `ask`/`plan`/`review` ficam em leitura mesmo com autorização registrada. |
| Sub-agente | Nunca publica (ver 8.1). |
| Turno social | `lowSignalTurn` não recebe ferramenta remota nenhuma. |
| Token | Continua cifrado em `user_connectors` e **nunca** entra no sandbox: clone/push/PR rodam no backend, com `scrubSecrets()` em toda saída. O pré-voo é estado, não credencial — nenhuma rota devolve token, login ou escopo do PAT. |
| Contorno | Git remoto pelo bash do sandbox é **bloqueado** (`execGuard.js`), com a mensagem que aponta as ferramentas do backend. Antes, a falha chegava como erro de rede genérico e o modelo insistia (nova tentativa, `GIT_SSL_NO_VERIFY`, abrir o github.com no navegador). |
| Bloqueio honesto | Quando indisponível, a causa real é informada (`github_not_connected`, `repository_not_bound`, `read_only_mode`, `write_not_confirmed`, `scope_mismatch`, `action_not_authorized`, `invalid_branch`, `subagent_not_allowed`) — nunca um genérico "a ferramenta não está habilitada". |

Testes: `agent/githubAccess.test.js` (matriz completa + catraca de inventário único),
`execGuard.remoteGit.test.js`, `frontend/src/hooks/useDevProjects.test.js`.
Decisão em `docs/decisions/0002-autorizacao-estruturada-de-publicacao-no-github.md`.

As rotas de **botão** (`POST /conversations/:id/github/push`) seguem a mesma régua: o
clique é a autorização, mas o alvo precisa ser o repositório (e a branch, quando fixada)
do vínculo do projeto desta conversa no servidor — falha fechada sem vínculo. Antes,
uma request autenticada podia empurrar qualquer repo/branch do token, fora do escopo
que o `githubAccess.js` impõe ao agente. O clone (leitura com o token do próprio
usuário) continua exigindo só a posse da conversa.

### 8.0b Política de comandos allow/ask/deny (`agent/permissionPolicy.js`)

Camada de **política de produto** sobre as fronteiras duras (sandbox isolado,
docker-guard, execGuard) — nunca as substitui nem afrouxa:

- regras ordenadas com glob simples; a última que casa vence; comandos compostos
  lineares (`&&`, `;`, `|`) são divididos e vale a decisão mais restritiva;
- `deny` para o que já era fronteira (sudo, docker, git remoto pelo sandbox), com o
  motivo de política na recusa; `ask` para comandos que destroem trabalho não
  commitado (`git reset --hard`, `git clean`, `git restore`, `git checkout -- `);
- `ask` devolve `PERMISSION_REQUIRED` ao modelo, que pergunta via `ask_user`; o
  backend carimba na pergunta o padrão exato da política (nunca texto do modelo);
  a confirmação vira `commandGrants` no projeto — re-validada a cada turno
  (`normalizeCommandGrants`, falha fechada: só padrões `ask` sobrevivem, e um grant
  nunca rebaixa um `deny`);
- sub-agentes herdam os grants do pai pelo `DelegationContext` — nunca derivam
  novos do texto da subtarefa (que é escrito pelo modelo).

Limite honesto: a divisão de comandos é textual (não interpreta aspas nem
substituição). Testes: `agent/permissionPolicy.test.js`.

Leituras locais correlatas, com a mesma régua de contenção: o ChangeSet
(`agent/changeSet.js`) roda `git status/diff` no clone do workspace **sem
token** (o `runGit` exportado nunca recebe credencial nesse caminho), e o Code
Intelligence (`agent/codeIntel.js`) varre apenas `ws.base`, ignora links
simbólicos (nada fora da base entra na lista), pula binários e limita bytes e
resultados — as duas superfícies são somente-leitura e não tocam sandbox nem
rede.

### 8.1 Delegação a sub-agentes — a fronteira de autorização

Um sub-agente (`agent/subagents.js`) roda um `runAgent` COMPLETO, com ferramentas de
verdade, a partir de um texto que **o modelo principal escreveu**. Isso faz da delegação um
caso especial de conteúdo não confiável: se qualquer permissão for derivada desse texto, o
modelo passa a ser a fonte da própria autorização.

Controles:

| Superfície | Regra |
| --- | --- |
| Ferramentas | `allowedTools = ferramentas efetivas do pai ∩ ferramentas do especialista`. A poda é feita no `loop.js` com `intersectToolDefinitions`. Um assistente com apenas `read_file` não ganha `bash`/`write_file` ao delegar. |
| Rede do sandbox | Herdada do pai. O filho **não** chama `resolveSandboxNetwork` sobre a subtarefa. |
| Escrita nas Pastas do PC | Herdada do pai. O filho **não** chama `explicitlyAuthorizesPcWrite` sobre a subtarefa. |
| Política de sandbox | O filho recebe o `sandboxOptions` do pai verbatim → mesma `sandboxPolicy().key` → mesmo container. |
| Escrita no GitHub | Nunca se herda (`gitWriteAuthorized: false`) **e o pré-voo recusa por construção**: `githubPreflight({ isSubagent: true })` devolve `subagent_not_allowed`, então `github_push`/`github_create_pr` não entram no inventário do filho mesmo com autorização válida do pai (`agent/githubAccess.test.js`). |
| Profundidade | `MAX_SUBAGENT_DEPTH = 1` — sub-agente não delega. O nome da ferramenta é removido da herança. |
| Contexto | Janela isolada: sem memória de longo prazo e sem histórico da conversa (o prompt do filho afirma isso, e agora é verdade). |

Tudo isso viaja num objeto **congelado** (`buildDelegationContext`), montado uma única vez
pelo pai a partir do pedido real do usuário, e é o mesmo para todas as delegações da
execução. Testes em `agent/subagents.test.js`.

**Lacuna conhecida:** a herança é garantida por construção e por teste unitário do contrato
(interseção, congelamento, igualdade da chave de política). Falta o teste de ponta a ponta
do `runAgent` com um provedor simulado — depende do F-13.

### Contexto do chat principal levado ao copiloto

O painel do copiloto (Nino) passou a receber, por padrão, as últimas mensagens da conversa
principal aberta — material de terceiros pelos mesmos motivos de sempre: inclui resposta de
modelo e arquivos colados pelo usuário. O trecho entra como bloco `system` delimitado, com
cabeçalho declarando que é **referência somente-leitura** e que instruções ali dentro são
**dado, não ordem**.

A leitura é governada por `decideContextAccess` (`backend/src/copilot/core.js`): `nunca`
bloqueia sempre; `perguntar` exige o pedido explícito daquela mensagem; `sempre` — o padrão
— leva o contexto, e um `false` explícito o dispensa numa mensagem pontual. É escopada pelo
dono da conversa (o JOIN com `conversations` é a autorização; `messages` não tem `user_id`)
e cada acesso vira entrada em `companion_audit`. Testes: `backend/src/copilot/core.test.js`.

---

## 9. LGPD

Consentimento versionado com evidência (IP + user-agent), exportação de dados,
exclusão profunda de conversa (mensagens, arquivos, chunks, memórias automáticas, tarefas,
workspace, derivados do Docling) e exclusão total de conta com hard delete e cascade.
Retenção opcional: conversas, uso de tokens e derivados do Docling.
Ver `backend/src/privacy.js`.

---

## 10. Checklist antes de expor a instalação na internet

- [ ] `ENCRYPTION_KEY` e `BETTER_AUTH_SECRET` definidos por secret manager (não gerados no disco)
- [ ] `ADMIN_USER_ID` fixado (ou `ADMIN_EMAIL` usado uma vez e o papel conferido em `user_roles`)
- [ ] `CLAMAV_REQUIRED=true`
- [ ] `ENABLE_PC_FOLDERS` **não** definido (ou `false`)
- [ ] `UPLOAD_USER_QUOTA_MB` definido
- [ ] `FRONTEND_URL`/`BETTER_AUTH_URL` corretos (CORS)
- [ ] Backup automatizado **incluindo** a chave mestra, com restauração testada
- [ ] `docker-guard` no ar e `/api/health` mostrando `sandbox.docker.modo = "guarda"`
- [ ] `GUARD_ALLOW_PC_FOLDERS=false` (a menos que seja instalação pessoal)
- [ ] `/api/health` monitorado (antivírus degradado, órfãos de sandbox, `unhandledRejections`)

## Ferramentas executivas do Nino

Verificado contra o código em: 2026-08-06

- As análises de LGPD e integridade recebem somente conteúdo autorizado pela
  sessão ou um `documentId` resolvido com `user_id`; valores detectados não são
  devolvidos nem escritos em `companion_audit`.
- Conteúdo enviado às ações baseadas em modelo é delimitado como dado não
  confiável e não pode substituir o prompt de sistema.
- A revisão de memória é somente leitura. Exclusão ou consolidação continua sob
  controle do usuário.
- A criação de rotina exige `confirmed: true`, a capacidade sensível
  `criar_rotinas` e trilha de auditoria. Parada de emergência e modo somente
  leitura continuam prevalecendo.
- A detecção por expressões regulares é heurística: falso positivo e falso
  negativo são esperados. O resultado não substitui avaliação jurídica.
