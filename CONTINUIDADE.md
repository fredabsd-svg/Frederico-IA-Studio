# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo está preservado em `docs/CHANGELOG_HISTORY.md` — nada é apagado,
> só muda de endereço quando deixa de ser "o presente".

---

## Estado atual

**Última frente (esta entrega):** review inicial + wiring Dev no `App.jsx` fonte
(elimina o plugin Vite de transform).

| Frente | Estado |
| --- | --- |
| Nino ocultar/mostrar | No código-fonte (`CompanionHideButton` + botão **Mostrar Nino**). |
| Modo Dev (sessão) | `seedDeveloperSessionFromActive` / `openDeveloperWorkspace` importados no `App.jsx`; plugin `appDevNinoPatchPlugin` removido. |
| Prévia Design | `DesignPreviewFrame` recarrega por query `_v=`/`_r=` + `key` (não `#hash`). |

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

---

## Próximos passos (resumo)

1. Prova visual (Ocultar/Mostrar Nino, workspace Dev com sessão, prévia Design).
2. Frente 16 — popular `model_tool_capability_cache` com a sonda `--live`.
3. Frente 13 (Design) — compartilhamento público da prévia por token.
4. Frente 9 — desmontar o `App.jsx` (etapas 2–4).
5. Review profundo por domínio (SSE/chat, sandbox, auth, uploads) — este PR só
   cobriu caminhos críticos Dev/Nino/Design + remoção do hack Vite.

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
