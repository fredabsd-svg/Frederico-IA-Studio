# CONTINUIDADE — estado atual do Frederico AI Studio

> Arquivo **curto** de propósito. Só o presente: estado, riscos abertos e como retomar.
> O histórico completo está preservado em `docs/CHANGELOG_HISTORY.md` — nada é apagado,
> só muda de endereço quando deixa de ser "o presente".

---

## Estado atual

Aplicação multiusuário com agentes de IA, memória semântica, multimodelo, execução de
ferramentas em sandbox Docker, geração de documentos, Docling, conector GitHub, copiloto
(Nino) e **Modo Design** (site, apresentação ou documento visual gerado, refinado e
exportado num espaço próprio). Backend Node 20 + Express + PostgreSQL (pgvector);
frontend React 19 + Vite; autenticação Better Auth (e-mail/senha, GitHub, Google).

**Prontidão para produção: 🟡 amarelo — apto com restrições.**
**Nenhum risco crítico aberto** desde o fechamento do F-04 (o backend não detém mais o
socket do Docker — ver `docs/SECURITY.md` §4.3). A cobertura deu um salto nesta
integração: a retomada após interrupção real do processo **passou a ter teste** (F-14,
contra PostgreSQL de verdade), o tool calling nativo e o watchdog do provedor entraram
nos testes de navegador (F-13) e o SSE ganhou o caso de reconexão com cursor (F-12).

**O motivo declarado do amarelo não vale mais** (conferido em 2026-08-08, contra o
código). Este arquivo dizia que o pipeline multimodelo retomável segurava o verde —
que o F-15 tinha entregue "a tabela e as primitivas, mas o `runMultiModel` ainda não as
usa". **Isso estava errado:** o `runMultiModel` grava o estágio entre as etapas e retoma
por `pipelineResume`, com a rota `/resume` carregando o run ativo e teste de integração
contra PostgreSQL real. A ressalva verdadeira é outra e é menor — **não há retomada
automática no boot**: quem retoma é o cliente, pelo `/resume`. Junto com o F-15 foram
reconferidos F-05b, F-12, F-13 e F-14 (fechados) e F-18 e F-19 (parciais).

**A cor segue amarela porque ninguém decidiu mudá-la** — reclassificar prontidão é
chamada de quem opera, não efeito colateral de uma tabela de status. O **F-23 fechou**
nesta sessão (validador extraído para `sandbox/validar_artefato.py`, 38 casos com
arquivos reais) e o **F-18 avançou** (corpus fiscal atravessando o pipeline, 19 casos —
segue **parcial**, porque a extração por ML do Docling exige o serviço). O que falta:
F-19, F-11, F-16 e F-20 a F-22. Matriz e critérios em `docs/AUDITORIA_2026-07.md`
§2 e §6.

**O caminho de admissão do pipeline foi endurecido** (PR #200): a reserva no
PostgreSQL acontece ANTES de abrir o SSE e de gravar a mensagem, colisão vira
conflito recuperável em vez de execução degradada só em memória, e leitura,
atualização, conclusão e cancelamento passaram a ser escopados por usuário. A
ressalva acima continua valendo — quem retoma é o cliente, pelo `/resume`.

**Frentes desta sessão e onde cada uma parou** (2026-08-08):

| Frente | PR | Estado |
| --- | --- | --- |
| Frente 24 (handoff) + Frente 25 (`validar_pagina`) | [#195](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/195) | mesclado |
| Frente 26 — telemetria local de confiabilidade (Fase 66) | [#196](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/196) | mesclado |
| Veredito da `validar_pagina` → review gate (Fase 38 → 28) | [#197](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/197) | mesclado |
| Série temporal da confiabilidade (Fase 66) + poda deste arquivo | [#198](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/198) | mesclado (`fb2198d`) |
| Reconciliação da matriz da auditoria (F-05b, F-12 a F-15, F-18, F-19) | [#199](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/199) | mesclado (`dbbaabe`) |
| Motor durável e UX do Modo Desenvolvedor | [#200](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/200) | mesclado (`cecc9c2`) |
| Teto de tamanho para o CSS (Frente 11) | [#202](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/202) | mesclado (`9309ccd`) |
| **F-23** (validador de artefato) + **F-18** (corpus fiscal no pipeline) | [#203](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/203) | **aberto** |

**Tudo, menos o F-23, está na `main`.** A CI foi conferida verde em `58a0209`
(Fase 66) e `2d416f4` (Fase 38 → 28); os merges seguintes entraram com a CI da
branch verde. A branch de trabalho é **recomeçada a partir da `main` atualizada**
a cada merge, em vez de empilhar sobre histórico já mesclado — por isso cada PR
traz só a frente dele. O F-23 nasceu na branch enquanto o #199 era mesclado, e
por isso foi **rebaseado** sobre a `main` nova e saiu em PR próprio.

- **Último trabalho:** o **F-18 avançou** (segue parcial) — mesmo PR
  [#203](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/203).
  19 casos levam DRE, certidão PGFN, NF escaneada e razão analítico pelo pipeline
  real. As asserções foram escritas **depois** de sondar o comportamento — o
  contrário fixa o defeito achando que testou.
  **O corpus achou um defeito, corrigido junto:** tabela colada a uma frase cai
  em chunk `mixed`, e o `summarizeTables` só olhava chunks `table`. DRE com
  colunas inconsistentes saía como `count: 0, withWarnings: 0` — lê-se "nenhuma
  tabela com problema" quando o certo era "não procurei". E não era só métrica:
  a tabela não aparecia na listagem nem podia ser baixada em CSV. O `findTables`
  varre todos os chunks, e listagem e CSV usam a MESMA função (cada uma
  filtrava por conta própria, e duas listas derivadas em lugares diferentes
  acabam discordando).
  **Parcial, não fechado:** a extração por ML exige o serviço, que não roda aqui
  nem na CI. **Dado antigo:** o botão "Tabelas" depende do `tableCount` gravado
  no processamento — documento anterior à correção só mostra a tabela nova
  depois de reprocessar.
- **Último trabalho anterior:** o **F-23 fechou** — PR
  [#203](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/203).
  O código que decide se um `.xlsx`/`.docx`/`.pdf` entregue "está bom" eram **233
  linhas de Python dentro de uma template string** do `outputs.js`, onde nenhum
  teste alcançava. Validador sem teste é pior que validador nenhum: sem ele a
  entrega diz "não verifiquei"; com ele quebrado, diz "verificado".
  Virou `sandbox/validar_artefato.py`; o backend o **lê** e anexa uma linha de
  driver antes de mandar para o `run_python` — quem executa continua sendo o
  sandbox. A extração foi feita **por script**, porque os 10 escapes de regex do
  template literal (`\\w` → `\w`) eram onde a transcrição manual erraria.
  **38 casos com arquivos reais.** Os que importam são os dos gráficos, defeitos
  que o Excel não denuncia porque o arquivo ABRE e só o gráfico fica em branco:
  aba inexistente, intervalo invertido (`C2:B2`) e série de valores vazia, cada
  um injetado reescrevendo o `chart1.xml` dentro do zip. Vai junto a contraprova
  que evita o falso positivo que inutilizaria a checagem — categoria de TEXTO
  não pode ser acusada de série vazia, senão todo gráfico normal reprovaria.
  **A pegadinha:** o `Dockerfile` copia só `backend/`, então ler da raiz
  quebraria em produção **em silêncio** (o `validateOutputs` engole exceção e
  devolve `{}`). Daí o `COPY` e a catraca de 9 casos — conferida quebrando de
  propósito: renomear o módulo reprova 6 dos 9.
  **Limitação assumida:** o recálculo de fórmulas depende do `soffice` e segue
  fora do CI. O teste prova o caminho **sem** LibreOffice — a validação se
  declara parcial em vez de falhar —, que é o da maioria das instalações.
- **Último trabalho anterior:** motor durável e hierarquia do **Modo Desenvolvedor**
  (PR [#200](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/200), mesclado).
  O pipeline agora é admitido pelo banco antes do stream, retoma o contrato
  original e não aceita segundo run após restart. A interface tem ação primária
  contextual, modo foco persistente e Nino Ativo/Silencioso/Desligado.
- **Último trabalho anterior:** o **CSS ganhou teto de TAMANHO** (215 KB; 204 hoje), fechando a
  última lacuna da Frente 11. A catraca do `cssInventory.mjs`, que já existia, trava a
  CONTAGEM de regras mortas e não olha bytes — uma folha nova de 40 KB, toda em uso,
  passava por ela. Agora para no `bundleBudget.mjs`, junto dos tetos de entrada e total.
- **Último trabalho anterior:** a **série temporal da confiabilidade** (Fase 66) —
  PR [#198](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/198),
  **mesclado**. A foto
  da janela respondia "como está"; faltava "melhorou ou piorou". Sem série, uma
  queda de 90% para 60% aparece como **75%** e ninguém percebe que algo quebrou
  na semana passada.
  `bucketRuns` divide a janela em baldes (dia até 14 dias, semana acima) e
  `trendFromRuns` compara a metade anterior com a recente. **Duas travas,
  porque tendência é onde é mais fácil mentir com número verdadeiro:**
  (1) só se pronuncia com amostra nas DUAS metades — 20 execuções contra 2 é
  acaso, e o resultado sai como `sem_amostra` **com o motivo**, nunca como
  "estável", que seria lido como "tudo igual"; (2) diferença abaixo de 10
  pontos é "estável" — sem piso, 78% → 81% viraria "melhorou".
  Balde vazio aparece com zero em vez de sumir (descartá-lo juntaria dois
  períodos separados como se fossem vizinhos). Piora vira sinal (alto a partir
  de 25 pontos) e **melhora também é dita** — painel que só reclama é painel
  que ninguém abre duas vezes. No painel, a **frase é a resposta**; o
  minigráfico é apoio (`aria-hidden`, com `title` por barra).
  **Limitação assumida:** os limiares (5 execuções por metade, 10 pontos para
  sair de "estável", 25 para sinal alto) são fixos e **não foram calibrados
  com uso real**. A escolha é deliberada pelo falso negativo: um piso de 10
  pontos pode esconder degradação lenta, mas um painel que grita a cada
  oscilação deixa de ser lido — e aí não detecta nada. **Sem prova visual**
  (sem Chromium nesta sessão): por isso a frase carrega a informação e o
  minigráfico é apoio.
- **Último trabalho anterior:** o **veredito da `validar_pagina` alimenta o review gate**
  (Fase 38 → Fase 28) — PR
  [#197](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/197), **mesclado**.
  Eram duas evidências que não se falavam: o gate media o
  DIFF, a validação media a PÁGINA RENDERIZADA, e uma página podia reprovar no
  navegador — tela em branco, erro de console — com a entrega se apresentando
  limpa, porque o diff não tem como saber o que a página fez ao renderizar.
  O loop guarda os vereditos da execução e o `pageCheckFindings` os converte
  em achados. **A diferença de peso entre os três sinais é a decisão:**
  página **reprovada** é `high` (defeito medido, no mesmo nível de "código
  alterado sem teste"); página HTML alterada e **nunca validada** é `medium`
  (ausência de evidência, o irmão do `missing_test`); validação que **não pôde
  rodar** é `low` e existe para uma coisa só — impedir que a entrega diga
  "validado" quando nada foi validado. Tentativa que só deu erro (caminho
  errado, página inexistente) **não conta como validação**: o "faltou validar"
  continua de pé.
  Como `high` entra no texto da resposta pelo caminho que já existia, uma
  página reprovada agora aparece para o usuário sem ele precisar abrir painel.
  **Limitação:** o sinal de "faltou validar" enxerga só HTML dentro do
  repositório git da tarefa — artefato solto em `outputs/` não entra no
  ChangeSet e não é cobrado.
- **Último trabalho anterior:** a **Frente 26 — Telemetria local de confiabilidade**
  (Fase 66) — PR
  [#196](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/196), **mesclado**.
  O painel da Frente 14 mede CONSUMO. Uma execução podia consumir
  tokens exemplarmente e terminar em `fatal_error` — no painel de consumo ela
  some no meio da média. Esta frente responde a outra pergunta: **o trabalho
  deu certo?**
  `agent/reliability.js` + `GET /api/reliability` + um bloco recolhido na aba
  "Atividade": distribuição de desfechos, taxa de falha por ferramenta,
  duração (mediana/p90) e sinais medidos.
  **LOCAL é literal: nada sai da instalação e NADA NOVO é coletado.** Tudo
  deriva de `agent_runs`/`agent_run_events` (migration 032), que a Fase 17 já
  grava para reconstruir o terminal após reload. Por isso **não há migration**
  — é leitura e agregação, não instrumentação nova.
  **Quatro decisões definem os números:** (1) `awaiting_user` e `paused` não
  são falha nem sucesso — a execução parou porque era assim que deveria parar,
  e eles ficam FORA do denominador; (2) falha de ferramenta usa o MESMO
  `toolResultLooksFailed` que pinta a etapa de vermelho no terminal, senão
  painel e tela discordariam sobre o mesmo fato; (3) sinal só aparece com
  amostra mínima de 5 — "100% de falha" em uma execução é ruído travestido de
  alarme, e cada sinal cita os números que o produziram; (4) o corte de
  amostra é DECLARADO (`amostra.truncado`), porque painel que corta em
  silêncio conta uma história falsa com números verdadeiros.
  **Escopo é do próprio usuário**, com filtro opcional por projeto: um
  agregado global misturaria conversas de pessoas diferentes num número que
  ninguém pode acionar. A rota entrou no portão de autenticação do CI.
  **Limitação assumida:** sem prova visual (sem Chromium aqui) e sem teste
  contra PostgreSQL nesta sessão — a agregação é pura justamente por isso, e
  carrega 16 testes; a apresentação, 6.
- **Último trabalho anterior:** a **Frente 25 — Validação por navegador dentro do
  produto** (Fase 38) — entrou junto com a Frente 24 no PR
  [#195](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/195), **mesclado**.
  O agente construía uma interface e declarava "pronto".
  Nada media isso: o defeito clássico de frontend — um import errado — não
  aparece em teste unitário nem no diff, e a página abre **em branco** com um
  erro no console. O review gate (Fase 28) mede o DIFF; esta fase mede o
  RESULTADO RENDERIZADO.
  A ferramenta `validar_pagina` abre uma página HTML do workspace num Chromium
  de verdade e devolve o que ela FEZ: erro de JS não tratado, erro de console,
  recurso local faltando (4xx/5xx), recurso externo bloqueado, tela em branco,
  as asserções que o próprio agente declarou (`esperar_seletor`,
  `esperar_texto`) e uma captura em `outputs/`.
  **Como o navegador alcança a página, e por que não pelos caminhos óbvios:**
  o servidor que o agente sobe DENTRO do sandbox não é alcançável de fora (o
  container nasce com `NetworkDisabled` e sem publicação de portas), e `file://`
  colocaria o disco do backend ao alcance de um HTML escrito pelo modelo — o
  `page.route()` do Playwright não intercepta sub-requisição `file://` de forma
  confiável. A saída é um terceiro caminho, mais estreito: um HTTP efêmero em
  `127.0.0.1`, porta aleatória, raiz no workspace da conversa, só GET/HEAD,
  derrubado ao fim da chamada. **A guarda só deixa passar a origem fixada** —
  internet, outra porta do loopback (inclusive a API do backend) e `file:` são
  abortados. Sem canal de saída não há exfiltração, e o que a página tentou
  aparece no resultado.
  **Três decisões:** (1) recurso EXTERNO bloqueado é **aviso**, não falha — a
  página pode funcionar em produção com a CDN no ar, e chamar isso de falha
  ensinaria o agente a ignorar o veredito; recurso LOCAL faltando é problema;
  (2) "tela em branco" exige as DUAS condições (sem texto visível **e** sem
  elemento visual), senão uma página só de imagem seria reprovada; (3) sem
  Chromium no ambiente a ferramenta devolve `disponivel: false` com o motivo —
  **nunca um "validado" falso**.
  **O segundo modo fechou a limitação que eu tinha declarado.** A primeira
  versão validava só arquivo do workspace, porque o backend não alcança o
  `npm run dev` da tarefa (container com `NetworkDisabled`, sem publicação de
  portas). A saída não foi abrir essa fronteira — foi **inverter o movimento:
  o navegador vai até o servidor**. A imagem do sandbox já traz `chromium` e
  `playwright`, e container sem rede continua tendo loopback: um script
  Playwright rodando lá dentro alcança `http://127.0.0.1:<porta>`. O backend
  escreve o script no workspace, roda com `execInSandbox`
  (`NODE_PATH="$(npm root -g)"` — o pacote é global e só o `require` honra a
  variável), lê uma linha marcada por sentinela e monta o veredito com o MESMO
  `buildVerdict`. **Nenhuma fronteira mudou**: sem publicação de porta, sem
  rede nova, F-04 intacto — e a página validada roda no isolamento em que o
  código dela já rodava.
  Antes de gastar um navegador num timeout, o `sandboxServices` confere o que
  está escutando: porta errada devolve **qual é a certa**, não "não carregou".
  **Limitação que continua:** a validação mede erro, ausência e presença — não
  faz asserção de layout nem comparação visual entre versões.
- **Último trabalho anterior:** a **Frente 24 — Handoff local ↔ worktree** (Fase 24)
  — PR [#195](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/195),
  **mesclado**.
  O trabalho da tarefa mora no clone da conversa, na branch derivada da
  Fase 23 — e até aqui só saía dali por `github_push` + Pull Request. Quem
  quisesse **continuar no próprio computador** (rodar o app, abrir a IDE) ou
  **devolver** uma correção feita localmente não tinha caminho: o trabalho não
  commitado nunca chegava à máquina do usuário.
  Agora há ponte nos dois sentidos, na mesma camada do ChangeSet (git local no
  clone, sem token e sem sandbox): `agent/handoff.js` +
  `GET /conversations/:id/handoff`, `GET .../handoff/patch` e
  `POST .../handoff/apply`, com o painel na aba "Alterações".
  **Três decisões que definem o comportamento:**
  1. **A worktree é o caminho bom; o patch é o universal.** Com a branch
     publicada, o painel entrega os comandos prontos
     (`git worktree add --track -b <branch> ../<dir> origin/<branch>`) — o
     checkout atual do usuário não é tocado. Sem branch publicada, o patch é a
     única ponte honesta, e ele **leva os arquivos novos**: o `git add -A` roda
     contra um `GIT_INDEX_FILE` temporário, então o índice do clone não é
     tocado e o arquivo não rastreado (o que a IA mais produz) entra no diff.
  2. **A base do patch não é sempre `HEAD`.** Com commit local ainda não
     publicado, a base vira `origin/<branch>` — senão a worktree traria só o
     publicado, o patch traria só o não commitado, e o commit do meio sumiria
     dos dois caminhos. É o caso que o teste com remoto de verdade guarda.
  3. **Aplicar patch não faz merge de três vias.** `git apply --check` antes: o
     patch entra inteiro ou não entra. Um `--3way` deixaria marcador de
     conflito dentro dos arquivos da tarefa — o oposto do que este projeto faz
     em toda operação destrutiva. Caminho de destino é **recusado nomeando o
     caminho** (absoluto, `C:\`, `..`), nunca normalizado; a rota recusa com a
     tarefa em execução (409); e o clone é devolvido ao uid do sandbox
     (`chownTree`), senão o agente não conseguiria editar o que acabou de
     receber.
  Duas mudanças mínimas no `runGit` sustentam isso: `env` (para o
  `GIT_INDEX_FILE`) e `maxOutput` — o teto padrão de 8 KB truncaria o patch, e
  **patch truncado é pior que nenhum**, porque parece válido.
  **Limitações assumidas:** (a) sem branch publicada, os commits locais só saem
  pelo GitHub — o patch cobre a partir de `HEAD`, não da base da branch;
  (b) **sem prova visual** — o sandbox desta sessão não tem Chromium, então o
  painel novo não foi conferido em tela (a lógica pura tem 6 testes e o backend
  exercita git de verdade, inclusive com um remoto local).
- **Último trabalho anterior:** a **Frente 23 — Layout do Developer Workspace**
  (Fases 51, 52 e 55). A grade de três colunas + terminal + compositor **já
  existia**; o que faltava era o que ela anuncia e quanto mostra por padrão.
  - **Contexto da sessão (Fase 55):** uma faixa abaixo da barra do workspace com
    projeto · branch · ambiente · modelo · permissões. A branch exibida é a de
    TRABALHO, vinda do pré-voo real do backend (a mesma fonte que decide o
    inventário do agente) — com a nota "a partir de main" quando é derivada.
    Item sem dado real não aparece; só "Permissões" é sempre exibido, porque
    "somente leitura" é informação, não vazio.
  - **Simplicidade progressiva (Fase 52):** o workspace começa em Chat + Tarefa
    + Terminal e abre Arquivos/Alterações/Memória no botão "Mostrar tudo". A
    escolha explícita do usuário sobre uma coluna **vence** o padrão do nível
    (o estado agora distingue "recolhida" de "ainda não decidiu").
  - As colunas do modo dev viraram chunks lazy: a entrada do bundle caiu de
    920 KB (exatamente no teto) para **890 KB**.
  **Limitação assumida e declarada:** esta frente NÃO tem prova visual. O
  sandbox desta sessão não tem Chromium nem Postgres, então os E2E de layout
  (`e2e/tests/layout.spec.js`, que existem e cobrem sobreposição em oito
  larguras) não rodaram aqui — só na CI do PR. Por isso a mudança foi
  deliberadamente incremental: a lógica nova é pura e testada (9 testes), e o
  CSS acrescenta uma faixa própria em vez de mexer no grid que já sustenta
  compositor, terminal e mascote. Recomendo conferir em tela antes de mesclar.
- **Último trabalho anterior:** a **Frente 22 — Diff por arquivo e reversão por hunk**
  fecha a Fase 27. A aba "Alterações" já dizia a verdade (Frente 18); agora dá
  para VER o diff do arquivo e DESFAZER — o arquivo inteiro ou um trecho — sem
  sair do painel.
  A reversão por hunk usa `git apply --reverse` com um patch reconstruído do
  diff ATUAL, nunca edição de texto na mão: se o arquivo mudou desde a leitura,
  o git recusa o patch e nada acontece (o pior caso é "recarregue e tente de
  novo", não um patch aplicado no lugar errado). O teste que guarda isso é o
  central da suíte: reverter um trecho desfaz só ele e **preserva a outra
  edição** do mesmo arquivo.
  Contenção: repositório e caminho confinados ao clone da conversa — caminho
  absoluto e `..` são **recusados**, não normalizados (reinterpretar
  `/etc/passwd` como `<repo>/etc/passwd` ficaria contido, mas esconderia do
  usuário o que ele pediu). A rota recusa reverter com a tarefa em execução,
  para não brigar com o que a IA está escrevendo.
- **Último trabalho anterior:** a **Frente 21 — Review gate e painel de confiança**
  (Fases 28 e 44) fecha o ciclo VERIFY→REVIEW→DELIVER com evidência medida, não
  declarada. Antes de a tarefa se apresentar como entregue, o backend passa um
  pente automático no que foi REALMENTE alterado (o ChangeSet da Frente 18 +
  `git diff HEAD -U0`): segredo em linha adicionada (blocker), teste desligado
  com `.only`/`.skip` (high), código alterado sem teste tocado (high), remoção
  de caminho sensível (CI, compose, migrations), código de depuração, TODO novo
  e arquivos que nenhum passo do plano menciona.
  **Três decisões que definem o comportamento:** (1) os achados vêm do diff, não
  de autoavaliação do modelo — ele os recebe como fato e precisa tratá-los;
  (2) achado NÃO bloqueia publicação por conta própria: aparece no painel, no
  prompt e — quando é blocker/high — no texto da resposta, mas a autorização
  continua sendo do usuário; (3) falso positivo é barato (o achado cita arquivo
  e linha), falso negativo é caro — na dúvida o sinal aparece.
  Falha do gate nunca derruba a entrega. O resultado viaja no evento
  `verification`, no `execution_meta` e no event log durável, então sobrevive ao
  reload como o plano.
- **Prompt v4.2 unificado (última frente).** O `messages[0]` deixou de ser uma
  colagem de cinco constantes escritas em épocas diferentes e virou UM texto
  (`backend/src/agent/systemPromptV4.js`), com uma seção por assunto e a
  hierarquia de conflito declarada no fim. A seção de kits saiu do perfil do
  assistente de documentos e virou da BASE — entra só quando `run_python` está na
  chamada, então TODO assistente com execução passa a conhecer a API dos kits (e
  quem não executa economiza ~10,8 mil caracteres por turno). O bloco final leva a
  data de hoje, o modelo e o estado da rede; a hora fica fora de propósito, porque
  invalidaria o cache de prompt a cada turno. Ver `docs/ARCHITECTURE.md` §12.1.
  As duas versões anteriores do prompt de documentos foram arquivadas como
  `vN.txt` (o arquivamento tinha sido esquecido duas vezes), então instalações
  já semeadas migram sozinhas em vez de carregar a seção duas vezes.
  **Risco aberto: falta RODAR a validação de comportamento.** Texto não tem
  teste unitário que prove que o modelo responde melhor. A bateria agora existe
  — `cd backend && npm run validar:prompt -- --live --md /tmp/prompt.md`, sete
  casos que montam o `messages[0]`/`messages[1]` reais e medem a decisão
  observável (chamou a ferramenta? parou na pergunta? usou a data de hoje?
  acompanhou o idioma?) —, mas ela precisa de `VALIDACAO_API_KEY` e
  `VALIDACAO_MODELO`, que não existem neste contêiner. **Rode em dois modelos,
  um forte e um gratuito, antes de mesclar**; o veredito é triagem, então leia o
  `--md` (ele traz a resposta inteira de cada caso). Sem `--live` a bateria roda
  seca e não julga nada. O A/B contra a v4.1 continua fora do automático: as
  constantes antigas foram removidas, e comparar exige rodar a bateria também no
  commit anterior.
- **Kits de documento v2 (frente anterior).** A revisão de design de ago/2026
  gerou quatro documentos com os kits v1, olhou página a página e reprovou:
  sumário do Word apontando a página errada, tabela quebrada com o TOTAL órfão,
  assinatura sozinha numa página, KPI partido em duas linhas, planilha vazando
  para uma segunda folha impressa e — o pior — o `.docx` pedindo uma fonte que
  o cliente não tem, de modo que o PDF conferido não era o documento aberto.
  A v2 nasceu de `sandbox/kits.py`, a base comum dos três kits (paleta, escala,
  formatação pt-BR e auditoria), e mudou o contrato: o modelo escolhe o
  **preset** e passa **números**; o `salvar()` dos três **audita o arquivo
  pronto** e levanta `KitError` no achado grave. Detalhes em
  `docs/ARCHITECTURE.md` §19; a API que o assistente ensina está travada contra
  o código por `backend/src/promptKits.test.js`.
- **Última validação:** 2026-09-03 (prompt v4.2) — **backend `npm run check`: 1414
  testes, 0 falhas, 147 pulados** (os pulados exigem PostgreSQL; esperado fora
  do Docker), **frontend: 170/170** (CSS 206/215 KB, catraca 3 ≤ 3) e
  **sandbox: 160 testes, 0 falhas** com LibreOffice, matplotlib e as fontes
  Carlito/Caladea instalados. Os quatro documentos da revisão foram regerados
  (`python sandbox/exemplos/gerar_exemplos.py`) e **conferidos em tela**. O
  rastro de validações anteriores está em `docs/CHANGELOG_HISTORY.md`.
  **Um limite do ambiente que vale para toda sessão aqui:** o contêiner de
  desenvolvimento vem com `libreoffice-core` mas **sem o Writer/Calc**, e sem
  eles o `soffice` recusa qualquer arquivo ("source file could not be loaded").
  Instale `libreoffice-writer libreoffice-calc fonts-crosextra-carlito
  fonts-crosextra-caladea` antes de mexer nos kits — senão o PDF gêmeo não sai,
  a auditoria devolve `sem-pdf-gemeo` e os testes de sumário se pulam.
- **Frentes anteriores** (Frentes 10 a 20 do Developer Workspace 3.0, o
  redesenho do Nino, o Modo Design, os kits de documento e o restante do
  caminho até aqui): `docs/CHANGELOG_HISTORY.md`. Este arquivo guarda só o
  presente — Regra 0.1.

---

## Riscos abertos

| ID | Risco | Severidade |
| --- | --- | --- |
| F-21 | `App.jsx` ainda concentra dezenas de `useState`; CSS em camadas sem inventário. O **bundle deixou de ser um chunk só** (`React.lazy` nos painéis pesados: entrada em 913 KB contra o teto de 920 KB), mas o `MultiModelBoard` segue no principal — é importado de forma estática pelo `Landing.jsx`. **Atenção:** a folga do pacote de entrada é de apenas 7 KB. O terminal, a janela em tela cheia e o modal de pergunta já saíram para chunks próprios; o próximo PR de frontend provavelmente precisa de mais um split (candidato natural: `ExecutionSession.jsx`, que continua na entrada porque o `DevActivityRail` importa `TOOL_META` de lá de forma estática). | 🟡 Média |
| — | O **pré-voo do GitHub** é honesto sobre autorização, vínculo e modo, mas **não** verifica os escopos reais do PAT: um token sem permissão de escrita só é descoberto quando o `github_push` falha (a mensagem do conector nomeia a causa). Verificar o escopo antes exigiria uma chamada extra à API do GitHub por pré-voo. | 🟢 Baixa |

---

## Próximos passos (em ordem)

**Aberto por esta sessão (2026-08-08), em ordem de valor:**

- **Prova visual dos painéis novos.** Confiabilidade + série temporal (Fase 66)
  e o painel de handoff (Frente 24) nunca foram vistos em tela: este contêiner
  não tem Chromium. A lógica é pura e testada nos três casos, e a informação
  vive no texto — mas o layout continua sem conferência. É o primeiro item
  para uma sessão com navegador.
- **O sinal de "faltou validar" não enxerga `outputs/`.** O review gate cobra
  validação de HTML que está no repositório git da tarefa; artefato solto em
  `outputs/` não entra no ChangeSet e passa sem cobrança. Fechar isso exige
  decidir se `outputs/` vira evidência de primeira classe ou continua fora.
- **Calibrar os limiares da tendência com uso real.** 5 execuções por metade,
  10 pontos para sair de "estável", 25 para sinal alto — números escolhidos
  por prudência, não medidos. Com histórico de `agent_runs` acumulado dá para
  conferir se o piso esconde degradação lenta.

1. **Frente 16 — Preencher `model_tool_capability_cache` com a sonda.** Após
   a Frente 15, rodar `node scripts/run-tool-probe.mjs --live --out
   tools/probe-results/probe-<modelo>-<data>.json` contra cada modelo
   candidato do catálogo. Resultados alimentam a capacidade do cache antes
   da primeira delegação — sem desperdiçar 1 chamada na falha.
2. **Frente 17 — UI admin consumindo `/api/admin/usage/dashboard`.** A
   rota existe (Frente 14) mas é só via API/curl. Falta a tela simples
   com KPIs + sparkline (sem gráfico pesado).
3. **Frente 18 — Calibração do `FREE_TIER_DAILY_LIMIT` com dado real.**
   Agora temos `tokens_30d` por tier (Frente 14). O limite sai do
   percentil 95 dos usuários ativos para não cortar cauda longa.
4. **Frente 19 — Loop de tool calling em produção (depende do veredito).**
   Se Frente 15 = `native_supported`, ligar `tools` no `chat.js` e no
   copilot. Se `json_block`/`xml_block`, adicionar parser dedicado antes
   do loop. Se `text_only`/`unreliable`, prompt reforçado + fallback. Plano
   completo em `docs/TOOL_CALLING_PROBE.md` §"Quando re-rodar".
5. **Frente 13 (antiga, renumerada) — Modo Design: compartilhamento público.** O token de prévia
   já existe; falta a tela pública sobre ele. Rota pública mínima (Regra 2.2)
   servindo a prévia por token, sem sessão; revogação. Testes de autorização
   (válido/inválido/revogado); `docs/SECURITY.md`.
6. **Frente 9 — Desmontar o `App.jsx` (etapas 2-4):** a etapa 1 (shell/sidebar)
   está feita. Faltam: etapa 2 (estado da conversa), etapa 3 (estado da
   execução), etapa 4 (drawers/configurações). Plano completo em
   `docs/ARCHITECTURE.md`.
7. **Pendência conhecida — 123 regras mistas no inventário CSS:** regras
   que combinam classes mortas com classes vivas (ex.: `.morta .viva`,
   `.morta.viva`). Não foram tocadas na frente 11 porque a remoção segura
   depende de validação visual com E2E ponta a ponta, indisponível neste
   sandbox (sem Postgres + `/opt/pw-browsers/`). Ficam para frente futura
   com ambiente completo. O detector já as expõe em `dist/cssInventory.json`.
8. **Pendência da Frente 12 — refinamentos do "Imagem no artefato":**
   a frente entregou o caminho mínimo (gerar via diálogo + aplicar via
   prompt). **(d) compressão/otimização antes de gravar → entregue na
   Frente 13.** Restam para frente futura: (a) geração automática via
   detecção de "imagem"/"foto"/"ilustração" no chat do projeto; (b)
   edição inline de imagem (clicar para trocar); (c) múltiplas imagens
   por slide.

## Como retomar o desenvolvimento

```bash
# 1) Postgres igual ao da produção (e ao do CI)
docker run -d --name fred-pg -e POSTGRES_USER=studio -e POSTGRES_PASSWORD=studio \
  -e POSTGRES_DB=studio -p 5432:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgres://studio:studio@localhost:5432/studio

# 2) Backend
cd backend && npm install
npm run test:integration    # migrações do zero + suíte completa
npm run dev

# 3) Frontend
cd frontend && npm install
npm test && npm run dev

# 4) Antes de commitar
cd backend  && npm run check   # lint + testes
cd frontend && npm run check   # lint + testes + build

# 5) Mexeu em interface, streaming ou login? Rode também os E2E (exige Postgres)
cd e2e && npm install && npm run navegador   # só na primeira vez
cd e2e && E2E_DATABASE_URL=$DATABASE_URL npm test

# 6) Mexeu nos kits de documento (sandbox/kits|docpro|xlspro|pdfpro)? Instale as
#    dependências ANTES — sem elas os testes se pulam sozinhos e passam vazios.
#    O LibreOffice + as fontes Carlito/Caladea são o que gera o PDF gêmeo: sem
#    eles o sumário com páginas reais e a auditoria de paginação não são testados.
python3 -m venv .venv-kits && . .venv-kits/bin/activate
pip install python-docx openpyxl reportlab pypdf matplotlib
sudo apt-get install -y --no-install-recommends \
  libreoffice-writer libreoffice-calc fonts-crosextra-carlito fonts-crosextra-caladea
python -m unittest discover -s sandbox -p '*_test.py' -v
#    E confira com os próprios olhos os quatro documentos da revisão de design:
python sandbox/exemplos/gerar_exemplos.py /tmp/exemplos
```

**Convenções que valem a pena manter:**

- **Escopo de usuário é obrigatório.** `workspaceFor(conversationId, userId)` lança
  `WORKSPACE_SCOPE_REQUIRED` sem dono — é intencional: um chamador esquecido tem de
  falhar no teste, não gravar num caminho sem dono.
- **Testes que precisam de banco se auto-pulam** sem `DATABASE_URL`, mas o CI de
  integração **falha** se algum for pulado com o banco disponível.
- **Comentários explicam o porquê**, não o quê — em especial o problema que a linha
  resolve. É o padrão do repositório e o que torna este código legível meses depois.
- **Commits pequenos e rastreáveis**, um assunto por commit.

- **Docker só pelo guarda.** O backend não monta `/var/run/docker.sock`; quem monta é o
  `docker-guard`, que valida cada requisição. Rota nova para o daemon exige liberar em
  `docker-guard/src/policy.js` — negar por padrão é a regra.
- **Ferramenta do GitHub sai de um lugar só.** Quem decide se `github_push`/
  `github_create_pr` entram no inventário é `agent/githubAccess.js` — a MESMA função que
  responde ao painel (`GET /api/connectors/github/preflight`) e monta a nota do prompt.
  Nunca acrescente uma segunda condição no `loop.js`: foi a decisão espalhada que produzia
  "a ferramenta não está habilitada nesta sessão" com o usuário já tendo autorizado. Há
  teste de catraca (`agent/githubAccess.test.js`) cobrando que o que o prompt anuncia é
  exatamente o que o executor recebe.
- **Pergunta ao usuário não é falha.** Um turno que termina pedindo decisão vale
  `awaiting_user` / `waiting_user`, com a solicitação em `execution_meta.inputRequest` —
  nunca `execution_failed`. A ferramenta é `ask_user`, interceptada antes do `runTool`.
- **Rolagem do chat: nada de `scrollIntoView` nem de `window.scrollTo`.** As regras vivem
  em `chatScroll.js` (puras, testadas) e o hook `useSmartAutoScroll` as liga ao contêiner.
  Durante o streaming o comportamento é sempre `'auto'`: animação suave reiniciada a cada
  token foi exatamente o defeito corrigido.
- **Quem flutua no rodapé soma `--composer-h` + `--dock-h`.** O compositor e o terminal
  inferior publicam as próprias alturas (`useComposerHeight`); esquecer uma delas põe o
  elemento flutuante em cima de um controle real — já aconteceu duas vezes, com o botão de
  enviar e com os botões do terminal.

**Mapa da documentação:** `docs/ARCHITECTURE.md` (como funciona) ·
`docs/SECURITY.md` (ameaças e controles) · `docs/OPERATIONS.md` (runbook) ·
`docs/BACKUP_RESTORE.md` · `docs/TESTING.md` · `docs/AUDITORIA_2026-07.md` ·
`docs/CHANGELOG_HISTORY.md` (histórico).
