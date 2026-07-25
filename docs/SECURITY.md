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

### 4.2 O risco que permanece: `/var/run/docker.sock` no backend

`docker-compose.prod.yml` monta o socket do Docker no container do backend. **Quem
controla esse socket controla o host** (é possível criar um container privilegiado com
`/` montado). Ou seja: uma RCE no processo Node deixa de ser "comprometeu o backend" e
passa a ser "comprometeu a máquina".

**Superfície de ataque do backend** (por onde uma RCE poderia entrar): dependências npm,
parsing de upload, `spawn('git'|'pg_dump'|'tar'|'chown')`, Chromium headless do `web_fetch`,
e conteúdo controlado pelo modelo chegando a essas bordas.

**Mitigações já presentes:** o backend não expõe porta; nenhum argumento de `spawn` é
concatenado a partir de string do usuário; caminhos passam por `safeJoin`/`realInside`;
o sandbox não recebe o socket.

**O que NÃO foi feito** (decisão consciente desta auditoria — reescrever a arquitetura de
execução é grande demais para uma auditoria e removeria o sandbox sem substituto pronto):
serviço separado de gerenciamento de sandbox, proxy Docker com allowlist, socket rootless.

**Arquitetura de substituição recomendada** (ordem de esforço crescente):

1. **Proxy Docker com allowlist** (baixo esforço, ganho alto).
   Subir um `docker-socket-proxy` na rede interna, dar ao backend `DOCKER_HOST=tcp://…` e
   liberar **apenas** `containers create/start/exec/inspect/remove/list` e `images inspect`.
   Bloquear `POST /containers/create` com `Privileged`, `Binds` fora de `WORKSPACE_ROOT`,
   `PidMode`, `NetworkMode: host` e montagem do próprio socket. O backend deixa de poder
   pedir um container privilegiado mesmo se comprometido.
2. **Rootless Docker ou Podman** para o daemon que atende os sandboxes: o socket passa a
   valer os privilégios de um usuário sem poder, não de root.
3. **Serviço `sandbox-manager` dedicado** (esforço maior): único com o socket, API HTTP
   mínima autenticada por token interno, rede isolada, que valida imagem por digest, recusa
   mounts arbitrários e aplica cotas. O backend nunca fala Docker diretamente.

Até que uma delas exista, a instalação deve ser tratada como **confiável no host**:
não colocar dados de terceiros num host compartilhado com outras cargas. Registrado
como **risco aberto F-04**.

### 4.3 Egress quando a rede é habilitada

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

**Lacuna:** não existe bateria adversarial automatizada (README malicioso, delimitador
fechado à força, memória envenenada). **Risco aberto F-17.**

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
- [ ] Proxy Docker com allowlist **ou** aceitação formal do risco F-04
- [ ] `/api/health` monitorado (antivírus degradado, órfãos de sandbox, `unhandledRejections`)
