# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo está preservado em `docs/CHANGELOG_HISTORY.md` — nada é apagado,
> só muda de endereço quando deixa de ser "o presente".

---

## Estado atual

**Última frente (esta entrega):** review profundo SSE/chat + auth legado + docker-guard.
Corrigidos: cancelamento SSE com `AbortController` no `useChat`, `_seq`/fromSeq com
zero válido, parser SSE (flush), exec root numérico no docker-guard, e script para
apagar rastro `APP_PASSWORD`/`/api/login` do `App.jsx`.

| Frente | Estado |
| --- | --- |
| Nino ocultar/mostrar | No código-fonte (`CompanionHideButton` + botão **Mostrar Nino**). |
| Modo Dev (sessão) | Wiring via plugin Vite (= bootstrap); fonte App.jsx pendente de apply local. |
| Prévia Design | `DesignPreviewFrame` recarrega por query `_v=`/`_r=` + `key` (não `#hash`). |
| SSE / cancel / isolamento | `useChat`: abort no Parar; época; developer só na conversa ativa. |
| Auth | Better Auth (AuthGate/LoginScreen); limpeza legado App via script apply. |
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
| — | Plugin Vite Dev: se o texto-âncora do `App.jsx` mudar, o plugin avisa no build. Mitigação: `apply-dev-wiring.mjs` + remover plugin. | 🟡 Média |
| — | `App.jsx` pode ainda ter âncoras mortas de APP_PASSWORD até rodar `apply-auth-legacy-cleanup.mjs`. | 🟢 Baixa |

---

## Próximos passos (resumo)

1. Com git local: `node frontend/scripts/apply-dev-wiring.mjs` e `node frontend/scripts/apply-auth-legacy-cleanup.mjs`, commitar `App.jsx`, remover plugin.
2. Prova visual (Ocultar/Mostrar Nino, workspace Dev com sessão, prévia Design, Parar mid-stream).
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
