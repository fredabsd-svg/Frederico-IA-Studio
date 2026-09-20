# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo está preservado em `docs/CHANGELOG_HISTORY.md` — nada é apagado,
> só muda de endereço quando deixa de ser "o presente".

---

## Estado atual

**Última frente (esta entrega — PR #209):** review Dev/Design/Nino + README + auth/SSE.
`docker-guard` uid0 e `useChat` SSE (AbortController + fromSeq com seq 0) **já estão no fonte** deste branch.

| Frente | Estado |
| --- | --- |
| Nino ocultar/mostrar | No fonte (`CompanionHideButton` + **Mostrar Nino**). |
| Modo Dev (sessão) | **No `App.jsx` fonte** (`devWorkspaceBootstrap.js`). Plugin Vite Dev **removido**. |
| Prévia Design | `DesignPreviewFrame` por `_v=`/`_r=` + `key`. |
| README | Badge **amarelo · apto com restrições**. |
| SSE parser (`sse.js`) | WHY + flush no branch. |
| Auth (AuthGate / authClient / LoginScreen) | Better Auth only; consent antes do busy; script `apply-auth-legacy-cleanup.mjs` para limpar `App.jsx`. |
| useChat (cancel / `_seq` / isolation) | **No fonte** (`abortControllersRef` + `fromSeq` com seq 0). Script apply mantido só como replay. |
| docker-guard uid0 | **No fonte neste branch:** `docker-guard/src/policy.js` + `policy.test.js` |

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
| — | Parar mid-stream com `AbortController` no fonte deste branch — validar na UI. | 🟢 Baixa |
| — | `docker-guard` uid0 | Resolvido no fonte deste branch. |
| — | `App.jsx` pode ter âncoras mortas APP_PASSWORD até `apply-auth-legacy-cleanup.mjs`. | 🟢 Baixa |

---

## Próximos passos (resumo)

1. Se ainda houver restos de APP_PASSWORD: `node frontend/scripts/apply-auth-legacy-cleanup.mjs` → commit.
2. Prova visual (Nino, Dev, Design, Parar mid-stream) + CI verde; **sem merge automático**.
3. Frente 16 — sonda `--live`; Frente 13 Design token; Frente 9 desmontar `App.jsx`.
4. Review uploads/ClamAV.

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
