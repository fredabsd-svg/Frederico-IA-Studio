# Ambiente de execução do agente — persistência, recuperação e diagnóstico

O agente trabalha dentro de um container efêmero por (usuário, conversa). Este
documento responde as perguntas que decidem se uma tarefa longa sobrevive a uma
falha de infraestrutura: **o que é persistente, o que é temporário, quais são os
limites, como recuperar uma tarefa interrompida e como distinguir uma falha do
ambiente de um bug do projeto.**

Arquivos: `backend/src/agentEnv.js` (lógica testável sem daemon),
`backend/src/sandbox.js` (ciclo de vida do container) e a ferramenta `ambiente`
em `backend/src/tools.js`.

---

## 1. Camadas de armazenamento

| Caminho no sandbox | Origem no host | Sobrevive ao reinício? | Para quê |
| --- | --- | --- | --- |
| `/workspace` | `WORKSPACE_ROOT/users/<usuário>/<conversa>` | **Sim** | Arquivos da conversa: uploads, código, dados |
| `/workspace/outputs` | idem | **Sim** | Entregas — **só** este caminho vira cartão de download no chat |
| `/artifacts` → `/workspace/.artifacts` | idem | **Sim** | Relatórios, patches e resultados intermediários que não são entrega |
| `/cache` | `WORKSPACE_ROOT/users/<usuário>/.cache` | **Sim**, e é compartilhado entre as conversas do MESMO usuário | Cache de pip/npm/uv/poetry/yarn/pnpm |
| `/runtime/tmp` | camada do container | **Não** | `TMPDIR` de toda execução — descartável por design |
| `/tmp` | camada do container | **Não** | Nada que a etapa seguinte precise |

O cache é o que torna barata a reinstalação depois de um reinício: o wheel ou o
tarball já baixado continua no host, então `pip install` volta a ser uma
operação local. O escopo é o mesmo do workspace (`userDirName`) — um usuário
nunca lê o cache de outro.

Os **checkpoints** ficam em `WORKSPACE_ROOT/.checkpoints/<usuário>/<conversa>`,
**fora** da árvore da conversa: se morassem dentro, cada snapshot copiaria o
anterior e o próprio sandbox poderia apagá-los. Apagar a conversa apaga também
os checkpoints dela.

## 2. Limites

Todos consultáveis pelo agente (`ambiente` → `status`) e configuráveis no
`.env` (ver `.env.example`):

| Limite | Variável | Padrão |
| --- | --- | --- |
| Memória do container | `SANDBOX_MEMORY` | 1024m (2048m no `.env.example`) |
| CPUs | `SANDBOX_CPUS` | 1 |
| Processos | fixo | 256 (`PidsLimit`) |
| Tempo por comando | `TOOL_TIMEOUT_MS` | 45 s |
| Saída acumulada | `SANDBOX_MAX_OUTPUT_BYTES` | 8 MB |
| Ociosidade até reciclar | `SANDBOX_IDLE_TTL_MS` | 30 min |
| Sandboxes simultâneos por usuário | `MAX_SANDBOXES_PER_USER` | 2 |
| Carência para matar a árvore de processos | `SANDBOX_KILL_GRACE_MS` | 2,5 s |
| Checkpoints por conversa / tamanho | `CHECKPOINT_KEEP` / `CHECKPOINT_MAX_MB` | 5 / 300 MB |
| Cota de aviso de disco | `WORKSPACE_QUOTA_MB` | desligada |

A rede do container fica **desligada por padrão** e só abre quando o pedido do
turno a autoriza (`assistantPolicy.resolveSandboxNetwork`). O estado real vai
para o prompt e para o manifesto.

## 3. Timeout não derruba mais o sandbox

Antes, um comando que estourava o tempo levava o **container inteiro** junto.
Os processos filhos morriam — correto —, mas iam embora com eles os pacotes
instalados no turno, os serviços de apoio e todo o estado fora do workspace. E
o modelo não era avisado.

Agora `execInSandbox` injeta `FREDERICO_EXEC_ID=<id>` no ambiente do comando.
Como variáveis de ambiente são herdadas, varrer `/proc/*/environ` por esse id
encontra filhos, netos e bisnetos — inclusive os que trocaram de nome ou de
grupo de processos. No timeout (ou no cancelamento, ou no estouro de saída) o
backend manda `SIGTERM` e depois `SIGKILL` nessa árvore e **só derruba o
container se ela não morrer** dentro de `SANDBOX_KILL_GRACE_MS`.

Consequência prática: um `pytest` que travou não custa mais as dependências da
sessão. A saída diz qual dos dois aconteceu:

```
[TIMEOUT: comando excedeu 45s e foi encerrado (o sandbox continua de pé).
 A execução NÃO terminou: não trate o resultado como concluído.]
```

## 4. Resultado estruturado de execução

Toda execução devolve, além de `exitCode` e `output`:

```json
{
  "status": "timeout",
  "sucesso": false,
  "duracao_ms": 45012,
  "processo_encerrado": true,
  "saida_parcial": true,
  "arquivos_alterados": true,
  "diagnostico": {
    "categoria": "RESOURCE_LIMIT",
    "falha_do_projeto": "indeterminado",
    "mensagem": "O comando excedeu o tempo limite e foi encerrado.",
    "acao_recomendada": "Divida o trabalho em blocos menores…"
  }
}
```

`status` ∈ `ok | timeout | cancelado | limite_de_saida | falha_de_ambiente`.
`sucesso` só é `true` quando o comando **terminou por conta própria** com código
0 — é o que impede o agente de declarar tarefa concluída em cima de uma execução
interrompida.

`arquivos_alterados` compara uma impressão digital do workspace (contagem,
bytes, mtime mais recente) antes e depois. `null` significa "não deu para
comparar" — nunca um `false` inventado. Diretórios pesados (`node_modules`,
`.venv`…) não são percorridos; a pasta em si ainda é observada, então uma
instalação continua aparecendo como alteração.

### Taxonomia de falhas

| Categoria | `falha_do_projeto` | Exemplos |
| --- | --- | --- |
| `OK` | false | exit 0 |
| `DEPENDENCY_ERROR` | false | `ModuleNotFoundError`, `command not found` |
| `NETWORK_ERROR` | false | DNS, `Could not fetch URL`, `ECONNREFUSED` |
| `PERMISSION_ERROR` | false | `Permission denied`, `Read-only file system` |
| `RESOURCE_LIMIT` | false / indeterminado | OOM, disco cheio, timeout, saída grande |
| `TOOL_ERROR` | false | cancelamento pelo usuário |
| `ENVIRONMENT_ERROR` | false | o ambiente caiu antes do fim |
| `TEST_FAILURE` | **true** | pytest/jest com asserção quebrada |
| `APPLICATION_ERROR` | **true** | qualquer outro exit ≠ 0 |

A ordem de avaliação importa: um `pip install` sem rede imprime erro de rede
**e** de dependência — quem manda é a causa raiz. Um caso real que o teste
protege: `ModuleNotFoundError` contém a subcadeia `eNotFound`, então os códigos
de erro do sistema são casados com fronteira de palavra e sem `ignore case`,
senão uma dependência ausente viraria "problema de rede".

## 5. Reinício: o que foi preservado, o que foi perdido

Cada sandbox tem uma **geração**. Quando um container novo entra em serviço para
uma chave que já teve outro, isso é um reinício e um aviso estruturado fica
pendente:

```json
{
  "evento": "ambiente_reiniciado",
  "motivo": "timeout",
  "geracao_anterior": 1, "geracao_atual": 2,
  "sandbox_anterior": "…", "sandbox_atual": "…",
  "preservado": ["workspace da conversa…", "checkpoints e artefatos", "cache de pacotes (/cache)", "manifesto de dependências"],
  "perdido": ["processos em segundo plano…", "arquivos fora do workspace (inclusive /tmp)", "pacotes instalados em runtime fora do cache", "variáveis exportadas no shell"]
}
```

Motivos possíveis: `timeout`, `limite_de_saida`, `cancelado`, `ocioso`,
`troca_de_politica`, `teto_de_sandboxes_do_usuario`, `pastas_do_pc_alteradas`,
`reconciliacao`, `conversa_removida`, `desligamento`, `memoria_esgotada`,
`encerramento_inesperado`.

O aviso é entregue **uma única vez**, por quem chegar primeiro: o preâmbulo do
turno (`loop.js`, como nota de sistema em português) ou o primeiro resultado de
execução do turno (campo `ambiente_reiniciado`). O modelo não precisa deduzir o
reinício a partir de falhas posteriores.

## 6. Dependências instaladas em runtime

Quando um comando de instalação **termina bem**, ele é registrado em
`/workspace/.agent-env/packages.jsonl` — dentro do workspace, que é justamente
o que sobrevive ao evento que apaga os pacotes. Um install cortado por timeout
não entra (o manifesto mentiria).

Depois de um reinício, `ambiente` → `dependencias` devolve a lista com os
comandos originais. Reexecutá-los é barato porque o download já está em
`/cache`.

## 7. Checkpoints e rollback

`ambiente` → `checkpoint_criar` copia o workspace inteiro para fora da árvore da
conversa e guarda o SHA-256 de cada arquivo. `checkpoint_restaurar` repõe os
arquivos do snapshot e remove os que nasceram depois dele, informando quantos
foram restaurados, quantos removidos e quantos divergiram do hash. O estado
atual vira um checkpoint automático antes — um rollback errado tem volta.

**Segredos nunca entram num checkpoint** (o snapshot é uma cópia em claro no
disco do servidor): `.env` e variantes, `credentials.json`, `secrets/`,
`tokens/`, `*.pem`, `*.key`, `*.p12`, `id_rsa` e afins, `.npmrc`, `.pypirc`,
`.netrc` e `.git/config` (que pode carregar token na URL do remoto). Diretórios
pesados e reconstruíveis (`node_modules`, `.venv`, caches de ferramenta) também
ficam de fora. O que o checkpoint não guarda, ele também **não apaga** ao
restaurar.

Checkpoints não commitam nada e nunca saem do servidor.

## 8. Recursos e limpeza

`ambiente` → `recursos` devolve memória e CPU do container (rota `/stats` do
daemon, liberada no `docker-guard` com checagem de posse pela label), o uso de
disco do workspace com os maiores diretórios, os processos que mais consomem
(`ps` dentro do container) e um aviso quando a cota passa de 85%. Sem sandbox
ativo, ainda entrega a parte de disco — que é a persistente e a que costuma
estourar.

`ambiente` → `limpar_temporarios` remove os scripts `.tmp_*.py` órfãos e esvazia
`/runtime/tmp`. Nunca toca em uploads, outputs, artefatos, cache ou checkpoints.

## 9. Como recuperar uma tarefa interrompida

1. Leia o aviso `ambiente_reiniciado` (ou chame `ambiente` → `status`): ele já
   diz o motivo e o que sobreviveu.
2. `ambiente` → `dependencias`: reinstale o que era de runtime, com os mesmos
   comandos (o cache torna isso local).
3. `list_files` / `read_file`: confirme o que o workspace já contém antes de
   refazer qualquer coisa.
4. Se o trabalho ficou inconsistente, `ambiente` → `checkpoint_listar` e
   `checkpoint_restaurar`.
5. Só então continue — e nunca relate como concluída uma etapa cujo `status` foi
   `timeout`, `cancelado` ou `limite_de_saida`.

## 10. Testes

- `backend/src/agentEnv.test.js` — classificação de falhas (incluindo a
  precedência rede × dependência), impressão digital, ciclo de vida e aviso de
  reinício, checkpoints com exclusão de segredos e restauração por hash,
  manifesto de dependências, uso de disco e manifesto do ambiente.
- `backend/src/sandbox.stability.test.js` — execução ponta a ponta com daemon
  falso: resultado estruturado, timeout que preserva o sandbox, timeout que
  precisa derrubá-lo e o aviso de reinício subsequente (entregue uma só vez),
  binds de `/workspace` e `/cache`, `TMPDIR`, manifesto de instalação e
  checkpoint/restauração pelo caminho público.
- `docker-guard/src/policy.test.js` — a rota `/containers/<id>/stats` passa e
  continua exigindo posse pela label.

## 11. O que este trabalho NÃO cobriu

- **Streaming de logs em tempo real** de um comando longo (§3.5 do plano): a
  saída continua chegando ao modelo no fim da execução. O `status` estruturado
  já diz se o comando foi cortado, mas não há `process logs` incremental nem
  consulta ao progresso sem interromper.
- **Registro de portas e serviços** iniciados pelo agente (§3.13).
- **Transação de workspace explícita** (`begin`/`commit`/`rollback`, §3.11): o
  par checkpoint + restauração cobre o efeito prático, sem a sintaxe de
  transação.
- **Snapshot do ambiente** (§3.2, estratégia C): o que persiste é o cache de
  pacotes e o manifesto de instalações, não uma imagem do container.
