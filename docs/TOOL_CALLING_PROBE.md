# Sonda controlada de tool calling

Documento **model-agnostic** que descreve como medimos, no projeto Frederico IA Studio, a capacidade do LLM padrão (e modelos candidatos) de seguir instruções de tool calling no formato OpenAI-compatible.

## Por que precisamos disto

O Modo Design, o copilot e os fluxos "agente" do projeto pretendem usar **function calling** (a API `/v1/chat/completions` com `tools`). Antes de:

1. Endurecer o `generateOpenAICompatible` para passar `tools` em produção;
2. Adicionar um loop de tool-use com retry;
3. Implementar parsers tolerantes para modelos que só emitem ` ```json ``` ` ou `<tool_call>`;

…precisamos **medir empiricamente** se o modelo padrão já estrutura tool calls nativamente, ou se precisaremos de shims. Medir com prompt ad-hoc em produção é caro, não-reprodutível e vaza métricas pela UI.

A sonda resolve isso: 5 cenários canônicos, 2 modos (`with_tools` / `without_tools`), N turnos por cenário. Resultado: um veredito categórico + relatório Markdown para PR.

## Cenários canônicos

| ID | O que testa | Esperado |
|---|---|---|
| `math.simple_addition` | Soma simples (12+7) com tool `calculator` | `tool_call { a:12, b:7, op:"add" }` |
| `math.simple_subtraction` | Subtração (100−58) com tool `calculator` | `tool_call { a:100, b:58, op:"subtract" }` |
| `file.find_known_path` | Caminho concreto (README.md) com `read_file` | `tool_call { path:"README.md" }` |
| `file.list_directory` | Listagem ambígua ("raiz do projeto") com `list_files` | `tool_call { path:"." }` |
| `no_tool.acknowledge_only` | Pergunta retórica sem tool útil | `no_tool` (texto puro) |

Adicionar cenário novo: editar `src/tools/probe/scenarios.js` + atualizar a tabela acima.

## Modos

| Modo | `tools` enviado ao provider? | Para quê |
|---|---|---|
| `with_tools` | sim | Medir se o modelo usa tools quando oferecidas. **É o que importa.** |
| `without_tools` | não | Controle: confirma que o pipeline não está alucinando tool calls sem motivo. |

## Vereditos possíveis

| Veredito | Significado | Próxima frente |
|---|---|---|
| `native_supported` | Provider entrega `tool_calls` estruturados em ≥80% dos runs com tools | Implementar loop de tool-use direto |
| `json_block` | Modelo emite ` ```json {...} ``` ` mas provider não estrutura | Adicionar parser dedicado para `json_block` |
| `xml_block` | Modelo emite `<tool_call>` mas provider não estrutura | Adicionar parser dedicado para `xml_block` |
| `text_only` | Modelo ignora tools mesmo quando instruído (100% fallback) | Considerar prompt reforçado ou fallback de UI |
| `unreliable` | Mix sem padrão (nativo + fallback, ou json + xml) | Investigar caso a caso |
| `no_capability` | Provider falhou em >50% dos runs, ou todos foram `no_tool` esperados | Trocar de modelo ou adicionar camada intermediária |

## Como rodar

### Dry-run (CI, sem rede)

```bash
node scripts/run-tool-probe.mjs
```

Saída:
```
# probe veredito: text_only
# motivo: 10/10 runs com tools ficaram em texto puro — modelo não emite tool calls mesmo quando instruído
# totais: 10 runs / 5 match / 0 tool_call / 0 malformed
```

Útil para verificar que o pipeline (classificador + agregador) funciona end-to-end sem gastar tokens.

### Live (com provider real)

```bash
PROBE_MODEL="anthropic/claude-3.5-sonnet" \
  node scripts/run-tool-probe.mjs --live --out tools/probe-results/probe-claude-2026-01-15.json
```

O `--live` carrega `src/provider.js` e chama `generateOpenAICompatible`. **Cuidado**: cada execução = ~30 chamadas reais. Para iteração rápida, restrinja cenários:

```bash
node scripts/run-tool-probe.mjs --live --only math.simple_addition
```

### Via API

```bash
curl -X POST http://localhost:3000/api/admin/tool-probe \
  -H 'Content-Type: application/json' \
  -H 'Cookie: ...' \
  -d '{"live": true, "turns": 3}'
```

Resposta: `{ verdict, reason, totals, perMode, perScenario }`.

## Relatório de exemplo

```
# Tool calling probe — veredito

- **Veredito**: `native_supported`
- **Motivo**: 8/10 runs com tools (80%) retornaram tool_calls nativos — provider entrega structured tool calling
- **Runs**: 10 total, 8 match, 8 tool_call, 0 malformed

## Por modo

| mode | total | tool_calls | malformed | matches | match_rate |
|---|---:|---:|---:|---:|---:|
| with_tools | 10 | 8 | 0 | 8 | 80% |
| without_tools | 10 | 0 | 0 | 10 | 100% |

## Por cenário

| cenário | esperado | decisão | source | match |
|---|---|---|---|---|
| math.simple_addition | tool_call | tool_call | native | ✅ |
| ... |
```

## Custo e limites

- **Dry-run**: 0 token, 0 network, ~5ms de execução.
- **Live**: ~30 chamadas × ~300 tokens de saída = ~9k tokens de output. Em modelos caros (Claude Opus, GPT-4), custa alguns centavos. Em modelos baratos (Mistral 7B, Qwen 7B), custa fração de centavo.
- **Timeout por run**: 30s. Configurável via `PROBE_TIMEOUT_MS` (env) ou `timeoutMs` no body da API.
- **Concorrência**: 2 runs em paralelo (configurável). Mais que isso arrisca rate limit do provider.

## Quando re-rodar

- Trocou o modelo padrão → **sempre** (custo de uma execução é baixo).
- Mudou o prompt de sistema do chat → rodar 1 turno para validar que não regrediu.
- Adicionou tool nova → cenário novo + re-rodar.
- Release de modelo novo no catálogo → rodar e commitar o JSON em `tools/probe-results/`.

## Limites desta sonda

- **Não mede multi-step tool use** (tool chama tool). Só primeiro turno.
- **Não mede latência** separadamente por turno (só `durationMs` agregado).
- **Não mede segurança** (prompt injection via tools). Isso é outra frente.
- **Não exercita todas as tools reais** do projeto (só 3 didáticas).

Esses pontos são extensões naturais para a **Frente 16** ou seguintes, conforme demanda.

## Arquivos

- `backend/src/tools/probe/scenarios.js` — 5 cenários canônicos.
- `backend/src/tools/probe/schemas.js` — 3 schemas de tool (calculator, read_file, list_files).
- `backend/src/tools/probe/classifier.js` — classificador (nativo → json_block → xml_block → fallback).
- `backend/src/tools/probe/results.js` — agregador + veredito + Markdown.
- `backend/src/tools/probe/probeRunner.js` — orquestrador (sequencial com concorrência 2).
- `backend/src/tools/probe/parseFallback.js` — JSON.parse que nunca joga.
- `backend/src/tools/probe/probe.test.js` — testes unitários (classificador, agregador, scenarios).
- `backend/src/routes/toolProbe.js` — endpoint admin `POST /admin/tool-probe`.
- `backend/src/routes/toolProbe.test.js` — testes do router.
- `backend/scripts/run-tool-probe.mjs` — CLI.
- `backend/tools/probe-results/` — diretório para histórico (não commitar todo run).
