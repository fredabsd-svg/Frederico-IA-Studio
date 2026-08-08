# Testes

> Atualizado em **2026-08-06**.
> **Não escreva números de testes à mão neste arquivo.** A contagem sai de
> `backend/scripts/count-tests.mjs`, que roda as suítes de verdade; o CI publica o
> resultado no resumo da execução. Números digitados envelhecem em silêncio — foi o
> que aconteceu com a documentação anterior.

---

## 1. Rodar

```bash
# contagem real de todas as suítes (backend + frontend + Python)
cd backend && npm run test:count

# backend
cd backend
npm test                 # suíte completa (testes de banco se auto-pulam sem Postgres)
npm run test:integration # exige Postgres: migrações do zero + suíte completa
npm run lint             # node --check em todos os .js/.mjs
npm run check            # lint + test

# frontend
cd frontend
npm test                 # TODOS os arquivos *.test.js de src/ (inclusive src/hooks/)
npm run check            # lint + test + build

# sandbox (Python) — os kits de documento (docpro/xlspro/pdfpro) e o VALIDADOR
# dos artefatos entregues (validar_artefato).
# As dependências são obrigatórias: cada arquivo de teste se AUTO-PULA quando a
# sua biblioteca falta, então instalar só o openpyxl faz os testes do Word e do
# PDF sumirem em silêncio. As quatro primeiras são o conjunto que o CI instala; o
# matplotlib cobre só os gráficos do Word (sem ele, esse teste pula).
# O pypdf é do validador (check_pdf) e NÃO tem auto-pulo: sem ele os testes de
# PDF do validar_artefato falham em vez de sumir — é de propósito, porque a
# imagem do sandbox traz a lib e um pulo silencioso esconderia a lacuna.
python -m pip install openpyxl==3.1.5 python-docx reportlab pypdf matplotlib
python -m unittest discover -s sandbox -p '*_test.py' -v

# ponta a ponta (navegador real) — exige Postgres; ver e2e/README.md
cd e2e
npm install
npm run navegador        # baixa o Chromium do Playwright (uma vez)
E2E_DATABASE_URL=postgres://studio:studio@127.0.0.1:5432/studio npm test
```

Com Postgres disponível, **nenhum** teste do backend deve ser pulado — o CI falha se
algum for (`# skipped` > 0 no job de integração).

---

## 2. Postgres para os testes

```bash
docker run -d --name fred-pg -e POSTGRES_USER=studio -e POSTGRES_PASSWORD=studio \
  -e POSTGRES_DB=studio -p 5432:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgres://studio:studio@localhost:5432/studio
```

A mesma imagem da produção, de propósito: a extensão `pgvector` muda o caminho da busca
semântica, e testar com Postgres puro esconderia diferenças de comportamento.

---

## 3. O que o CI executa

| Job | Cobre |
| --- | --- |
| `lint` | `node --check` em todo `.js`/`.mjs` do backend e do frontend |
| `artifacts` | Testes Python dos **três kits de documento** — Excel (openpyxl real), Word (python-docx) e PDF (reportlab). O nome do job é herdado de quando ele só cobria o Excel. Vale como teste de portabilidade: o runner do GitHub **não tem as mesmas fontes** do sandbox, então é aqui que o caminho de degradação do `pdfpro` (sem TrueType, caindo para as Type1 base-14) é exercitado |
| `docker-guard` | Política do guarda + proxy real contra um daemon Docker falso, em Node 20 e 22 |
| `backend-unit` | Suíte do backend **sem** banco, em Node 20 e Node 22 |
| `backend-integration` | Postgres real: migrações do zero + idempotência + tabelas + cascade; suíte completa **sem skips**; boot real do backend + `/api/health`; portão de autenticação (9 rotas → 401) |
| `frontend` | Todos os arquivos de teste de `src/` + build + catraca de bundle (dois tetos: entrada e total) + inventário de CSS |
| `e2e` | **Navegador real** (Chromium) contra o build de produção do frontend, backend real e Postgres real; o provedor de IA é simulado (`e2e/fixtures/provedorFalso.mjs`). Cobre streaming, troca de conversa no meio da resposta, reconexão e o portão de consentimento |
| `compose` | `docker compose config` dos dois arquivos + build das imagens do backend e do guarda + **checagem de que só o `docker-guard` monta o socket** (regressão do F-04) |
| `contagem` | Executa tudo e publica a contagem no resumo (os E2E entram **listados**, não executados — quem os roda é o job `e2e`) |

Node 20 = o da imagem de produção; Node 22 = a linha LTS atual. O que roda na VPS é testado.

---

## 4. Convenções

**Testes que precisam de banco** se auto-pulam quando não há Postgres:

```js
const { db } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

test('...', { skip: needsDb }, async () => { /* ... */ });
```

**A descoberta dos testes é feita por `scripts/run-tests.mjs`**, não pelo glob do
`node --test`. Motivo: a expansão de padrão pelo próprio runner só existe a partir do
Node 22, e no Node 20 — a versão da imagem de produção — `node --test 'src/**/*.test.js'`
procura o caminho literal e falha. Adicionar um arquivo `*.test.js` em qualquer lugar de
`src/` basta: ele é encontrado sozinho, em qualquer versão.

**Testes que tocam disco** usam `fs.mkdtempSync(os.tmpdir(), ...)` e definem
`process.env.WORKSPACE_ROOT` / `DATA_DIR` **antes** do `await import(...)` do módulo sob
teste — vários módulos leem essas variáveis no momento da importação.

**Nomes de teste descrevem o comportamento, não a função.** Preferimos
*"o mesmo id de conversa em usuários diferentes NÃO compartilha diretório"* a
*"testa workspaceFor"*: quando quebra, a mensagem já diz o que se perdeu.

---

## 5. Testes criados pela auditoria de 2026-07

| Arquivo | O que prova |
| --- | --- |
| `backend/src/sandbox.isolation.test.js` | Dois usuários com o mesmo id de conversa não compartilham diretório; travessia relativa é barrada; escopo de usuário é obrigatório; `userDirName` é injetivo; invalidação de sandbox é direcionada; apagar conversa de um não afeta o homônimo do outro; workspace legado é **migrado** com os arquivos; conflito preserva o legado; coleta de órfãos nunca escolhe container de terceiros |
| `backend/src/backup.test.js` | Origem da chave mestra; manifesto avisa quando a chave ficou de fora; pacote com chave é marcado como segredo; verificação de checksum detecta adulteração/ausência; trava contra backups simultâneos; **ciclo real cifra → backup → restaura → decifra** |
| `backend/src/routes/admin.test.js` | Bootstrap por `ADMIN_EMAIL` concede o papel uma vez; **outra conta com o mesmo e-mail não vira administradora**; usuário comum recebe 403; o papel sobrevive à troca de e-mail; ações e recusas ficam em `admin_audit` |
| `backend/src/uploads.test.js` | Armazenamento é em disco (não memória); tetos vindos do ambiente; recusa pelo `Content-Length`; teto de envios simultâneos por usuário; cota; hash por streaming; `commit` do temporário; limpeza de parciais e de abandonados |
| `backend/src/routes/upload.http.test.js` | **Integrado**: rota Express real + Postgres + multipart de verdade — grava no workspace do dono, registra no banco, isola entre usuários, 413 por lote e por `Content-Length`, sem temporários residuais |
| Acréscimos em `backend/src/clamav.test.js` | `scanPolicy` descreve o modo vigente; o lote **nunca** se declara "verificado" sem análise; arquivo em disco é escaneado por streaming |
| `docker-guard/src/policy.test.js` | Cada fuga conhecida é barrada: container privilegiado, bind de `/`, bind do próprio `docker.sock`, `/etc`/`/proc`/`/root`, travessia com `..`, prefixo parecido (`/ws-outro` não é `/ws`), `CapAdd`, GPU, `PidMode`/`UsernsMode` do host, rede do host, outra imagem, volume nomeado; endurecimento e cotas obrigatórios; rotas perigosas (`build`, `images/create`, `archive`, `update`, `swarm`…) recusadas |
| `docker-guard/src/server.test.js` | **Proxy real** contra um daemon Docker falso num socket unix: cada bloqueio verifica que a requisição **não chegou** ao daemon; posse por label impede derrubar o Postgres do compose; o `hijack` do exec faz o túnel de bytes e é recusado em container de terceiro |
| `backend/src/sandbox.dockerAccess.test.js` | O backend reporta em `/api/health` se está atrás do guarda ou com o socket na mão |
| `backend/src/agent/pageShot.test.js` | Guarda de rede da miniatura de página: host interno/loopback/metadados barrado, esquema não-http recusado, URL ilegível **negada** (falha fechada) e — o que a troca do puppeteer pelo Playwright poderia ter quebrado — **redirecionamento de página pública para a rede interna abortado antes de chegar ao navegador** |
| `e2e/tests/*.spec.js` | Navegador real contra o build de produção: streaming chega aos poucos, resposta persiste, troca de conversa no meio do stream não mistura respostas, reconexão depois de recarregar, indicador de "processando" na barra lateral, portão de consentimento (LGPD) e a mensagem de chave inválida nomeando o provedor certo (regressão do PR #140) |
| `backend/src/agentEnv.test.js` | Estabilidade do ambiente, sem daemon: falha de **ambiente** não é confundida com bug do projeto (e a precedência importa — `pip install` sem rede é erro de REDE, e `ModuleNotFoundError` **não** pode casar com `ENOTFOUND`); timeout e cancelamento nunca saem como sucesso; a impressão digital do workspace ignora a escrituração interna; o aviso de reinício sai **uma única vez** com o que sobreviveu e o que se perdeu; checkpoint copia o workspace **sem segredos**, restaura por hash e **não apaga** o que não guardou; workspace grande é recusado antes de gravar nada; repórter de progresso agrega, apara o pedaço e mede o silêncio; log com teto entrega as duas pontas; serviço é reconhecido sem confundir `build` com servidor; parser de `ss` **e** de `netstat` |
| `backend/src/sandbox.stability.test.js` | **Execução ponta a ponta com daemon Docker falso**: um timeout mata a árvore de processos e **preserva** o sandbox (só derruba o container se a árvore sobreviver), e a execução seguinte carrega o aviso de reinício — uma vez só; o container nasce com `/cache` do usuário e `TMPDIR` descartável; instalação cortada por timeout **não** entra no manifesto; a saída chega em pedaços **antes** do fim do comando e o log guarda o começo que o corte de 12 000 caracteres descarta; gravar o log não conta como "o comando mexeu em arquivos"; serviços cruzados com a porta real (e perdidos, não fantasmas, sem sandbox ativo); transação desfaz, confirma sem reverter e recusa a segunda abertura |
| `backend/src/agent/userInputRequest.test.js` | **Perguntas interativas (`ask_user`)**: o backend RE-VALIDA o que o modelo mandou — `kind` fora do enum, `select` com menos de duas opções, mais de oito opções, valores repetidos, HTML na pergunta/rótulo/opção e texto acima do limite; o **id vem do backend** (um id escrito pelo modelo é ignorado); propriedades desconhecidas são descartadas; a ferramenta não é oferecida a sub-agente, turno social, tarefa de segundo plano nem assistente sem ferramentas |
| `backend/src/agent/githubAccess.test.js` | **A matriz de publicação inteira** (desconectado, sem repositório, modo de leitura, modo gravável sem autorização, com autorização, sub-agente, turno social) e a **regressão exata**: a autorização estruturada continua valendo num turno em que o texto não autoriza nada — antes, era aí que `github_push`/`github_create_pr` saíam do inventário. Também: escopo por repositório/branch/base, ações desconhecidas descartadas, autorização só de `push` não abre PR, e a **catraca de inventário único** (o prompt não anuncia ferramenta que o executor não tem, nem o contrário) |
| `backend/src/execGuard.remoteGit.test.js` | Git **remoto** pelo sandbox é recusado com a mensagem que aponta `github_clone`/`github_push`/`github_create_pr` — inclusive com opções globais (`git -c ... push`), comando composto (`cd x && git push`) e prefixo de ambiente. Git **local** continua liberado, e o reconhecimento é por posição de comando: `git commit -m "corrige o fetch"` e `echo "git push" >> README.md` não são confundidos com execução remota. A fuga por `os.system`/`subprocess` passa pela mesma guarda |
| `frontend/src/chatScroll.test.js` | **Smart Auto-scroll**, regras puras: limiar de "perto do fim" entre 64 e 96 px; roda para cima, PageUp/Home/seta e gesto de toque pausam o acompanhamento; `pausedByUser` vence um `following` que ficou ligado por um render atrasado; streaming NUNCA usa animação suave (era a animação reiniciada a cada token que arrastava o usuário de volta); e a **chave de conteúdo** muda quando o texto cresce, quando uma etapa avança ou quando chega uma pergunta — e **não** muda no tique do relógio |
| `frontend/src/executionSessions.test.js` | Fonte única das sessões de execução: a identidade usa `_key` (o evento `saved` troca o id no meio do streaming e não pode trocar a sessão do terminal); execução ao vivo tem precedência sobre a sessão fixada pelo usuário; o resumo conta por categoria e mede a duração com o relógio recebido (o chat não re-renderiza por segundo); o status distingue pergunta, avisos e interrupção — e **uma pergunta nunca se apresenta como falha**; a pergunta pendente é a mais recente e vira resolvida quando há mensagem posterior do usuário |
| `frontend/src/hooks/useDevProjects.test.js` (acréscimos) | A autorização de publicação sobrevive a reabrir a conversa, e **invalida** ao trocar de branch, de repositório ou de destino; não vale para vínculo de pasta do PC; ações desconhecidas são descartadas antes de sair do navegador; projeto antigo sem o campo `permissions` carrega sem quebrar; autorizações de comando (`commandGrants`) viajam no payload mesmo sem publicação |
| `backend/src/agent/runStateMachine.test.js` | **Máquina de estados explícita do run (ADR 0003)**: o ciclo real do loop é uma sequência válida; todo estado não terminal pode terminar e terminal não tem saída; transições de trabalho inválidas são rejeitadas pela tabela; o rastreador emite o contrato `run_state`, conta transições inválidas **sem derrubar o run** e sobrevive a falha do gravador durável |
| `backend/src/agent/runLog.test.js` | **Runs duráveis (ADR 0003)**: puros — reconstrução de etapas casa `tool_start`/`tool_result`, etapa sem resultado em run não concluído vira `interrupted` (nunca `done`), erro segue a regra da UI (`error`/`exitCode`); com Postgres — ciclo gravar→fechar→reler, retomada continua a sequência do MESMO run, `finish` nunca rebaixa estado terminal, varredura de boot fecha órfãos como `recoverable_error`, e apagar a conversa remove tudo em cascata |
| `backend/src/agent/permissionPolicy.test.js` | **Política allow/ask/deny**: glob ancorado tolerante a espaços; compostos lineares divididos com a decisão mais restritiva; comandos comuns continuam `allow` (autonomia com portões); grant do usuário rebaixa `ask` mas **nunca** um `deny`; normalização falha-fechada (só padrões `ask` da política sobrevivem) |
| `backend/src/agent/planTool.test.js` | **Plano estruturado (`update_plan`)**: `completed` sem evidência é **recusado** (sem sucesso falso no plano); status fora do enum, plano vazio e excesso de passos recusados; ids duplicados desambiguados; ferramenta só oferecida na missão de desenvolvimento do agente principal |
| `frontend/src/runHydration.test.js` | **Hidratação dos runs duráveis**: blocos reconstruídos na mesma forma do caminho ao vivo (epoch-ms); casa por `messageId` ou pelo `runId` do `execution_meta`; mensagens com blocks ao vivo têm prioridade; interrupção persistida não vira sucesso |
| `backend/src/agent/subagents.test.js` (acréscimo F-24) | **Fiação do orçamento**: o runner injetado recebe `subagentRunBudget` (o nome antigo `subagentBudget`, que o runAgent descartava em silêncio, não pode voltar) |
| `backend/src/agent/changeSet.test.js` | **ChangeSet real**: parsers de `status --porcelain` (M/A/D/R, não rastreado, renomeação) e `--numstat` (binário = null, `{a => b}`); integração com um repositório git DE VERDADE criado num workspace temporário (hermético: ignora config global do runner); workspace sem clone devolve lista vazia (a UI cai no fallback) |
| `backend/src/agent/codeIntel.test.js` | **Code Intelligence leve**: globstar (`src/**/*.js` inclui `src/app.js`), `node_modules`/`.git` e binários fora da busca, regex inválida vira erro claro (vai ao modelo, não explode), limites cortam com aviso explícito — nunca truncamento silencioso |
| `backend/src/agent/doomLoop.test.js` | **Doom loop**: a 3ª chamada idêntica com o mesmo resultado é bloqueada; resultado NOVO zera a contagem (repetir argumentos com progresso é legítimo); o erro estruturado instrui a mudar de estratégia |
| `frontend/src/devWorkspaceLayout.test.js` | **Layout do workspace**: nível desconhecido cai no padrão simples; simples recolhe as laterais e reduz as abas do rail; **a escolha explícita do usuário vence o padrão do nível** (simplicidade progressiva não desfaz clique); chat/plano/terminal existem nos dois níveis; a linha de contexto usa a branch REAL do pré-voo (com a nota "a partir de main" quando derivada), tira o prefixo de provedor do modelo e OMITE item sem dado real — só permissões sempre aparece ("somente leitura" é informação, não vazio) |
| `backend/src/agent/diffView.test.js` | **Diff e reversão por hunk**: parser separa cabeçalho/hunks com posição e contagem; o patch remontado leva UM hunk só e termina em nova linha; ciclo real com git — reverter um trecho desfaz só ele e **preserva a outra edição**; arquivo novo vira adição e é descartado inteiro (hunk é recusado com motivo); hunk inexistente, caminho absoluto e travessia (`..`) são recusados |
| `backend/src/agent/reviewGate.test.js` | **Review gate**: só linhas ADICIONADAS contam (o mesmo texto como contexto não vira achado) e o número de linha é o real; segredos nos formatos `sk-`, `ghp_`, `AKIA`, chave privada e string de conexão; depuração respeita a linguagem (`print(` conta em `.py`, não em `.js`); `.only/.skip` é high; código sem teste tocado é high, mas só doc alterada não exige teste; remoção de caminho sensível pesa mais; escopo só acusa com plano presente e ≥3 arquivos não mencionados; "limpo" ignora low/medium mas não high/blocker |
| `backend/src/agent/workBranch.test.js` + acréscimos em `githubAccess.test.js` | **Branch de trabalho por tarefa**: nome determinístico por conversa (retomada não cria branch nova) e aceito pelo validador do conector; protegida deriva com a vinculada como base; branch explícita não é atropelada; modo de leitura nunca deriva; a autorização estruturada é conferida contra a branch EFETIVA (autorização para a protegida dá `scope_mismatch`); a nota avisa que a branch é de trabalho |
| `backend/src/memory/projectStore.devProjects.test.js` | **Projetos dev no servidor (ADR 0004)**: permissões/modo persistem e um chamador antigo (sem os campos) não apaga o registro (COALESCE); modo inválido não entra; `listProjects` deriva as conversas do vínculo real, por dono; excluir SOLTA as conversas em vez de apagar histórico; posse recusa outro usuário |
| `frontend/src/hooks/useDevProjects.test.js` (acréscimos ADR 0004) | `projectFromServer` converte a linha do servidor no projeto completo do cliente (defaults seguros para linha antiga; sessão reconstruída carrega a autorização inteira) |
| `e2e/tests/modo-desenvolvedor.spec.js` | **Navegador real.** Auto-scroll: acompanha no fim, **subir durante o streaming não puxa o usuário de volta** (a regressão que originou a frente), o botão "Ir para o final" retoma o acompanhamento e enviar força o acompanhamento uma vez. Perguntas: texto/confirmação/seleção têm interface própria, **não** aparecem como erro (nenhum "Reenviar", nenhum toast de falha), fechar o modal não descarta, a solicitação sobrevive ao reload sem duplicar, responder vira mensagem do usuário e o turno seguinte continua — e conversas diferentes não misturam perguntas. Terminal: aparece ao executar ferramenta, o cartão grande **sai** do balão, o compositor nunca é coberto (comparação de `boundingBox`), recolhe/expande/maximiza, redimensiona pelo teclado, a altura persiste no reload, a sessão concluída reabre pelo histórico e outra conversa não recebe os logs |
| `e2e/tests/layout.spec.js` | **Nada pode cobrir o botão de enviar**: sobreposição zero em oito larguras (1920 → 390px), compositor alto não empurra o personagem de volta, **clique real** no botão no desktop e no celular, e um guarda contra o exagero (o personagem tem de continuar visível na janela). Nasceu de um defeito real que a suíte encontrou — o avatar do copiloto cobria o botão em 1280px e em todas as larguras abaixo |

| `backend/src/design/tokens.test.js`, `bridge.test.js` | **Modo Design v2**: o catálogo e o system prompt não podem divergir (senão o modelo declara um nome e a interface procura outro); os controles são derivados do artefato, e um design fora do contrato devolve lista vazia; cor com carga (`#fff;background-image:url(...)`) é descartada inteira; a sobreposição entra no fim do `<head>` **sem** alterar o artefato; a ponte compila, é constante e nunca toca o DOM de fora |
| `backend/src/design/*.test.js` | Modo Design, camada pura: a resposta do modelo é limpa antes de virar versão (cerca de código que envolve tudo é desembrulhada, cerca **no meio** do HTML não corta o documento, chave dentro de string não desbalanceia o JSON de slides); layout inventado vira `content`; conteúdo é conferido contra o `output_type`; cor livre e nome de fonte com aspas são recusados (os dois entram em CSS); o deck escapa o texto do modelo e não usa CDN; o `.pptx` sai abrível (assinatura ZIP + partes do OOXML) |
| `backend/src/design/store.test.js` | **Com Postgres**: numeração das versões, reverter move o ponteiro **sem apagar** o que veio depois, poda no teto que nunca remove a versão em exibição, isolamento entre contas em toda leitura e escrita, token de prévia como capacidade regenerável, marca apagada não derruba o projeto |
| `backend/src/routes/design.http.test.js` | **Integrado**: rotas reais + Postgres + provedor de IA falso. Resposta suja vira artefato limpo; resposta sem HTML e resposta **cortada por limite de tokens** não viram versão (e o erro aparece no chat do projeto); a edição reenvia o artefato atual; a resposta da geração aponta para a versão NOVA (regressão encontrada pelo teste de navegador); projeto de outra conta é 404 em todas as rotas; a prévia sai com `CSP: sandbox` **sem** `allow-same-origin`; exportação por formato e por versão antiga |
| Modelo por projeto (`design.http.test.js`, `design.spec.js`) | A precedência tem um teste próprio: o modelo do PROJETO vence o do chat, e um projeto sem fixação (coluna nula, criado antes da coluna existir) cai no do chat sem passar a fixar nada por tabela. String vazia no PATCH solta a fixação; renomear sem mandar `model` não a toca. E no navegador: o seletor está DENTRO do editor (a lacuna que a mudança fecha) e `Esc` na lista de modelos não fecha o Modo Design |
| `e2e/tests/design.spec.js` | **Navegador real**: o HTML gerado é de fato renderizado dentro do iframe isolado, o `sandbox` do iframe não tem `allow-same-origin`, refinar por conversa cria uma versão nova e dá para voltar atrás, e a apresentação vira deck — não JSON na tela. Da v2: **clicar num elemento da prévia leva o alvo para o compositor** (a travessia da origem opaca por `postMessage`, que nenhum teste de unidade cobre) e **o slider muda a cor dentro do iframe na hora, sem criar versão** — com o ajuste sobrevivendo a fechar e reabrir o projeto |
| `sandbox/*_test.py` (identidade "Tinta & Latão") | Sobre os blocos que entraram DEPOIS da grade. **PDF**: o documento com linha do tempo, gráficos vetoriais e contracapa passa na **própria auditoria** do kit — é essa a prova de que os blocos novos respeitam a mesma aresta; a pizza lê a participação na legenda em pt-BR (rótulo colado na fatia cairia dentro da fatia escura e vazaria a caixa); a barra parte do zero (base automática do reportlab faz série de 4,1 a 5,8 virar barras idênticas); a marca de sigilo aparece na capa e no rodapé e some com `confidencial=False`, e nunca aparece no estilo sóbrio; a contracapa cabe na página em qualquer variação de contatos. **Word**: nenhuma tabela sem largura declarada (100% ou dxa ≤ 17 cm com a `tblGrid` coerente — é ela que resolve o layout fixo); a numeração "SEÇÃO NN" é do kit e não sai em dobro; sumário, citação, linha do tempo, assinaturas em pares e contracapa entram no arquivo; a figura do gráfico respeita a aresta do corpo; o `Sobrio` identifica o documento, assina em pares e continua 100% preto. **Excel**: o painel é a primeira aba com KPIs e carimbo, o gráfico mora no painel mas referencia a aba de dados (sem a linha de TOTAL) e as cores do tema chegam ao arquivo — o tema ficava num `try/except` mudo e a pizza saía com a paleta padrão do Excel |

| `sandbox/validar_artefato_test.py` (F-23) | O **validador da entrega**, com arquivos reais. O que se prova não é "o arquivo saiu": é o veredito. Planilha que ABRE e traz `#REF!` reprova (cada um dos nove códigos do Excel tem caso); o teto de varredura sai **declarado** no relatório, e há um teste que fixa a consequência assumida — erro além do teto passa, e o relatório diz que a varredura foi limitada. Nos **gráficos**, os três defeitos que o Excel não denuncia porque o arquivo abre: aba inexistente, intervalo invertido (`C2:B2`) e série de valores vazia — cada um injetado reescrevendo o `chart1.xml` dentro do zip, como o defeito nasce. E a contraprova que evita o falso positivo que inutilizaria a checagem: categoria de TEXTO não é acusada de série vazia. No **Word**, documento vazio reprova, mas documento só com tabela **passa** (relatório que é uma tabela é entrega legítima). Sem `soffice` no runner, o recálculo se declara parcial em vez de falhar |
| `backend/src/agent.outputs.validatorSeam.test.js` | A **costura** entre o backend e o validador em Python — o caminho resolvido, a assinatura que o driver chama, o `COPY` no `Dockerfile` e o acordo de extensões entre o filtro em JS e o roteador em Python. Existe porque o `validateOutputs` engole exceção e devolve `{}`: um rename faria a validação sumir em silêncio, e a entrega voltaria a dizer "verificado" sem ter verificado |

Scripts de apoio: `backend/scripts/run-tests.mjs` e `frontend/scripts/run-tests.mjs`
(descoberta de testes independente da versão do Node), `backend/scripts/check-migrations.mjs`,
`backend/scripts/count-tests.mjs`, `backend/scripts/lint.mjs`, `frontend/scripts/lint.mjs`.

---

## 6. Lacunas de teste conhecidas

Reconhecidas, priorizadas e **não** cobertas até aqui — ver `docs/AUDITORIA_2026-07.md`:

| ID | Lacuna | Situação |
| --- | --- | --- |
| F-12 | SSE integrado: duas conversas simultâneas, troca rápida, reconexão | **Coberta em parte** por `e2e/tests/multiconversa.spec.js`: duas conversas, troca no meio do streaming sem mistura, e reconexão depois de recarregar a página. **Falta** o caso específico de `fromSeq` (reconectar o `/stream` sem duplicar eventos) exercitado de forma isolada |
| F-13 | Provedor HTTP simulado completo (streaming, tool calls, erros, timeout) | **Coberta em parte** por `e2e/fixtures/provedorFalso.mjs`: streaming com ritmo controlado, catálogo, erro 401, stall (`travado`), tool calls (`ferramentas`, `ferramentas-lentas`), resposta longa (`eco-longo`) e as três formas de pergunta interativa (`pergunta-texto`, `pergunta-confirmacao`, `pergunta-selecao`). **Falta** timeout de rede simulado no meio de um tool call |
| F-14 | Retomada após **interrupção real do processo** (matar o Node no meio) | Aberta |
| F-15 | Pipeline multimodelo retomável após reinício | Aberta |
| F-16 | Suíte de relevância de memória com casos **negativos** | Aberta |
| F-18 | Corpus documental do Docling (escaneado, DRE, PGFN, células mescladas…) | Aberta |
| F-19 | Git local para clone/commit/push do modo desenvolvedor | Aberta |
| F-20 | E2E de navegador | **Fechada** — `e2e/`, Chromium real contra o build de produção, no CI |
| F-23 | Validação de artefato: XLSX com `#REF!`, DOCX vazio, PDF com página em branco | **Fechada** — 38 casos em `sandbox/validar_artefato_test.py` com arquivos reais, mais a catraca da costura em `agent.outputs.validatorSeam.test.js` |
