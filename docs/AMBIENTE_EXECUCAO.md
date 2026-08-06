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
| Progresso ao vivo / aviso de silêncio | `SANDBOX_PROGRESS_INTERVAL_MS` / `SANDBOX_STALL_NOTICE_MS` | 900 ms (piso 200) / 20 s |
| Log integral da execução | `EXEC_LOG_MAX_BYTES` | 4 MB |

A rede do container fica **desligada por padrão** e só abre quando o pedido do
turno a autoriza (`assistantPolicy.resolveSandboxNetwork`). O estado real vai
para o prompt e para o manifesto.

**Git remoto é recusado no sandbox, sempre.** `clone`, `fetch`, `pull`, `push`,
`ls-remote` e `remote add/set-url` param na guarda de execução
(`execGuard.js → remoteGitSubcommand`) com a mensagem que aponta
`github_clone`/`github_push`/`github_create_pr`. O motivo não é a rede: o token
do GitHub **nunca** entra no container (`connectors/github.js`), então essas
operações não funcionariam nem com a rede aberta. Sem o bloqueio, a falha chegava
ao modelo como erro de rede genérico e ele insistia — nova tentativa,
`GIT_SSL_NO_VERIFY`, abrir o github.com no navegador —, queimando etapas num
caminho que não existe. Git **local** (`status`, `diff`, `add`, `commit`, `log`,
`branch`, `checkout`, `config`, `stash`) segue liberado: é assim que o agente
trabalha no clone que o backend preparou.

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

## 4b. Saída ao vivo e log integral

Antes, a saída de um comando só chegava no fim: um `pytest` de 40 s era uma barra
parada, e não havia como saber se estava processando ou travado. Agora
`execInSandbox` aceita `onProgress` e o `loop.js` o repassa como evento SSE
`tool_progress`, casado pelo `id` da chamada:

```json
{ "type": "tool_progress", "id": "call_1", "trecho": "…", "linhas": 812, "bytes": 40311, "decorrido_ms": 12400 }
```

A transmissão é **agregada**, não por byte: um relatório a cada
`SANDBOX_PROGRESS_INTERVAL_MS` (padrão 900 ms, piso de 200 ms), com o pedaço
aparado em 2 000 caracteres por evento e um teto de 200 000 caracteres por
execução — passado o teto, a transmissão para e o log em disco continua. A
interface acumula os pedaços e mostra um terminal ao vivo no Ambiente de
Trabalho da IA, com rolagem automática.

**Detecção de silêncio.** Se o comando fica mudo por mais de
`SANDBOX_STALL_NOTICE_MS` (padrão 20 s), o relatório passa a trazer
`parado_ha_ms` e a interface avisa "sem saída há Xs". É o que distingue
"processando em silêncio" de "travado" — inclusive no cartão fechado, sem
precisar abrir o painel.

**Log integral.** O resultado entregue ao modelo é aparado nos **últimos 12 000
caracteres**, e o erro de uma suíte longa costuma estar no **começo**. Enquanto o
comando roda, a saída inteira é gravada em
`/workspace/.agent-env/ultima-execucao.log` (persistente, com teto de
`EXEC_LOG_MAX_BYTES`), com um `ultima-execucao.json` ao lado guardando comando,
status, exit code e duração. Quando há o que consultar, o resultado aponta o
caminho:

```json
"progresso": { "linhas": 3002, "bytes": 15044, "sem_saida_ha_ms": 12, "log_completo": ".agent-env/ultima-execucao.log" }
```

O campo `progresso` só aparece quando ajuda (execução interrompida ou mais de 200
linhas de saída) — em comando curto e bem-sucedido seria ruído em todo resultado.
O agente lê o log com `ambiente` → `ultima_execucao` (que entrega as duas pontas
e aponta o arquivo para leitura completa) ou direto com `read_file`.

A escrita do log é **síncrona**, num descritor aberto uma vez. Um
`createWriteStream` seria mais idiomático, mas o `end()` dele não garante os
bytes em disco: a leitura no mesmo tique encontrava o arquivo vazio.

O diretório `.agent-env` é **excluído da impressão digital** do workspace — sem
isso, a própria gravação do log faria `arquivos_alterados` sair `true` em toda
execução, e o campo perderia o sentido.

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

## 7b. Transação de workspace

`ambiente` → `transacao_iniciar` / `transacao_confirmar` / `transacao_desfazer`.
É açúcar sobre checkpoints, e vale dizer isso com clareza: `iniciar` fotografa,
`desfazer` restaura, `confirmar` só encerra (o ponto de retorno **continua** na
lista de checkpoints — confirmar não apaga histórico).

O ganho real não é a sintaxe: é a transação **aberta** reaparecer no preâmbulo do
turno seguinte. Sem isso, uma alteração em vários arquivos fica pela metade em
silêncio — ninguém confirma nem desfaz, e o ponto de retorno vira lixo esquecido
no disco. O estado fica em `/workspace/.agent-env/transacao.json` e também é
reportado por `ambiente` → `status` (campo `transacao_aberta`).

Duas transações simultâneas são recusadas: com dois pontos de retorno abertos
não há como saber qual `desfazer` deveria usar.

## 7c. Serviços e portas

`ambiente` → `servicos` cruza duas fontes:

1. **O que o agente iniciou.** Comandos que sobem servidor (`uvicorn`,
   `gunicorn`, `flask run`, `python -m http.server`, `vite`, `npm run dev`,
   `streamlit`, `php -S`, …) são reconhecidos e registrados em
   `/workspace/.agent-env/services.jsonl`, com a porta quando ela é inferível e
   a **geração** do sandbox. `npm run build` e `vite build` não contam — não
   sobem serviço.
2. **O que está realmente escutando agora**, sondando o container com
   `ss -ltnpH` (com `netstat -ltnp` como reserva; o parser aceita os dois
   formatos, para a observabilidade não depender de um binário específico).

O resultado classifica cada serviço em `escutando`, `nao_esta_escutando` ou
`perdido_no_reinicio` (registrado numa geração anterior à atual), e lista à parte
as `portas_sem_registro` — portas de pé que ninguém registrou, subidas por um
script. Sem sandbox ativo, tudo aparece como perdido, em vez de fantasmas "de pé".

Por que importa: sem isso o agente sobe uma segunda cópia numa porta já ocupada,
ou fica investigando por que o serviço "não responde" quando ele morreu com o
container. Serviços vivem **só** enquanto o sandbox viver e não são alcançáveis
de fora dele.

A sonda usa `execInActiveSandbox`: observar não materializa container nem
prolonga a vida do sandbox.

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
4. Se havia uma **transação aberta** (o preâmbulo do turno avisa), decida:
   `transacao_confirmar` se o trabalho está válido, `transacao_desfazer` se ficou
   inconsistente. Não deixe aberta.
5. Se subiu servidor antes, `ambiente` → `servicos`: depois de um reinício ele
   não está mais de pé, e a porta que você anotou não vale nada.
6. Se o trabalho ficou inconsistente e não havia transação, `ambiente` →
   `checkpoint_listar` e `checkpoint_restaurar`.
7. Só então continue — e nunca relate como concluída uma etapa cujo `status` foi
   `timeout`, `cancelado` ou `limite_de_saida`.

## 10. Testes

- `backend/src/agentEnv.test.js` — classificação de falhas (incluindo a
  precedência rede × dependência), impressão digital, ciclo de vida e aviso de
  reinício, checkpoints com exclusão de segredos e restauração por hash,
  manifesto de dependências, repórter de progresso (agregação, corte do pedaço,
  contagem de linhas e silêncio), log com teto e leitura das duas pontas,
  reconhecimento de serviços (e a distinção de `build`, que não sobe nada),
  parser de `ss`/`netstat`, cruzamento registro × portas vivas, estado da
  transação, uso de disco e manifesto do ambiente.
- `backend/src/sandbox.stability.test.js` — execução ponta a ponta com daemon
  falso: resultado estruturado, timeout que preserva o sandbox, timeout que
  precisa derrubá-lo e o aviso de reinício subsequente (entregue uma só vez),
  binds de `/workspace` e `/cache`, `TMPDIR`, manifesto de instalação,
  checkpoint/restauração, o **streaming** (pedaços entregues antes do fim do
  comando, log guardando o começo que o corte de 12 000 caracteres descarta, e a
  garantia de que gravar o log não conta como "o comando mexeu em arquivos"), os
  **serviços** (registro cruzado com a porta real; sem sandbox ativo aparecem
  como perdidos, não como fantasmas) e a **transação** (desfazer repõe e limpa,
  confirmar encerra sem reverter nem apagar o ponto de retorno, e desfazer sem
  transação aberta não mexe em nada).
- `docker-guard/src/policy.test.js` — a rota `/containers/<id>/stats` passa e
  continua exigindo posse pela label.

## 11. O que este trabalho NÃO cobriu

- **Consulta ao progresso pelo MODELO durante a execução** (`process status` /
  `process logs` de §3.5): é uma limitação do próprio laço de function-calling —
  enquanto uma ferramenta roda, o modelo está bloqueado esperando o resultado
  dela, então não há turno em que ele possa perguntar. O que existe cobre os dois
  efeitos práticos: o **usuário** vê a saída ao vivo (§4b) e o **agente** lê a
  saída integral depois, pelo log em disco. Uma consulta de verdade exigiria
  execução assíncrona de ferramentas (devolver um id e deixar o modelo consultar
  em turnos seguintes) — mudança grande no laço, fora do escopo desta frente.
- **Snapshot do container** (§3.2, estratégia C) — **não deve ser feito neste
  app.** Um `checkpoint create` de ambiente exigiria `POST /commit` (ou
  `/images/create`) na API do Docker, e essas rotas estão fora da allowlist do
  `docker-guard` de propósito: quem pode criar imagem no host pode construir uma
  imagem arbitrária e escapar do isolamento que o achado F-04 fechou (ver
  `docs/SECURITY.md` §4). Trocar isso por conveniência reabriria a falha mais
  grave que o projeto já corrigiu. O que persiste, portanto, é o **cache de
  pacotes** e o **manifesto de instalações** — que resolvem o problema real
  (reinstalar rápido depois de um reinício) sem ampliar a superfície de ataque.
- **Cota de disco imposta**: `WORKSPACE_QUOTA_MB` alimenta o aviso a partir de
  85%, mas nada BLOQUEIA a escrita quando o limite é passado. Impor exigiria
  quota do sistema de arquivos (ou `--storage-opt`), decisão de infraestrutura do
  operador — o app não tem como fazer isso por dentro do container.
- **Cota agregada dos checkpoints**: a poda é POR CONVERSA (`CHECKPOINT_KEEP`), não
  global. No pior caso, `CHECKPOINT_KEEP` × `CHECKPOINT_MAX_MB` = 1,5 GB por
  conversa. Numa instalação pública, ajuste os dois valores — ver risco F-26 no
  `CONTINUIDADE.md`.
