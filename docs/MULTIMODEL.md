# Multimodelo

> Atualizado em **2026-08-05**. Descreve o que `backend/src/agent/multiModel.js`
> **faz hoje**, com as lacunas marcadas. Complementa `docs/ARCHITECTURE.md` §5.

---

## 1. O que é (e o que não é)

Dois ou mais **modelos de IA distintos** trabalham na mesma mensagem, cada um com um papel.
Cada participante é uma chamada **independente** ao provedor (`getUserProvider(userId,
modeloDoMembro)`) e produz resposta própria.

**Não confundir:**

| Recurso | O que faz |
| --- | --- |
| **Multimodelo** (`multiModel.js`) | Vários **modelos** distintos, cada um com seu papel |
| **Modo Equipe** (`orchestrator.js`) | Vários **assistentes** (personas) sobre o mesmo modelo |
| **Failover** (`agent/provider.js`) | Um modelo cai, outro assume — **não** é colaboração |

Limites: `MULTI_MAX_MODELS` (padrão 6), `MULTI_MAX_ROUNDS` (padrão 3).
Contextos: `full`, `recent`, `summary`, `none`.

---

## 2. Os quatro modos

### `compare` — comparação
Todos respondem **em paralelo**, sem se ver. As respostas ficam lado a lado no
`MultiModelBoard`. Cada slot tem status, custo e erro próprios; cancelar um
(`POST /conversations/:id/multimodel/cancel`) não derruba os outros. **Não há síntese
escondida** — o que aparece é o que cada modelo respondeu.

### `council` — conselho
Todos respondem em paralelo e um **coordenador** consolida: concordâncias, divergências,
erros apontados e resposta final. As contribuições individuais continuam visíveis — se o
coordenador falhar, os pareceres **não** são perdidos.

### `debate` — debate
Rodadas controladas (até `MULTI_MAX_ROUNDS`): cada modelo lê as respostas dos outros,
critica e revisa a própria. O texto de cada participante é aparado por
`clipForBriefing(..., META_TEXT_LIMIT)` antes de virar contexto da rodada seguinte — é o
que impede o crescimento explosivo do contexto. O coordenador fecha.

### `pipeline` — esteira sequencial
Cada modelo recebe o que os anteriores produziram; o último entrega. No **Modo
Desenvolvedor**, a etapa "implementador" executa de verdade via `runAgent` (ferramentas e
sandbox) e as etapas seguintes revisam **o mesmo workspace**.

Versionamento por etapa (`agent/artifacts.js`):

```
users/<dono>/<conversa>/.multimodel/<runId>/
  v01/  ← saída da etapa 1 (cópia de outputs/)
  v02/  ← saída da etapa 2
```

`snapshotArtifactVersion(userId, conversationId, { runId, stage, model, role, valid, checks })`
copia `outputs/` após cada etapa, com `sha256` por arquivo. O revisor abre o artefato
**existente** no workspace (não uma cópia velha), e uma etapa que apenas preserva o arquivo
não o faz desaparecer — as versões anteriores continuam recuperáveis em `.multimodel/`.

---

## 3. Contrato de prompt

`MULTI_ARTIFACT_PROTOCOL` (em `agent/promptRegistry.js`) define como cada etapa declara o
que produziu. As respostas dos **outros modelos** entram embrulhadas por
`untrustedContext()` — como dado, nunca como instrução. Um modelo não consegue, pelo texto
da própria resposta, instruir o coordenador ou a etapa seguinte a mudar de comportamento.

---

## 4. Capacidades e failover dentro do multimodelo

Cada membro é resolvido por `modelCapabilities.js` (`getModelProfile`,
`detectToolRequirement`, `supportsModelParameter`): ferramentas, visão, raciocínio e quais
parâmetros o modelo aceita. Um membro sem suporte a ferramentas não recebe definições de
ferramenta; um sem visão não recebe partes `image_url`.

**Ponto de atenção (parcial):** quando um membro cai e o failover troca o modelo, o
recálculo de capacidades acontece via `getModelProfile` do novo id — mas **não há teste**
cobrindo a troca de **família** no meio de um run multimodelo (por exemplo, sair de um
modelo com ferramentas para um sem). Ver F-13 em `docs/AUDITORIA_2026-07.md`.

---

## 5. Persistência e retomada

| O quê | Onde | Sobrevive a reinício? |
| --- | --- | --- |
| Cartões por modelo (status, custo, texto) | `messages.multi_meta` | ✅ |
| Versões de artefato | `.multimodel/<runId>/vNN/` em disco | ✅ |
| Checkpoint da etapa em execução | `execution_checkpoints` (via `runAgent`) | ✅ |
| **Estado do pipeline** (etapa atual, concluídas, pendentes) | `pipeline_runs` (PostgreSQL) | ✅ |

### Coordenador durável — F-15 (implementado em 2026-08-05)

O pipeline sobrevive a kill-9 do backend. A cada etapa concluída, o
`runMultiModel` grava o `currentStage` e o `state_json` (estágios concluídos
com texto, caminhos de artefato e config original) na tabela `pipeline_runs`
(migration 027). Na saída normal, o run é marcado como `done`; em cancelamento,
`stopped`; em erro, `error`.

**Admissão, retomada e cancelamento:**

1. No boot, `sweepStalePipelineRuns()` remove runs **terminais** antigos
   (`done`/`stopped`/`error`, 90s de carência, mesma janela do liveStream).
   Repare no limite: o sweeper **não** toca em `running`, de propósito — apagar
   um run `running` destruiria uma execução viva. A consequência é que um órfão
   deixado por um kill-9 não expira sozinho; quem o fecha é o item 3.
2. `POST /chat` consulta o coordenador persistente antes de qualquer efeito
   colateral. Se existir um run ativo, responde `409
   pipeline_recovery_required`: uma mensagem nova nunca fecha, herda ou
   substitui silenciosamente a tarefa anterior.
3. Para um pipeline novo, a rota reserva `pipeline_runs` **antes de abrir SSE
   ou gravar a mensagem**. O índice parcial é a exclusão mútua entre processos.
   Colisão vira conflito explícito; indisponibilidade do banco vira `503
   pipeline_persistence_unavailable`. Não existe execução degradada só em memória.
4. Na rota `POST /conversations/:id/resume`, o sistema carrega o run pelo par
   conversa + usuário e restaura configuração, objetivo, busca web, esforço,
   contexto de desenvolvimento, id da mensagem e o mesmo `runId`. Estágios
   concluídos são pulados pelo `currentStage`. **Esta é a única porta de retomada.**
5. Se não houver processo vivo depois de restart, `POST /control` com
   `action=stop` encerra atomicamente o coordenador persistente do próprio usuário.
6. O `finally` da rota e o de `runMultiModel` fecham reservas não concluídas
   como `stopped` ou `error`.
7. Uma etapa que para no meio por orçamento ou checkpoint (`resumable`) fecha o
   run como `stopped`, não `done`: o pipeline não terminou, e o histórico não
   pode dizer que terminou. A retomada dessa etapa específica continua sendo do
   checkpoint de agente único — limitação conhecida.

**Arquivos envolvidos:**
- `backend/src/agent/pipelineRuns.js` — primitivas (create/update/load/complete/sweep)
- `backend/src/agent/multiModel.js` — integração no `runPipeline()`
- `backend/src/routes/conversations.js` — rota `/resume` com detecção de pipeline
- `backend/src/server.js` — sweeper no boot e varredura periódica
- Migration 027: tabela `pipeline_runs`

---

## 6. Testes

`backend/src/multiModel.test.js`, `backend/src/agent.developerTeam.test.js`,
`backend/src/agent.pipelineRuns.test.js`, `backend/src/modelMatrix.test.js`,
`backend/src/agent/prompts.dev.test.js`.

**Faltam** (ver `docs/TESTING.md` §6): provedor HTTP simulado que permita exercitar os
quatro modos ponta a ponta (F-13), e preservação do arquivo real entre revisores sob
interrupção (F-23).
