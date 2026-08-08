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
nos testes de navegador (F-13) e o SSE ganhou o caso de reconexão com cursor (F-12). O
O **pipeline multimodelo retomável (F-15) está fechado**: a reserva ocorre antes
do SSE, duplicidade falha fechada, objetivo/opções/runId sobrevivem ao restart e
retomada/stop são escopados pelo usuário. A prontidão continua amarela pelas
demais lacunas listadas em `docs/TESTING.md`, não por este coordenador.

**Frentes desta sessão e onde cada uma parou** (2026-08-08):

| Frente | PR | Estado |
| --- | --- | --- |
| Frente 24 (handoff) + Frente 25 (`validar_pagina`) | [#195](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/195) | mesclado |
| Frente 26 — telemetria local de confiabilidade (Fase 66) | [#196](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/196) | mesclado |
| Veredito da `validar_pagina` → review gate (Fase 38 → 28) | [#197](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/197) | mesclado |
| Série temporal da confiabilidade (Fase 66) | [#198](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/198) | **aberto**, CI verde |
| Motor durável e UX do Modo Desenvolvedor | a abrir nesta branch | implementação e checks locais concluídos |

CI da `main` conferida **verde** nos dois merges desta sessão que já entraram —
`58a0209` (Fase 66) e `2d416f4` (Fase 38 → 28). A branch de trabalho foi
**recomeçada a partir da `main` atualizada** a cada merge, em vez de empilhar
sobre histórico já mesclado — por isso o #198 traz só a série temporal.

- **Último trabalho:** motor durável e hierarquia do **Modo Desenvolvedor**.
  O pipeline agora é admitido pelo banco antes do stream, retoma o contrato
  original e não aceita segundo run após restart. A interface tem ação primária
  contextual, modo foco persistente e Nino Ativo/Silencioso/Desligado. Backend
  ficou sem regressão além das duas falhas basais do Windows; frontend passou
  169/169, build e budgets. Sem prova visual interativa porque nenhum navegador
  estava conectado à sessão.
- **Último trabalho anterior:** a **série temporal da confiabilidade** (Fase 66) —
  **PR [#198](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/198), aberto,
  CI verde**, aguardando revisão do usuário. A foto
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
- **Última validação:** 2026-08-08 (série temporal) — **backend `npm run
  check`: 1366 testes, 0 falhas, 144 pulados** (os pulados exigem PostgreSQL;
  esperado fora do Docker) e **frontend: 166/166** (entrada 890/920 KB, total
  1064/1100 KB, catraca de CSS 3 ≤ 3). CI da `main` verde nos merges desta
  sessão. O rastro de validações anteriores está em
  `docs/CHANGELOG_HISTORY.md`.
  **Dois limites do ambiente que valem para toda sessão aqui:** o job
  **"Artefatos (Excel real)"** do CI roda os testes dos kits num runner **sem
  as mesmas fontes** do sandbox — então o caminho de degradação do `pdfpro`
  (sem TrueType, caindo para as Type1 base-14) é exercitado a cada push, e lá
  só o teste de gráfico do Word pula, por falta do matplotlib. E **o
  LibreOffice deste contêiner não converte nada** (falha até com um `.txt` de
  uma linha), então conferência de `.docx` aqui é estrutural — OOXML sobre o
  arquivo reaberto.
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

# 6) Mexeu nos kits de documento (sandbox/docpro|xlspro|pdfpro)? Instale as
#    dependências ANTES — sem elas os 59 testes se pulam sozinhos e passam vazios
python3 -m venv .venv-kits && . .venv-kits/bin/activate
pip install python-docx openpyxl reportlab matplotlib
python -m unittest discover -s sandbox -p '*_test.py' -v
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
