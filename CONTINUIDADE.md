# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo está preservado em `docs/CHANGELOG_HISTORY.md` — nada é apagado,
> só muda de endereço quando deixa de ser "o presente".

---

## Estado atual

**Última frente (esta entrega):** Nino ocultar/mostrar + wiring do Modo
Desenvolvedor + prévia do Modo Design.

| Frente | O que estava errado | Correção |
| --- | --- | --- |
| Nino | Só dava para desligar em Configurações / select do workspace Dev; ao desligar, sumia sem caminho óbvio de volta. | Botão **Ocultar** no avatar (`enabled: false` via `settingsForCompanionMode(OFF)`); botão persistente **Mostrar Nino** no Companion quando oculto. Código do Companion preservado. |
| Modo Dev | Abrir "Modo desenvolvedor" ou o workspace sem sessão deixava casca de IDE com chat genérico (sem `mode`/`github`/`permissions` no envio). | Plugin Vite `appDevNinoPatchPlugin` aplica no build: `openDeveloper`/`changeWorkspace('developer')` semeiam sessão; sair da sessão reabre o fluxo; placeholder do compositor. |
| Modo Design | Troca de versão usava `#hash` no iframe → sem `onLoad` → prévia ficava em `opacity: 0` ("Carregando…" eterno). | Prévia recarrega por query `_v=` + `key` no iframe; recarregar manual também. |

**Nota:** o `App.jsx` monolítico (~115 KB) não cabe no limite de payload do MCP usado nesta entrega; o wiring Dev entra via plugin Vite (transform no build/dev), não por reescrita do arquivo na árvore. Nino e Design foram editados nos arquivos-fonte.

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
| — | Patches Dev via plugin Vite: se o texto-âncora do `App.jsx` mudar, o plugin avisa no build e o patch deixa de aplicar até atualizar as âncoras. | 🟡 Média |

---

## Próximos passos (resumo)

1. Prova visual (Ocultar/Mostrar Nino, workspace Dev com sessão, prévia Design).
2. Incorporar os patches Dev no `App.jsx` fonte (eliminar o plugin) numa sessão com push local/git.
3. Frente 16 — popular `model_tool_capability_cache` com a sonda `--live`.
4. Frente 13 (Design) — compartilhamento público da prévia por token.
5. Frente 9 — desmontar o `App.jsx` (etapas 2–4).

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
