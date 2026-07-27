# Operação (runbook)

> Atualizado em **2026-07-25**. Complementa `VPS-DEPLOY.md` (instalação) e
> `docs/BACKUP_RESTORE.md` (backup).

---

## 1. Subir e atualizar

```bash
# produção
docker compose -f docker-compose.prod.yml up -d --build

# com Docling
docker compose -f docker-compose.prod.yml --profile docling up -d --build

# atualizar
git pull && docker compose -f docker-compose.prod.yml up -d --build
```

> **Ordem dos serviços:** `docker-guard` sobe antes do backend (é ele que detém o socket
> do Docker). Se o guarda estiver fora do ar, o backend sobe, mas nenhuma ferramenta de
> sandbox executa — `/api/health` mostra `sandbox.erroReconciliacao`.

O boot do backend, em ordem: migrações → pgvector → caches (settings, pastas do PC) →
**migração do layout de workspace** → reindexação se o modelo de embeddings mudou →
tarefas `running` voltam para a fila → HTTP → **reconciliação de sandboxes órfãos** →
varredura de temporários de upload → agendadores → worker de tarefas.

**Faça backup antes de atualizar** e confira o passo de migração de workspace no log:

```
[workspace] migração de layout: 42 movido(s), 0 sem dono no banco (mantido(s) no lugar).
```

---

## 2. Monitoramento — `/api/health`

Rota pública (sem autenticação), pensada para alerta automatizado:

```json
{
  "ok": true,
  "bootAt": "...", "unhandledRejections": 0,
  "antivirus": { "enabled": true, "mode": "obrigatorio", "degradado": false,
                 "ultimoErroEm": null, "naoVerificados": 0, "infectados": 0 },
  "sandbox":   { "ativos": 3, "orfaosRemovidos": 2,
                 "ultimaReconciliacao": "...", "erroReconciliacao": null,
                 "docker": { "modo": "guarda", "destino": "tcp://docker-guard:2375" } },
  "uploads":   { "maxArquivoMb": 50, "maxRequisicaoMb": 200, "maxArquivos": 20,
                 "maxSimultaneosPorUsuario": 2, "cotaPorUsuarioMb": null }
}
```

| Alerta | Condição | Significado |
| --- | --- | --- |
| **Crítico** | `ok` ausente / sem resposta | Backend fora do ar |
| **Crítico** | `antivirus.degradado = true` em produção | Arquivos entraram **sem verificação** — ver §4 |
| **Crítico** | `sandbox.docker.modo = "socket-direto"` em produção | O backend está com o socket do Docker na mão — o risco F-04 voltou. Confira `DOCKER_HOST` e o serviço `docker-guard` |
| Aviso | `sandbox.erroReconciliacao` não nulo | Docker inacessível (guarda fora do ar?): órfãos vão acumular e as ferramentas param |
| Aviso | `unhandledRejections` crescendo | Bug engolido em algum caminho async |
| Aviso | `sandbox.ativos` sempre no teto | Usuários disputando sandbox; reveja `MAX_SANDBOXES_PER_USER` |

Logs úteis: `docker compose -f docker-compose.prod.yml logs -f backend`.
Prefixos: `[migrate]`, `[workspace]`, `[sandbox]`, `[admin]`, `[admin-audit]`, `[clamav]`,
`[crypto]`, `[retenção]`, `[catálogo]`, `[erro]`, `[unhandledRejection]`.

---

## 3. Limites e cotas (variáveis de ambiente)

### Uploads

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `UPLOAD_MAX_FILE_MB` | 50 | Tamanho máximo de cada arquivo |
| `UPLOAD_MAX_REQUEST_MB` | 200 | Total por requisição (recusado já pelo `Content-Length`) |
| `UPLOAD_MAX_FILES` | 20 | Arquivos por envio |
| `UPLOAD_MAX_CONCURRENT_PER_USER` | 2 | Envios simultâneos por usuário |
| `UPLOAD_USER_QUOTA_MB` | 0 (sem cota) | **Defina em instalação pública** |

Os arquivos são gravados em disco por streaming (`DATA_DIR/tmp-uploads/req-*`) e movidos
ao destino no fim. Nada é bufferizado inteiro na RAM.

### Execução

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `MAX_ACTIVE_RUNS_PER_USER` | 5 | Conversas processando ao mesmo tempo |
| `MAX_SANDBOXES_PER_USER` | 2 | Sandboxes ativos (LRU descarta o mais antigo) |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | 1024m / 1 | Limites do container |
| `SANDBOX_IDLE_TTL_MS` | 1.800.000 | Reciclagem por ociosidade (30 min) |
| `TOOL_TIMEOUT_MS` | 45.000 | Tempo máximo de um comando |
| `RATE_API_PER_MIN` | 600 | Rate limit de `/api` por IP |
| `RATE_MSGS_PER_DAY` | 0 (sem limite) | Mensagens por usuário por dia |

### Sandbox — reconciliação

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `SANDBOX_RECONCILE_ON_BOOT` | `true` | Remove no boot os containers do app deixados por um processo anterior |
| `SANDBOX_ORPHAN_GRACE_MS` | 600.000 | Carência da varredura periódica |
| `SANDBOX_RECONCILE_INTERVAL_MS` | 900.000 | Intervalo da varredura (0 desliga) |

> **Ponha `SANDBOX_RECONCILE_ON_BOOT=false` se um dia houver dois backends no mesmo daemon
> Docker** — do contrário um derruba os sandboxes do outro ao subir. O app hoje pressupõe
> processo único (estado de SSE, controle e fila vive em memória).

### Sandbox — estabilidade do ambiente

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `SANDBOX_KILL_GRACE_MS` | 2.500 | Carência entre matar a árvore de processos do comando e derrubar o container. Um timeout só custa o sandbox se a árvore não morrer nesse tempo |
| `CHECKPOINT_KEEP` | 5 | Checkpoints de workspace mantidos por conversa |
| `CHECKPOINT_MAX_MB` | 300 | Teto por checkpoint; acima disso a criação é recusada |
| `WORKSPACE_QUOTA_MB` | 0 (sem aviso) | Cota usada só para AVISAR o agente a partir de 85% |
| `SANDBOX_PROGRESS_INTERVAL_MS` | 900 (piso 200) | Frequência do progresso ao vivo dos comandos no SSE |
| `SANDBOX_STALL_NOTICE_MS` | 20.000 | Silêncio a partir do qual a interface avisa "sem saída há Xs" |
| `EXEC_LOG_MAX_BYTES` | 4.194.304 | Teto do log integral da última execução (`/workspace/.agent-env`) |

Os checkpoints ficam em `WORKSPACE_ROOT/.checkpoints/<usuário>/<conversa>` — fora
da árvore da conversa, apagados junto com ela, e **nunca contêm segredos**
(`.env`, `*.pem`, `credentials.json`, `secrets/`, `tokens/`, `.git/config`).
O cache de pacotes fica em `WORKSPACE_ROOT/users/<usuário>/.cache` e é montado
em `/cache`; ele não é varrido pelo coletor de disco, de propósito.

O agente registra em `/workspace/.agent-env` (persistente, fora dos checkpoints)
o manifesto de dependências instaladas em runtime, os serviços que subiu, a
transação de workspace aberta e o log integral da última execução.

Detalhes, taxonomia de falhas e roteiro de recuperação: **`docs/AMBIENTE_EXECUCAO.md`**.

### Retenção

`CONVERSATION_RETENTION_DAYS` (0), `USAGE_RETENTION_DAYS` (365),
`DOCLING_RETENTION_DAYS` (0), `OUTPUT_RETENTION_DAYS` (0).
Apagar entrega de usuário é decisão do operador — por isso a maioria vem desligada.

---

## 4. Procedimentos

### Antivírus degradado (`antivirus.degradado = true`)

1. `docker compose -f docker-compose.prod.yml logs clamav | tail -50` — no primeiro boot,
   a base de assinaturas leva ~5 min.
2. Se persistir: `docker compose -f docker-compose.prod.yml restart clamav`.
3. **Em produção, o regime correto é `CLAMAV_REQUIRED=true`** — envio recusado (503) é
   melhor que arquivo não analisado circulando entre usuários.
4. Arquivos aceitos durante a degradação estão marcados `scanStatus: "degradado"` na
   resposta da API. Não há quarentena/reprocessamento automático — **lacuna conhecida
   (F-11)**. Reprocesso manual: reenviar o arquivo com o clamd de pé.

### Ferramentas do sandbox pararam de funcionar

Quase sempre é o guarda recusando algo ou fora do ar.

```bash
docker compose -f docker-compose.prod.yml logs docker-guard | grep RECUSADO | tail -20
curl -fsS https://SEU_DOMINIO/api/health | grep -o '"docker":{[^}]*}'
```

Uma linha `[guard] RECUSADO POST /containers/create — ...` diz exatamente qual regra
barrou. Os dois casos legítimos mais comuns:

- **"está fora de <raiz>"** → `GUARD_WORKSPACE_ROOT` não bate com `HOST_WORKSPACE_ROOT`.
  Os binds usam o caminho do **host**; alinhe os dois.
- **"para permitir pastas do PC, ligue GUARD_ALLOW_PC_FOLDERS=true"** → instalação pessoal
  com "Pastas do PC" ativas. Ligue a variável **no serviço `docker-guard`** (a blocklist de
  `/etc`, `/proc`, `docker.sock` etc. continua valendo).

Se a recusa **não** for um desses, trate como sinal de segurança antes de afrouxar a
política: alguém pediu ao daemon algo que o app não deveria pedir.

### Containers órfãos acumulando

```bash
docker ps -a --filter "label=com.frederico.app=frederico-ai-studio"
docker compose -f docker-compose.prod.yml restart backend   # reconcilia no boot
```

Limpeza manual (só containers do app; nunca de terceiros):

```bash
docker rm -f $(docker ps -aq --filter "label=com.frederico.app=frederico-ai-studio")
```

### Disco cheio

```bash
du -sh workspaces/users/* | sort -h | tail -20   # maiores consumidores
du -sh data/docling-cache data/tmp-uploads
```

Medidas: `UPLOAD_USER_QUOTA_MB`, `OUTPUT_RETENTION_DAYS`, `DOCLING_RETENTION_DAYS`.
`data/tmp-uploads` é varrido de hora em hora; se crescer, há envios sendo abortados.

### Trocar o administrador

```sql
DELETE FROM user_roles WHERE role='admin';
INSERT INTO user_roles (user_id, role, granted_at, granted_by)
VALUES ('<id-do-novo>', 'admin', now()::text, 'operador');
SELECT created_at, email, action, detail FROM admin_audit ORDER BY created_at DESC LIMIT 50;
```

### Conversa travada em "processando"

O estado de execução vive em memória: reiniciar o backend libera. As tarefas `running`
voltam para a fila no boot e o checkpoint permite continuar de onde parou
(botão *Continuar de onde parei*).

### Rollback de uma atualização

```bash
git checkout <tag-anterior>
docker compose -f docker-compose.prod.yml up -d --build
```

As migrações são **aditivas** (nenhuma remove coluna ou tabela), então uma versão anterior
do código roda contra o schema novo. O caminho seguro de rollback é o do código, não o do
schema — não há `down migrations`. Se precisar reverter o schema, restaure o backup.

**Rollback específico desta auditoria:** o layout de workspace passou a ser
`WORKSPACE_ROOT/users/<dono>/<conversa>`. Voltar a uma versão anterior ao commit
`78fd482` exige mover os diretórios de volta:

```bash
cd workspaces && for u in users/*/; do mv "$u"* . 2>/dev/null; done && rm -rf users
```

---

## 5. Verificações periódicas

| Frequência | O quê |
| --- | --- |
| Diária | `/api/health`; backup do banco concluído |
| Semanal | Espaço em disco; `admin_audit`; `unhandledRejections` |
| Mensal | Atualizar imagens base; revisar `user_roles`; conferir o catálogo de modelos |
| Trimestral | **Restauração de backup em host limpo** (`docs/BACKUP_RESTORE.md` §4.6) |

---

## 6. Ambiente de teste local igual ao do CI

```bash
docker run -d --name fred-pg -e POSTGRES_USER=studio -e POSTGRES_PASSWORD=studio \
  -e POSTGRES_DB=studio -p 5432:5432 pgvector/pgvector:pg16

cd backend
export DATABASE_URL=postgres://studio:studio@localhost:5432/studio
npm run test:integration   # migrações + suíte completa
npm run test:count         # contagem real dos testes
```
