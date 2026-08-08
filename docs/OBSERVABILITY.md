# Observabilidade — Frederico AI Studio

O que o app mede, onde grava e como ler.

## Visão geral

A tabela `usage` é a fonte única de verdade para consumo do app. Cada request
que gera tokens (chat, design, multimodal, tarefa agendada, imagem de design)
insere **uma linha** em `usage` com a mesma estrutura canônica.

### Colunas de `usage` (após migration 031)

| Coluna | Tipo | O que é |
|---|---|---|
| `id` | TEXT | nanoid |
| `user_id` | TEXT | FK do dono |
| `conversation_id` | TEXT | FK da conversa (NULL para Design/imagem) |
| `assistant_id` | TEXT | FK do assistente (NULL para Design) |
| `model` | TEXT | id do provedor (`openai::gpt-4o`, `free::...`, etc.) |
| `kind` | TEXT | tipo de cobrança (`chat`, `orquestrador`, `tarefa`, `design`, `design_image`, `multimodelo`) |
| **`feature`** | TEXT | **rótulo padronizado de FEATURE**: `chat`, `multimodel`, `design`, `design-image`, `scheduled-task` |
| `prompt_tokens` | INT | tokens do prompt |
| `completion_tokens` | INT | tokens da resposta |
| `total_tokens` | INT | soma |
| **`cost_usd`** | NUMERIC(10,6) | **custo estimado em USD (NULL se preço do modelo desconhecido)** |
| `created_at` | TEXT | ISO string UTC |

### Diferença entre `kind` e `feature`

- `kind` é o tipo de cobrança (linguagem interna, flexível por rota).
- `feature` é o rótulo PADRONIZADO de produto (linguagem do painel admin).
- Linhas antigas (anteriores à migration 031) têm `feature = NULL` e
  `cost_usd = NULL`. O painel trata isso como "anterior à instrumentação".

## Lista canônica de features

| Feature | Rotas | `kind` original |
|---|---|---|
| `chat` | `conversations.js` (3 call sites) | `chat` |
| `multimodel` | `conversations.js` (pipeline) | `multimodelo` |
| `design` | `routes/design.js` (geração de HTML/JSON) | `design` |
| `design-image` | `design/images.js` (geração de imagem) | `design_image` |
| `scheduled-task` | `routes/tasks.js` (worker de tarefas) | `tarefa` |

Forward-compat: features fora da lista são gravadas com um `console.warn`.
A UI pode esconder features desconhecidas até serem oficializadas.

## Helpers de gravação

Toda inserção em `usage` passa por `recordUsage()` em
`backend/src/usage.js`. É a única superfície que os routers usam — não há
INSERT manual em `usage` espalhado pelo código.

```js
import { recordUsage } from '../usage.js';

await recordUsage({
  userId: req.userId,
  conversationId: req.params.id,
  assistantId: usageAssistantId,
  model: result.model,
  kind,                    // livre
  feature: 'chat',         // padronizado (lista canônica)
  promptTokens: result.usage.prompt_tokens,
  completionTokens: result.usage.completion_tokens,
});
```

`cost_usd` é calculado automaticamente a partir de um profile com
`pricingKnown: true` (vem de `modelProfileFromProvider`). Sem profile ou sem
preço conhecido, `cost_usd` fica NULL.

Falha no INSERT é logada mas NÃO propaga — a cobrança é secundária
(auditoria); o request principal não pode ser derrubado por ela.

## Endpoints admin

### `GET /api/admin/usage/dashboard`

Retorna agregado operacional completo. Requer `requireAdmin`.

```json
{
  "generatedAt": "2026-08-06T20:00:00.000Z",
  "ranges": { "today": "...", "d7": "...", "d30": "...", "monthStart": "..." },
  "today":    { "byFeature": [{ "feature": "chat", "requests": 12, "tokens": 4321, "costUsd": 0.0123 }] },
  "last7d":   { "byFeature": [...] },
  "last30d":  { "byFeature": [...] },
  "month":    { "tokens": 1234567, "costUsd": 12.3456, "topModels": [...] },
  "quotaPressure": { "configured": true, "limit": 50000, "activeUsers": 23, "pressuredUsers": 4, "ratio": 0.174 },
  "topUsers30d": [{ "userId": "...", "display": "Fulano", "requests": 89, "tokens": 23456 }],
  "knownFeatures": ["chat", "multimodel", "design", "design-image", "scheduled-task"]
}
```

#### `quotaPressure`

Calcula quantos usuários ativos nos últimos 7 dias estão com consumo ≥ 80%
do teto diário free-tier (`FREE_TIER_DAILY_LIMIT`). Sem env var configurada,
devolve `configured: false` em vez de inventar número.

## Onde está o quê

- **Migration**: `backend/migrations/031_usage_feature.sql`
- **Helper**: `backend/src/usage.js`
- **Router admin**: `backend/src/routes/usageDashboard.js`
- **Refatoração dos call sites**: 6 arquivos
  (`routes/tasks.js`, `routes/conversations.js`, `routes/design.js`,
   `design/images.js`)
- **Testes**: `backend/src/usage.test.js`,
  `backend/src/routes/usageDashboard.test.js`

## Confiabilidade — a outra pergunta (Fase 66)

Tudo acima mede **consumo**. Uma execução pode consumir tokens
exemplarmente e terminar em `fatal_error`: no painel de consumo ela some no
meio da média. A telemetria de confiabilidade responde a outra pergunta —
**o trabalho deu certo?** — e é deliberadamente separada da de consumo.

**LOCAL tem sentido literal:** nada é enviado a lugar nenhum e **nada novo é
coletado**. Todos os números derivam de `agent_runs` e `agent_run_events`
(migration 032), que a Fase 17 já grava para reconstruir o terminal após um
reload. Por isso a fase não tem migration: é leitura e agregação.

| Onde | O quê |
|---|---|
| `backend/src/agent/reliability.js` | agregação **pura** (desfechos, durações, falha por ferramenta, sinais) + coletor fino |
| `GET /api/reliability` | escopo do **próprio usuário**; `?dias=30`, `?project=<id>` |
| `frontend/src/reliabilityView.js` | apresentação pura (frase, unidades, corte declarado) |
| `components/ReliabilityPanel.jsx` | bloco recolhido na aba "Atividade" |

### Quatro decisões que definem os números

1. **`awaiting_user` e `paused` não são falha nem sucesso.** A execução parou
   porque era assim que deveria parar. Contá-los como falha inflaria o
   problema; como sucesso, o esconderia. Eles formam o grupo `aguardando` e
   ficam **fora** do denominador das taxas.
2. **Falha de ferramenta usa `toolResultLooksFailed`** — a MESMA função que
   pinta a etapa de vermelho no terminal. Critério diferente faria o painel e
   a tela discordarem sobre o mesmo fato.
3. **Sem amostra, nenhum sinal.** `MIN_RUNS_PARA_SINAL` e
   `MIN_CHAMADAS_PARA_SINAL` valem 5: "100% de falha" em uma execução é ruído
   travestido de alarme. Cada sinal cita os números que o produziram.
4. **Corte declarado, nunca silencioso.** A amostra é limitada
   (`MAX_RUNS`/`MAX_EVENTS`) e a resposta carrega `amostra.truncado` — um
   painel que corta em silêncio conta uma história falsa com números
   verdadeiros. Vale também na tela: a lista de ferramentas mostra as 5
   piores e **conta** as demais.

**Escopo é do usuário, não da instalação.** Um agregado global misturaria
conversas de pessoas diferentes num número que ninguém pode acionar, e
exporia padrão de uso alheio sem necessidade. Testes:
`backend/src/agent/reliability.test.js` e
`frontend/src/reliabilityView.test.js` — os dois rodam sem PostgreSQL, que é o
motivo de a agregação ser pura.

## Próximos passos sugeridos (não parte desta frente)

1. UI admin consumindo `/api/admin/usage/dashboard` (hoje o painel admin
   é via API/curl).
2. Calibração do `FREE_TIER_DAILY_LIMIT` com base em `tokens_30d` real.
3. Alertas quando `quotaPressure.ratio > 0.3` (mais de 30% dos usuários
   perto do teto).