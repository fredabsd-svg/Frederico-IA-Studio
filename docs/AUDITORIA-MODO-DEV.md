# Auditoria do Modo Desenvolvedor

Estado: implementado; validação visual interativa pendente por indisponibilidade de navegador  
Verificado contra o código em: 2026-08-08  
Evidências: `backend/src/agent/loop.js`, `backend/src/agent/subagents.js`, `backend/src/agent/multiModel.js`, `backend/src/agent/pipelineRuns.js`, `backend/src/routes/conversations.js`, `frontend/src/App.jsx`, `frontend/src/hooks/useChat.js`, `frontend/src/hooks/useCompanion.js`, `frontend/src/devWorkspaceLayout.js` e testes relacionados.

## Resumo executivo

O repositório real não é o monorepo Tauri/Rust presumido no prompt. A aplicação é Node 20 + Express + PostgreSQL no backend e React 19 + Vite no frontend. O modo desenvolvedor já possui uma base substancial: loop agêntico com continuação automática, budget próprio de subagente, checkpoint persistente, máquina de estados, replay SSE, log durável de runs, terminal inferior redimensionável, rails laterais recolhíveis, Nino desmontável e layout progressivo.

O defeito histórico das duas etapas já possuía correções locais. Esta frente
fechou a lacuna ponta a ponta após reinício: a admissão consulta e reserva o
pipeline durável antes do SSE, colisões e falhas de persistência são explícitas,
e objetivo, opções e identidade do run sobrevivem ao processo.

## Resultado implementado

- **P0:** reserva durável fail-closed, 409 recuperável para run ativo, 503 para
  indisponibilidade da persistência, primitivas escopadas por usuário, contexto
  original restaurado no resume e stop persistente pós-restart.
- **P1:** uma única ação primária derivada do estado real (implementar, pausar,
  continuar, retomar, corrigir ou revisar) e ações restantes em menu.
- **P2/P3:** modo foco persistente com Alt+Shift+F; laterais compactadas, linha
  contextual e terminal inferior ocultos; seletor oficial do Nino sem store paralelo.
- **P4:** testes de concorrência/escopo/contexto, regressão acima de duas etapas,
  testes dos modos do Nino, checks completos e build de produção.

## Baseline anterior às alterações

- Backend: lint passou em 293 arquivos; 1366 testes executados, 1220 passaram, 144 foram pulados por exigirem PostgreSQL e 2 falharam por diferenças do ambiente Windows.
  - `agent/handoff.test.js`: comparação estrita LF versus CRLF.
  - `agent/pagePreviewServer.test.js`: criação de symlink recusada com `EPERM` pelo Windows.
- Frontend: lint passou; 166/166 testes passaram; build, budget de bundle e inventário CSS passaram.
- E2E não foi executado no baseline porque requer serviços e autenticação completos.

As duas falhas do backend são anteriores e não passam pelo motor de execução auditado.

## Causas raiz comprovadas e corrigidas

### CR-1 — a trava de execução não sobrevive ao processo (P0)

`backend/src/agent/control.js` mantém `controls` em um `Map` do processo. `isConversationActive` e `acquireConversationControl` são corretos contra duplo clique dentro de uma instância, mas ficam vazios após restart.

`backend/src/routes/conversations.js:440-453` consulta apenas `isConversationActive` antes de aceitar um novo chat. Não consulta `pipeline_runs`, embora esse coordenador sobreviva ao restart.

Impacto: depois de restart, uma conversa com pipeline persistido como `running` parece ociosa para a rota e pode receber um novo run.

### CR-2 — a defesa do banco detecta a duplicidade e depois a ignora (P0)

`backend/migrations/027_pipeline_runs.sql` cria `uniq_pipeline_runs_active`, garantindo apenas um pipeline `running` por conversa. Porém `backend/src/agent/pipelineRuns.js:createPipelineRun` captura qualquer erro de inserção, registra um warning e devolve `null`. `backend/src/agent/multiModel.js` interpreta `null` como “seguir em memória, sem retomada”.

Impacto: numa race entre instâncias ou após restart, a segunda execução não é rejeitada; ela continua sem checkpoint de pipeline, enquanto a execução antiga permanece `running` no banco. Duas IAs podem atuar no mesmo workspace.

Correção-alvo: conflito de pipeline ativo deve ser um conflito de estado explícito e recuperável, nunca degradação silenciosa.

### CR-3 — retomada persistente não é escopada pelo usuário (P0/segurança)

`backend/src/agent/pipelineRuns.js:loadPipelineRun` filtra somente `conversation_id`. As rotas primeiro validam a posse da conversa, o que reduz a exposição no caminho HTTP atual, mas a primitiva persistente em si não prova o dono e pode ser reutilizada incorretamente por outro chamador.

Correção-alvo: toda leitura/alteração de pipeline originada por conversa deve receber e aplicar `user_id`, conforme a regra de isolamento do projeto.

### CR-4 — o checkpoint de pipeline perde parte do contrato da execução (P0)

O `state_json` atual preserva estágios concluídos e caminhos de artefato. O objetivo é reconstruído buscando “a última mensagem do usuário”, e `webSearch`, `effort`, `developer` e o identificador do run SSE não são restaurados em `POST /resume`.

Impactos:

- uma mensagem posterior aceita indevidamente pode virar o objetivo da retomada antiga;
- a retomada pode usar capacidades e esforço diferentes do run original;
- o pipeline retomado abre um novo `resume_<id>` no log, enquanto o agente simples conserva o `runId` original.

Correção-alvo: persistir objetivo, opções de execução e identidade do run no coordenador; retomar com esses valores, sem inferir a partir do estado mutável da conversa.

### CR-5 — o cancelamento pós-restart não alcança o pipeline órfão (P0)

`POST /conversations/:id/control` atua apenas sobre o `Map` em memória. Depois de um crash, `stop` responde 409 mesmo quando existe `pipeline_runs.status='running'` aguardando recuperação.

Correção-alvo: permitir que `stop` encerre explicitamente o coordenador persistente do próprio usuário quando não houver processo vivo.

### CR-6 — a hierarquia de ações do workspace ainda compete (P1/P2)

`frontend/src/App.jsx:1180-1195` exibe simultaneamente Planejar, Implementar, Corrigir, Revisar, alternância de layout e painel. Durante execução, o chat também exibe Pausar e Parar; o rail direito e o terminal repetem o estado. A fonte do estado é correta (backend), mas a apresentação ainda contém múltiplos pontos de igual peso.

Correção-alvo incremental: uma ação primária por fase, ações secundárias em menu e modo foco próprio do workspace. Não será criado outro store nem outra máquina de estados.

### CR-7 — Nino tem os comportamentos necessários, mas não um controle oficial único (P2)

`frontend/src/hooks/useCompanion.js` persiste `enabled`, modo de comportamento, animações e proatividade no backend. `frontend/src/Companion.jsx:363` desmonta o componente quando `enabled=false`; os timers do hook também param. O comportamento silencioso existe por combinação de `mode`, alertas e animação, mas não há um seletor único ATIVO/SILENCIOSO/DESLIGADO no workspace.

Correção-alvo incremental: derivar os três estados das configurações existentes e salvá-los pela infraestrutura já existente, sem persistência paralela.

## Origem histórica do “limite de 2 etapas”

A string observada é emitida em `backend/src/agent/loop.js` quando o loop termina com `step_limit`. O número interpolado é `reachedStep + 1`; ele não é o default em si.

O histórico e o código atual comprovam duas causas anteriores:

1. o budget do filho era enviado com o nome `subagentBudget`, mas `runAgent` recebe `subagentRunBudget`; o objeto era descartado silenciosamente. A correção atual está documentada e conectada em `backend/src/agent/subagents.js:473-502`;
2. `step_limit` era terminal dentro do pipeline. Hoje `backend/src/agent/multiModel.js:679-721` carrega o checkpoint e retoma a etapa, e `backend/src/agent/loop.js:674-805` renova automaticamente janelas produtivas.

Os budgets atuais não usam a sobra do pai: `buildSubagentBudget` cria um objeto próprio e o loop aplica esse objeto apenas ao filho. A regressão continuará coberta por testes de budget, fiação do parâmetro e continuação acima de duas etapas.

## Mapa de estado e fluxo atual

### Execução

1. `POST /chat` valida a conversa e adquire `control` em memória.
2. A rota cria `runId`, LiveStream e `agent_runs`/`agent_run_events`.
3. `runAgent`, `runOrchestrator` ou `runMultiModel` executa e emite todos os eventos pelo mesmo `send`.
4. `runStateMachine` valida transições; `runLog` persiste eventos estruturais.
5. O frontend consome SSE, mantém cursor `(runId, seq)` e reconecta por `GET /stream`.
6. Ao recarregar, `GET /runs` hidrata mensagens e sessões a partir do log durável.
7. Agente simples retoma pelo `execution_checkpoints`; pipeline retoma por `pipeline_runs`.

### Workspace

- Server state: mensagens, run, plano, execução, eventos, arquivos, checkpoints e pipeline vêm do backend.
- UI state local: rails recolhidos, nível simples/completo, terminal e altura vivem em `localStorage`.
- Projeto e permissões: `useDevProjects` persiste no backend e migra estado legado de forma idempotente.
- Nino: preferências no backend; posição/minimização são preferências locais do dispositivo.

## Arquitetura-alvo desta frente

```text
POST /chat ou POST /resume
        |
        v
reserva durável por conversa + user_id
        |
        +--> conflito ativo -> 409 recovery_required (nenhum efeito colateral)
        |
        v
controle vivo em memória -> LiveStream/runLog -> engine
        |
        v
pipeline checkpoint { objetivo, opções, runId, estágios, artefatos }
        |
        +--> restart -> resume do mesmo objetivo/runId
        +--> stop -> terminal persistente
```

A trava em memória continua responsável por pause/abort de processos vivos. O coordenador no banco é responsável por impedir duplicidade entre processos e por classificar recuperação. São camadas complementares do mesmo run, não dois motores.

## Plano P0 → P4

### P0

- escopar leitura e atualização de pipeline por usuário;
- tornar conflito de criação fatal para o segundo run e sem efeito colateral;
- bloquear novo chat quando há pipeline recuperável;
- persistir objetivo, opções e runId do pipeline;
- permitir cancelamento explícito do pipeline órfão;
- adicionar testes de regressão de concorrência, contexto de resume e mais de duas etapas.

### P1

- reduzir as quatro ações concorrentes a uma primária contextual e menu;
- manter status derivado do backend e detalhes nos painéis existentes;
- não criar novo store ou painel.

### P2/P3

- adicionar modo foco do workspace com persistência e atalho;
- expor ATIVO/SILENCIOSO/DESLIGADO usando `saveSettings` existente;
- conferir overflow, foco e sobreposição nas resoluções críticas.

### P4

- testes unitários e de integração existentes;
- checks completos de backend/frontend;
- E2E e inspeção visual em 1366×768 e 1920×1080 quando os serviços locais estiverem disponíveis;
- registrar claramente qualquer teste não executado.

## Fora de escopo deliberado

- rewrite do `App.jsx` ou introdução de uma nova biblioteca de estado;
- nova stack de testes;
- mudanças no sandbox, tokens, chaves ou fronteiras do `docker-guard`;
- porcentagem de progresso inventada;
- exposição de cadeia de pensamento de agentes.

## Evidência final

- Backend: lint verde; 1.369 testes executados, 1.220 aprovados, 147 pulados por
  exigirem PostgreSQL e as mesmas 2 falhas basais do Windows (CRLF e symlink).
- Frontend: 169/169 testes, build, budget e inventário CSS verdes; bundle
  principal de 905,20 KB sob o teto de 920 KB.
- A inspeção visual em navegador não rodou porque nenhum navegador estava
  conectado à sessão. O build e a revisão estática dos breakpoints passaram;
  a prova visual permanece como validação manual recomendada do PR.
