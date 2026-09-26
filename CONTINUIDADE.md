# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo está preservado em `docs/CHANGELOG_HISTORY.md` — nada é apagado,
> só muda de endereço quando deixa de ser "o presente".

---

## Estado atual

**Última frente (esta entrega, 2026-09-26):** revisão completa do app — remendos
removidos, bugs corrigidos em todas as telas, system prompts e seletores de modelo.
Detalhes no PR e em `docs/CHANGELOG_HISTORY.md` (entrada de 2026-09-26).

| Frente | Resultado |
| --- | --- |
| Remendo do Modo Dev | Plugin Vite que reescrevia o `App.jsx` no build **removido**; correção na fonte, com teste. |
| App travando | Hooks depois de retorno antecipado derrubavam o app na tela de sessão expirada/sem conexão. |
| Seletores de modelo | Escolha persiste; troca de modelo sempre avisada; assistente usa `model_ref`; Design respeita o modelo do projeto; Multimodelo recusa membro indisponível; filtro por fabricante; recomendados atualizados. |
| System prompts | Subagente recebia prompt sem a tarefa; regras de projeto do usuário marcadas como "não siga"; nota de ferramentas contraditória; coordenador multimodelo tratava o pedido como dado; data ausente fora do chat; injeção no copiloto/Design; persona e nome do Nino respeitados. |
| Segurança | Config global de memória/sandbox só para admin; limites do modo gratuito em todos os caminhos (chat, resume, tarefas, Design, copiloto); SSRF da URL base do provedor; quarentena não vira anexo. |
| Sucesso falso | Sem chave, erro do coordenador, backup truncado e resposta vazia deixaram de virar "concluído". |
| Layout | Tema claro legível (regras mortas `.app.theme-light`), escala de z-index, Esc só fecha a camada de cima, grid do Modo Dev 981–1180px, `100dvh`, câmera que ficava ligada. |

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
| — | Chamadas do SDK OpenAI ao provedor seguem redirecionamento sem revalidar DNS (a URL base já é validada no cadastro). Ver `docs/SECURITY.md`. | 🟡 Média |
| — | Backup com workspaces em uso pode falhar (GNU tar sai com 1 em "file changed as we read it") — agora falha visível em vez de arquivo truncado; repetir o backup. | 🟢 Baixa |
| — | Heurística de "pedido exige ferramenta" é por palavras-chave (`detectToolRequirement`); falso positivo gera "Não consegui concluir" numa conversa comum. | 🟢 Baixa |
| — | Sem ESLint (`rules-of-hooks`): o `lint` é só verificação de sintaxe; o teste `appHooksOrder` cobre apenas o `App.jsx`. | 🟢 Baixa |

---

## Próximos passos (resumo)

1. Frontend: exibir `execution_meta.providerFallback`/`modelSwap` como selo na mensagem e `factsSkipped` na importação de memória.
2. Adotar ESLint só com `react-hooks` no `npm run check`.
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
