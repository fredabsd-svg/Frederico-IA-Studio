# ADR 0003 — Runs duráveis e máquina de estados explícita da execução

Data: 2026-08-07

## Contexto

A auditoria do Modo Desenvolvedor (Developer Workspace 3.0) encontrou duas
causas estruturais da sensação de fragilidade:

1. **A evidência da execução era efêmera.** As etapas de ferramenta, o estado
   da execução e a saída do terminal existiam apenas no buffer SSE em memória
   (`liveStream.js`) e no estado do React. Um reload apagava o terminal e a
   atividade de execuções anteriores; um restart do backend apagava até o run
   corrente, sem qualquer sinal ao usuário. O limite era conhecido e registrado
   no `CONTINUIDADE.md`, mas contradiz a Regra 2.3 (estado que precisa
   sobreviver a reinício não pode existir apenas em memória) na área onde a
   confiança do usuário mais depende de evidência.
2. **A máquina de estados era implícita.** `executionState.js` definia um
   vocabulário de 14 estados, mas qualquer transição era aceita — o estado real
   do loop vivia em ~20 flags mutáveis dentro de uma função de ~1.500 linhas.
   O frontend compensava com heurísticas ("concluído" deduzido do fim do
   stream), produzindo sucesso falso em execução interrompida.

## Decisão

1. **Runs viram entidade persistente.** Duas tabelas novas (migration 032):
   `agent_runs` (uma linha por execução: estado, modelo, mensagem final,
   started/ended) e `agent_run_events` (event log append-only com `seq`,
   somente eventos estruturais: `tool_start`, `tool_result`, `run_state`,
   `input_required`, `plan_update`, `files`, `file_checks`). `delta`, `status`
   e `tool_progress` não são persistidos — o event log guarda a estrutura da
   execução, não o stream. O gravador (`agent/runLog.js`) mora na ROTA, único
   ponto por onde todos os eventos passam; escritas são serializadas e uma
   falha de escrita desliga o gravador sem derrubar o run. No boot, runs sem
   `ended_at` são marcados `recoverable_error` ("o servidor foi reiniciado") —
   nunca ficam "executando" para sempre. A retomada reutiliza o mesmo
   `run_id` e continua a sequência de eventos.
2. **Transições de estado viram contrato.** `agent/runStateMachine.js` define
   a tabela de transições válidas e o rastreador `createRunStateTracker`, o
   único emissor de `run_state` dentro de um run. Transição inválida em
   produção não derruba o run: é emitida com o carimbo `invalidTransition` e
   registrada em log (o carimbo é falha nos testes). O frontend passa a poder
   confiar no `run_state` sem heurística própria.

## Alternativas descartadas

- **Persistir os blocos na própria mensagem (`messages.blocks`).** Amarraria a
  evidência ao formato de exibição e crescia sem limite dentro de uma tabela
  quente; o event log com `seq` permite reconstrução, replay e auditoria sem
  tocar no schema de mensagens.
- **Gravar dentro do `runAgent` (loop).** O loop não vê os eventos do
  multimodelo/orquestrador nem os repassados por sub-agentes; a rota vê tudo.
  Além disso, manter o gravador fora do loop preserva o isolamento do
  sub-agente (que não é dono da conversa).
- **Máquina de estados que rejeita transição inválida com exceção.** Derrubar
  a tarefa do usuário por um bug de rotulagem seria pior que o bug; o carimbo
  com telemetria pega o defeito sem punir o usuário.
- **Redis/pub-sub para o replay.** O sistema continua assumindo uma réplica
  (Regra 2.3); o `liveStream` permanece como cache quente e o Postgres é a
  fonte durável. Multi-réplica continua exigindo ADR próprio.

## Consequências

- Reload e reabertura de conversa podem reconstruir etapas, terminal e plano
  de execuções passadas via `GET /conversations/:id/runs` — com timestamps
  reais do servidor, não relógio do navegador.
- Restart do backend deixa de produzir estado mentiroso: o run órfão é
  fechado como `recoverable_error` e a UI pode dizer o motivo.
- Cada execução gera escrita adicional no Postgres (dezenas a centenas de
  linhas pequenas por run, com teto de 5.000 eventos/run). O volume é baixo e
  as tabelas são varridas em cascata com a conversa; se o crescimento
  incomodar, uma retenção específica pode ser adicionada depois.
- O contrato SSE ganhou `_seq`/`_runId` também no stream primário do
  `POST /chat` (antes, só na reconexão) — cursor exato para dedup/reconexão.
