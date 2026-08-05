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

**Retomada (boot ou `/resume`):**

1. No boot, `sweepStalePipelineRuns()` remove runs terminais antigos (90s de
   carência, mesma janela do liveStream). Nenhum run `running` órfão sobrevive
   indefinidamente.
2. Na rota `POST /conversations/:id/resume`, o sistema verifica primeiro se há
   um `pipeline_runs` ativo. Se houver, reconstrói a configuração multimodelo do
   `config_json` e chama `runMultiModel` com `pipelineResume`, que pula os
   estágios já concluídos (`currentStage`) e continua do próximo.
3. Se um novo `POST /chat` chega para uma conversa com pipeline run ativo,
   `runMultiModel` também detecta e retoma — o `loadPipelineRun` é chamado no
   início de toda execução pipeline.
4. O `finally` de `runMultiModel` garante que qualquer saída anormal
   (exceção não tratada) completa o run como `error` — sem órfãos.

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
