# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo está preservado em `docs/CHANGELOG_HISTORY.md` — nada é apagado,
> só muda de endereço quando deixa de ser "o presente".

---

## Estado atual

**Última frente (esta entrega — PR #209):** review Dev/Design/Nino + README honesto +
passos em SSE/auth/docker-guard.

| Frente | Estado |
| --- | --- |
| Nino ocultar/mostrar | No fonte (`CompanionHideButton` + **Mostrar Nino**). Código do companion permanece. |
| Modo Dev (sessão) | **No `App.jsx` fonte** (`seedDeveloperSessionFromActive` / `openDeveloperWorkspace` via `devWorkspaceBootstrap.js`). Plugin Vite de transform **removido**. |
| Prévia Design | `DesignPreviewFrame` recarrega por query `_v=`/`_r=` + `key` (não só `#hash`). |
| README / homepage GitHub | Hero com badge **amarelo · apto com restrições**; limites conhecidos explícitos. |
| SSE / cancel / isolamento | Ajustes em `useChat` (abort no Parar; época; developer só na conversa ativa) — ver commits do PR. |
| Auth | Better Auth (AuthGate/LoginScreen); limpeza de rastro `APP_PASSWORD`/`/api/login` via script apply. |
| docker-guard | `User: "0"` / `"0:0"` barrados em exec (além de `"root"`). |

Aplicação multiusuário com agentes de IA, memória semântica, multimodelo, execução de
ferramentas em sandbox Docker, geração de documentos, Docling, conector GitHub, copiloto
(Nino) e **Modo Design**. Backend Node 20 + Express + PostgreSQL (pgvector);
frontend React 19 + Vite; autenticação Better Auth.

**Prontidão para produção: 🟡 amarelo — apto com restrições.**
Nenhum risco crítico aberto desde o F-04. Retomada do pipeline multimodelo é pelo
cliente (`/resume`), não automática no boot. Detalhes e frentes fechadas:
`docs/CHANGELOG_HISTORY.md` e `docs/AUDITORIA_2026-07.md`.

---

## Riscos abertos

| ID | Risco | Severidade |
| --- | --- | --- |
| F-21 | `App.jsx` ainda concentra dezenas de `useState`; folga do bundle de entrada ~7 KB. | 🟡 Média |
| — | Pré-voo do GitHub não verifica escopos reais do PAT (só na hora do push). | 🟢 Baixa |
| — | Sandbox com rede liberada ainda sem allowlist completa de destinos. | 🟡 Média |
| — | Cadastro aberto se o serviço estiver público — confirme/aprove contas em produção. | 🟡 Média |
| — | `App.jsx` pode ainda ter âncoras mortas de APP_PASSWORD até rodar `apply-auth-legacy-cleanup.mjs`. | 🟢 Baixa |

---

## Próximos passos (resumo)

1. Prova visual no PR #209 (Ocultar/Mostrar Nino, workspace Dev com sessão, prévia Design, Parar mid-stream).
2. CI verde no PR; merge só após review humana.
3. Frente 16 — popular `model_tool_capability_cache` com a sonda `--live`.
4. Frente 13 (Design) — compartilhamento público da prévia por token.
5. Frente 9 — desmontar o `App.jsx` (etapas 2–4).
6. Review uploads/ClamAV (próximo domínio).

## Como retomar

```bash
docker run -d --name fred-pg -e POSTGRES_USER=studio -e POSTGRES_PASSWORD=studio \
  -e POSTGRES_DB=studio -p 5432:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgres://studio:studio@localhost:5432/studio
cd backend && npm install && npm run test:integration && npm run dev
cd frontend && npm install && npm test && npm run dev
# Antes de commitar: backend npm run check · frontend npm run check
```

**Mapa:** `docs/ARCHITECTURE.md` · `docs/SECURITY.md` · `docs/OPERATIONS.md` ·
`docs/TESTING.md` · `docs/AUDITORIA_2026-07.md` · `docs/CHANGELOG_HISTORY.md`.
