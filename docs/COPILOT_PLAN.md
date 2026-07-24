# Frederico Companion → Copiloto de Desenvolvimento

Plano de evolução do agente para um copiloto proativo, seguro e especializado em
desenvolvimento — analisado sobre a implementação atual, dividido em fases, com
foco em **comportamento real** (nada de monitoramento simulado ou diagnóstico
sem evidência, conforme a seção 27 do pedido).

## 1. Diagnóstico da implementação atual

**O "agente" hoje é dois sistemas distintos:**

1. **O motor de execução** (`backend/src/agent/`): `loop.js` (orquestrador com
   ferramentas, sandbox, visão, checkpoints), `multiModel.js`/`orchestrator.js`
   (multi-modelo e equipes), `tools.js` (run_python, bash, read/write/list,
   zip, cnpj, generate_image, web_search/fetch, GitHub), `sandbox.js` (Docker
   isolado por conversa), `checkpoint.js`/`executionState.js` (retomada). É
   **poderoso**, mas **reativo**: só roda quando o usuário manda uma mensagem.

2. **A camada Companion** (`backend/src/companion/` + `frontend/src/Companion.jsx`):
   personagem flutuante (Luma) com modos (silencioso/auxiliar/proativo/foco/
   apresentação), `monitor.js` (Git sem-commit/sem-push + `errorDigest` para
   erros recorrentes), `events.js` (fila de alertas com auditoria) e
   `useCompanion` (poll leve). É a **base de proatividade**, mas ainda rasa.

**Permissões e auditoria hoje:** existe autorização por texto para rede/Git-write
(`assistantPolicy.js`), tabela `assistant_tool_permissions` por assistente e o
guard de comandos destrutivos (`tools.js`), mas **não há um modelo central de
permissões por nível nem um log de auditoria persistente das ações do agente**.

**Configurações hoje:** espalhadas em painéis (ToolsPanel, DeveloperPanel,
ProviderPanel, PrivacyPanel, permissionsPanel, Companion settings). Não há uma
aba central de Configurações.

## 2. Problemas encontrados

- Proatividade **rasa**: só Git + erros recorrentes; sem terminal, build, testes,
  dependências, recursos, watchdog.
- Sem **memória técnica persistente** de incidentes (o "esse erro já ocorreu" só
  existe em memória volátil do `errorDigest`).
- Sem **log de auditoria** das ações do agente (exigido para autonomia segura).
- Sem **níveis de autonomia** acionáveis (os 5 níveis existem como número, mas
  não gateiam ações de fato).
- Configurações **fragmentadas**.
- Sem **central de diagnósticos**, **painel de saúde**, **watchdog** real,
  **gerenciador visual de tarefas** dedicado.

## 3. Arquitetura proposta (modular)

Mapa dos módulos do pedido (seção 28) sobre o código:

| Módulo | Onde vive | Estado |
| --- | --- | --- |
| Orquestrador do agente | `agent/loop.js` | existe |
| Motor de proatividade | `companion/proactivity.js` (novo) | parcial (`monitor.js`) |
| Gerenciador de permissões | `companion/permissions.js` (novo) | parcial |
| Monitor de terminal/logs | `companion/monitor.js` + ingestão SSE | parcial |
| Monitor de recursos | `companion/health.js` (novo) | falta |
| Watchdog | `companion/watchdog.js` (novo) | falta |
| Gerenciador de tarefas | `routes/tasks.js` + UI dedicada | parcial |
| Central de diagnósticos | `companion/incidents.js` (novo) | falta |
| Memória do projeto / base de incidentes | `companion_incidents` (novo) | falta |
| Motor de notificações | `companion/events.js` + canais | parcial |
| Analisador de código/segurança | reusa `/code-review`, `/security-review` | parcial |
| Monitor de dependências | `companion/deps.js` (novo) | falta |
| Integração com Git | `connectors/github.js` + `monitor.js` | existe |
| Relatórios | `companion/reports.js` (novo) | falta |
| Assistente de prompts | `frontend` + `companion/promptCoach.js` (novo) | falta |
| Interface do agente | `Companion.jsx` (evoluir p/ painel lateral) | parcial |

**Princípio:** cada sinal vira um **evento/incidente estruturado e auditável**,
persistido, com grau de confiança e evidência — nunca um texto solto.

## 4. Novo fluxo de interação

`sinal real (git/log/tarefa/recurso) → classificação (útil/alerta/erro/ruído) →
deduplicação + correlação com histórico → evento no nível de proatividade do
usuário → sugestão/alerta com evidência → ação sob permissão → auditoria →
verificação do resultado → registro no histórico de incidentes.`

## 5. Estrutura das configurações (aba central)

Geral · Agente · Inteligência artificial · Desenvolvimento · Privacidade e
segurança · Avançado (conforme a seção 3 do pedido). A tela principal mantém só
os atalhos frequentes; o resto migra para a aba central.

## 6. Plano de implementação (fases)

- **Fase 1 — Fundação:** aba de configurações, níveis de proatividade/autonomia
  acionáveis, **modelo de permissões central**, **log de auditoria**,
  **base de incidentes persistente**, watchdog básico, gerenciador de tarefas.
- **Fase 2 — Desenvolvimento:** monitor de terminal/logs, central de
  diagnósticos, análise de bugs com causa raiz, correlação com histórico.
- **Fase 3 — Inteligência:** assistente de prompts, sugestões contextuais,
  memória do projeto, análise de código, revisão multi-modelo.
- **Fase 4 — Observabilidade:** monitor de recursos, dashboard de saúde,
  relatórios, notificações, detecção de degradação.
- **Fase 5 — Automação controlada:** correções assistidas, testes automáticos,
  Git, rollback, sandbox de simulação.

## 7. Fase 1 — entregue nesta etapa (fundação)

Começo pela espinha dorsal que torna a proatividade **real e auditável**:

- **Base de incidentes** (`companion_incidents`): memória técnica persistente por
  projeto — problema, causa, arquivos, solução, comandos, evidência, confiança,
  status, ocorrências, commit/PR. `findSimilar` correlaciona um erro novo com os
  anteriores (habilita "esse erro já ocorreu antes"). Não depende da memória da
  conversa.
- **Log de auditoria** (`companion_audit`): toda ação relevante do agente
  (observou/leu/executou/alterou) com ator (modelo), permissão, autorização,
  resultado — pré-requisito para os níveis de autonomia.
- **Correlação real:** o monitor de erros recorrentes passa a registrar/atualizar
  incidentes (com contagem de ocorrências), não só um alerta volátil.

As demais fases entram nas próximas etapas, validando cada uma antes de seguir.
