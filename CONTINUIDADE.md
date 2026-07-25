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
Critérios, condições de operação e caminho para o verde em `docs/AUDITORIA_2026-07.md` §6.

- **Branch:** `claude/frederico-audit-production-gduf4s`
- **Última validação:** 2026-07-25 — **536 testes, todos passando** (backend 495,
  frontend 37, Python 4), com PostgreSQL real e **zero pulados**; 20 migrações aplicadas
  em banco vazio, reexecução idempotente; boot do backend e `/api/health` verificados.
  A contagem vem de `cd backend && npm run test:count` — não a escreva à mão.

---

## O que mudou por último (auditoria de produção, 2026-07-25)

| Commit | Assunto |
| --- | --- |
| `78fd482` | Workspace e sandbox escopados por usuário; invalidação direcionada; labels e reconciliação de containers órfãos |
| `1ff3c4f` | Backup com chave mestra + manifesto/checksum/trava; administração persistida em `user_roles` com auditoria |
| `fd70dac` | Uploads por streaming em disco, tetos e cotas; antivírus com status honesto |
| `ad7879c` | CI com PostgreSQL real, migrações, todos os testes do frontend, smoke de boot e portão de autenticação |

Detalhe de cada achado (evidência, causa raiz, correção, testes) em
`docs/AUDITORIA_2026-07.md`.

---

## Riscos abertos

| ID | Risco | Severidade |
| --- | --- | --- |
| **F-04** | `/var/run/docker.sock` montado no backend — uma RCE no Node vira comprometimento do host. Plano de substituição em `docs/SECURITY.md` §4.2. | 🔴 Crítica |
| F-15 | Pipeline multimodelo sem coordenador durável: reinício não retoma a próxima etapa pendente. | 🟠 Alta |
| F-12 | Sem teste integrado de SSE (duas conversas simultâneas, troca rápida, reconexão). | 🟠 Alta |
| F-14 | Sem teste de retomada após interrupção **real** do processo. | 🟠 Alta |
| F-17 | Sem bateria adversarial de injeção de prompt. | 🟠 Alta |
| F-05b | Sandbox com rede habilitada não tem allowlist de egress. | 🟡 Média |
| F-13, F-16, F-18, F-19, F-23 | Provedor simulado, relevância de memória (casos negativos), corpus do Docling, git local, validação de artefato com arquivos reais. | 🟡 Média |
| F-20, F-21 | `App.jsx` com 62 `useState`; bundle de 932 KB num único chunk; CSS em camadas sem inventário. | 🟡 Média |
| F-11 | Sem quarentena/reprocesso do que passou com o antivírus degradado. | 🟡 Média |

---

## Próximos passos (em ordem)

1. **F-04** — subir um `docker-socket-proxy` com allowlist e apontar `DOCKER_HOST` do
   backend para ele. Maior ganho de segurança por esforço de todo o backlog.
2. **F-12/F-13** — provedor HTTP simulado + teste integrado de SSE. Destrava boa parte
   das outras lacunas de teste.
3. **F-14** — retomada após `kill -9` no meio de um run, com checkpoint real.
4. **F-15** — tabela `pipeline_runs` (`pipeline_run_id`, `current_stage`,
   `completed_stages`, `pending_stages`, `artifact_versions`, `status`, `checkpoint`,
   `updated_at`) e retomada no boot.
5. **F-17** — casos adversariais: README malicioso no repositório, memória envenenada,
   delimitador fechado à força, resposta maliciosa de outro modelo.
6. **F-20** — extrair de `App.jsx`, por etapas: shell → estado da conversa → estado da
   execução → drawers/configurações. `React.lazy` nos painéis pesados.

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

**Mapa da documentação:** `docs/ARCHITECTURE.md` (como funciona) ·
`docs/SECURITY.md` (ameaças e controles) · `docs/OPERATIONS.md` (runbook) ·
`docs/BACKUP_RESTORE.md` · `docs/TESTING.md` · `docs/AUDITORIA_2026-07.md` ·
`docs/CHANGELOG_HISTORY.md` (histórico).
