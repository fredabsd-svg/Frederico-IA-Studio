# Multimodelo

> Atualizado em **2026-07-25**. Descreve o que `backend/src/agent/multiModel.js`
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
| **Estado do pipeline** (etapa atual, concluídas, pendentes) | variáveis locais de `runMultiModel` | ❌ |

### Lacuna crítica — F-15

**Não existe coordenador durável do pipeline.** Se o backend reiniciar entre a etapa 2 e a
3, o sistema **não** retoma a etapa 3: só o `runAgent` interno de uma etapa isolada tem
checkpoint.

Proposta registrada (não implementada):

```sql
CREATE TABLE pipeline_runs (
  pipeline_run_id   TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  current_stage     INTEGER NOT NULL,
  completed_stages  TEXT NOT NULL,   -- JSON
  pending_stages    TEXT NOT NULL,   -- JSON
  artifact_versions TEXT NOT NULL,   -- JSON
  status            TEXT NOT NULL,   -- running | paused | done | failed
  checkpoint        TEXT,
  updated_at        TEXT NOT NULL
);
```

Com ela, o boot varre `status='running'` e continua a **próxima etapa pendente**, e
`POST /resume` consulta o pipeline antes do checkpoint do agente.

---

## 6. Testes

`backend/src/multiModel.test.js`, `backend/src/agent.developerTeam.test.js`,
`backend/src/modelMatrix.test.js`, `backend/src/agent/prompts.dev.test.js`.

**Faltam** (ver `docs/TESTING.md` §6): retomada do pipeline após reinício (F-15),
provedor HTTP simulado que permita exercitar os quatro modos ponta a ponta (F-13),
e preservação do arquivo real entre revisores sob interrupção (F-23).
