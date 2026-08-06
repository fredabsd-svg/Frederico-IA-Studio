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
que ainda segura o verde é o **pipeline multimodelo retomável**: o F-15 entregou a
tabela e as primitivas, mas o `runMultiModel` ainda não as usa, então o reinício continua
sem retomar a etapa pendente. Critérios e caminho em `docs/AUDITORIA_2026-07.md` §6.

- **Último trabalho:** o **portão de bundle passou a medir a coisa certa**. Ele somava
  todo o JS contra um teto único de 1.000 KB — e a `main` estava exatamente em 1.000,
  com 100% do orçamento consumido: qualquer PR de frontend reprovava. Pior, ele punia
  code splitting (cada chunk novo soma invólucro), reprovando o PR da Frente 10 que
  BAIXOU a primeira pintura de 909 para 896 KB. Agora são dois tetos — entrada
  (920 KB) e total (1.100 KB) — e a regra roda no `npm run check`, não só no CI.
- **Último trabalho:** a **Frente 8 — Retomada real pós-kill-9** fecha o F-14
  de verdade: teste de integração com `child_process` onde o processo A grava
  checkpoint com tool calls e encerra (simulando SIGKILL), e o processo B
  carrega e reconstrói via `buildResumeMessages` sem duplicar ferramentas.
  Pula com a mensagem padrão sem PostgreSQL; com banco, exerce o caminho real.
  Antes dela, a **Frente 4 — Vulnerabilidades de dependências** zerou
  as 4 vulnerabilidades do `npm audit`: no backend, o override `uuid: ^11.1.1`
  corrigiu o dockerode (moderate) e o `npm audit fix` atualizou `ip-address`
  (high); no frontend, o override `postcss: ^8.5.23` corrigiu a vulnerabilidade
  de path traversal. Suítes verdes nos dois lados.
  Antes dela, a **Frente 3 — Integração do coordenador durável no
  `runMultiModel`** fechou o risco F-15: o pipeline multimodelo agora persiste
  o `currentStage` e o `state_json` entre etapas na tabela `pipeline_runs`
  (migration 027), retoma do estágio correto pelo `/resume`, completa runs como
  `done`/`stopped`/`error` sem deixar órfãos, e tem sweeper ligado no boot.
  Testes de integração (5 novos) provam a retomada
  com pool novo e a ausência de órfãos em cancelamento/falha. **A retomada é
  explícita:** só o `/resume` retoma um run pendente. Mensagem NOVA numa
  conversa com run órfão (deixado em `running` por um crash) fecha o órfão
  como `error` e parte do zero — o sweeper só varre runs terminais, então
  herdar o órfão o faria sequestrar a resposta seguinte, costurando-a sobre
  as etapas da tarefa antiga.
  Antes dela, a **Frente 2 — Template de PR + ADR 0001** (#171) criou o
  `.github/pull_request_template.md` e o `docs/decisions/0001-adocao-das-regras-do-projeto.md`.
  Antes dela, as **regras do projeto entraram no repositório**: o
  `REGRAS-DO-PROJETO.md` passou a ser a constituição de engenharia — vale para pessoas,
  agentes de IA e automações — e o `CLAUDE.md` ficou explicitamente subordinado a ele
  (onde divergirem, as regras prevalecem). Antes dele, a
  **integração das 16 frentes abertas** numa branch só (F-05b,
  F-11 a F-26, geração de imagem por capacidade e o acionamento real dos sub-agentes).
  Entre elas, o **modelo de IA por projeto no Modo Design** (frente abaixo):
  o seletor saiu de trás do painel e passou a morar na barra do editor, e a escolha
  virou coluna do projeto em vez de estado do app; e a **geração de imagem escolhendo a
  chave por capacidade** (frente abaixo) — o "Nenhuma chave de API configurada" aparecia
  com o chat respondendo na mesma tela. Antes deles, a
  **identidade "Tinta & Latão"** nos três kits (frente abaixo):
  o redesenho visual entrou POR CIMA da grade do PR #149, com os blocos que faltavam —
  sumário, citação, linha do tempo, gráficos, assinaturas, contracapa, `confidencial=` e
  a aba-painel do Excel. Antes dele, o
  **PR [#149](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/149)** —
  a **arquitetura de formatação dos documentos** (frente abaixo): os kits Word/Excel/PDF
  passaram a ter uma grade única, o `pdfpro` audita o arquivo que gera e o prompt proíbe
  diagramar fora do kit. Antes dele, o **copiloto (Nino)** deixou de ser um chat cego —
  passou a levar o contexto do chat principal **por padrão** (auditado, e dispensável por
  mensagem), ganhou memória própria, preferências com efeito real, base de conhecimento do
  Studio e ações dentro do app. Antes dele, o **Modo Design**, v1 e v2 — espaço próprio
  onde o usuário descreve um site, uma apresentação ou um documento visual e recebe um
  rascunho renderizado ao vivo, refinado **por conversa, por clique no elemento ou por
  sliders que não chamam a IA**, versionado e exportável (.html/.pdf/.pptx). Antes dele, a
  estabilização do **ambiente de execução do agente**:
  um timeout deixou de derrubar o sandbox, toda execução devolve estado estruturado
  (ambiente × projeto), o reinício é anunciado com o que sobreviveu e o que se perdeu,
  comandos longos transmitem a saída ao vivo, e o agente ganhou a ferramenta `ambiente`.
  Antes deles, os **PR [#147](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/147)**
  (o Nino cobrindo o botão de enviar), **[#146](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/146)**
  (Playwright + suíte ponta a ponta) e **[#145](https://github.com/fredabsd-svg/Frederico-IA-Studio/pull/145)**
  (as sete falhas P0 dos sub-agentes).
- **Última validação:** 2026-08-05 — **1219 testes**, com o backend em **1008/1008 e
  NADA pulado**: o PostgreSQL 16 subiu **neste contêiner** (binários locais, sem Docker
  e sem a extensão `vector` — nenhuma migration usa o tipo). Mais **frontend 77/77**
  (lint + testes + build), **guarda do Docker 49/49** e os **26 ponta a ponta em
  navegador real** (`E2E_CHROMIUM_PATH` apontando o Chromium do contêiner): 26/26. Os
  **59 do sandbox Python** pulam aqui por falta da imagem do sandbox — quem os roda é o
  CI. A contagem vem de `cd backend && npm run test:count` — não a escreva à mão.
  Sem banco, o backend passa 916 e pula 92 — o esperado.
  Repare em um job do CI: **"Artefatos (Excel real)"** roda os testes dos kits no runner
  do GitHub, que **não tem as mesmas fontes** do sandbox. Ou seja, o caminho de
  degradação do `pdfpro` (sem TrueType, caindo para as Type1 base-14) é exercitado a
  cada push, não só na simulação local. Lá só o teste de gráfico do Word pula, por falta
  do matplotlib.
  **O LibreOffice deste contêiner não converte nada** (falha até com um `.txt` de uma
  linha), então a conferência do `.docx` foi estrutural — OOXML sobre o arquivo reaberto.

---

## O portão de bundle media a coisa errada (2026-08-06)

Dois PRs de code splitting (Frentes 9 e 10) chegaram com a CI vermelha, ambos
no mesmo job. Investigando, o defeito não estava neles.

O portão somava **todo** o JS de `dist/assets` contra um teto único de 1.000 KB.
Duas coisas estavam erradas nisso:

1. **A `main` já marcava 1.000 KB** — 100% do orçamento consumido. Não era um
   teto com folga: era uma parede. Qualquer PR que acrescentasse um byte de
   frontend reprovava, o que bloqueava as Frentes 9, 10 e 11 inteiras.
2. **A soma punia exatamente o trabalho que a catraca dizia esperar.** O
   comentário do job dizia que o teto existia "enquanto o code splitting do
   `App.jsx` não é feito" — mas cada `React.lazy` novo tira bytes da primeira
   pintura e ACRESCENTA alguns KB ao total, porque cada chunk carrega seu
   invólucro. O PR da Frente 10 é o caso exemplar: baixou a primeira pintura de
   909 para 896 KB (melhora real para o usuário) e foi reprovado.

Parte do "crescimento" nem era real: o `du -sk` arredonda por bloco, então um
build com 11 arquivos parecia maior que um com 9 mesmo com menos bytes.

**Agora são duas perguntas, dois números:** a **entrada** (script inicial mais o
que o HTML manda pré-carregar) é o que o usuário espera antes da primeira
pintura, e é o número que o splitting deve baixar; o **total emitido** não
encolhe com splitting e serve de alarme para dependência nova entrando de
carona. Por isso o teto do total é folgado — ele não é meta, é alarme.

**A regra saiu do YAML e virou `frontend/scripts/bundleBudget.mjs`, ligada ao
`npm run check`.** Era a causa de os dois PRs terem sido enviados vermelhos de
boa-fé: eles rodaram `npm run check`, que passou, porque o portão só existia no
CI. Portão que só existe no CI é descoberto tarde demais.

Conferido nos dois sentidos: com teto artificialmente baixo o script sai com
código 1 e a mensagem certa; restaurado, sai 0. Sem `dist`, avisa para rodar o
build em vez de estourar.

---

## As regras do projeto viraram documento do repositório (2026-08-05)

Até aqui a governança de engenharia morava só no `CLAUDE.md` — um checklist
curto, escrito para uma ferramenta específica. Quem abrisse o repositório por
fora dela (uma pessoa, outro agente, uma automação) não tinha onde ler as
fronteiras que o projeto já respeitava na prática.

O `REGRAS-DO-PROJETO.md` fecha essa lacuna com treze regras: documentação como
parte do produto, fronteiras de arquitetura, banco e migrations, contratos e
SSE, agentes e menor privilégio, segurança e segredos, sandbox e kits de
documento, frontend e acessibilidade, testes e portões, Git e PRs, ADRs,
operação e um caminho de adoção sem criar dívida nova.

**A precedência é explícita:** as regras prevalecem sobre o `CLAUDE.md`, que
continua sendo o checklist do dia a dia. O ponteiro entrou no topo do
`CLAUDE.md` — o arquivo que toda sessão de IA carrega automaticamente — e no
índice do README, para o caminho humano.

O que as regras codificam já era prática aqui: não anunciar o que não existe,
não pular teste com banco disponível, não devolver o socket do Docker, isolar
por usuário, não declarar sucesso falso. O ganho não é mudança de
comportamento, é passar a ser **verificável por quem chega depois**.

**O que ficou de fora, e está resolvido:** o template de Pull Request
(`.github/pull_request_template.md`) e o ADR 0001
(`docs/decisions/0001-adocao-das-regras-do-projeto.md`) foram criados na
Frente 2 (2026-08-05). O patch de aplicação nunca existiu — a aplicação foi
feita por branch e Pull Request, sem arquivo de patch intermediário.

---

## A integração das 16 frentes, e o que só o navegador acusou (2026-08-05)

Dezesseis PRs abertos, em quatro pilhas: F-13→F-21 (dez commits), F-23→F-16
(quatro), a geração de imagem por capacidade e o acionamento dos sub-agentes.
Juntá-los foi menos sobre resolver conflito de texto e mais sobre descobrir que
**três defeitos só aparecem quando as peças estão no mesmo lugar** — nenhum dos
três falhava na branch de origem, porque a prova exigia rodar o app inteiro.

**1. Os oito `React.lazy` do F-21 apontavam para módulos sem `export default`.**
Nenhum componente deste projeto tem default — são todos exports nomeados. O
`lazy()` resolvia `default` como `undefined` e o React derrubava a árvore no
error boundary: qualquer conversa com resposta virava "Algo deu errado por
aqui". O build não pega (o bundler resolve exportações, não o formato que o
`lazy` espera), os testes de módulo não pegam (nenhum importa o componente), e
o `LazyConsentGate` — o único escrito certo, com `.then(m => ({ default: … }))`
— estava ali do lado como modelo. Corrigidos os oito e criado o guarda que
faltava: `frontend/scripts/lazyDefaultExport.mjs`, no `npm run lint`, irmão do
`reexportBindings.mjs` e pela mesma razão registrada lá.

**2. O F-25 referenciava `call` fora do escopo dele.** O registro do produtor de
arquivos (`subagentProducers.set(call.id, …)`) ficou solto no corpo do passo,
onde `call` não existe — só dentro dos laços sobre `stepToolCalls`. Resultado:
`ReferenceError` em **qualquer** execução com ferramenta, não só nas com
delegação. O registro passou para dentro de `startDelegation`, por onde os dois
caminhos (lote paralelo e sequencial) já passam e onde `call` é parâmetro.

**3. O `STREAM_STALL_TIMEOUT_MS=2000` do E2E nunca valeu.** O `streamGuard`
aplica `Math.max(30000, …)` — com teste unitário guardando o piso. O teste do
watchdog do F-13 esperava um ciclo de ~5s quando o real é ~60s (dois stalls de
30s), e morria no timeout. O config agora diz 30000 e explica o piso; o teste
carrega fôlego próprio.

Além desses, dois ajustes nos testes que chegaram junto: o do F-12 chamava
`request.get()` numa rota **SSE** — que responde 200 e deixa a conexão aberta,
então o `request.get()` esperava para sempre por um corpo que não fecha (agora o
status é lido do navegador e a conexão é abortada); e o do F-14 gravava
checkpoint para uma conversa que nunca existiu, violando a chave estrangeira —
o primeiro caso falhava e o **segundo passava pelo motivo errado**, provando
isolamento sobre um banco vazio.

**Conflitos de código, e por que cada um existia:** o F-21 passou os painéis
para `lazy` a partir de uma base anterior ao seletor de modelo do Modo Design e
perdeu a prop `allModels` no caminho; o F-24 trocou a definição estática da
ferramenta de delegação por uma fábrica com o inventário real de especialistas
(`especialista_id` como `enum`) enquanto o #141 reescrevia a **descrição** da
mesma ferramenta para ganhar um gatilho positivo ("3+ entregas independentes →
uma chamada por entrega") — mudanças ortogonais, ficaram as duas; e o
`getUserProvider` saiu do `tools.js` porque o `resolveImageProvider` tomou o
lugar dele na geração de imagem.

**Nada foi descartado:** as 16 frentes entraram inteiras.

---

## Os sub-agentes existiam e nunca eram acionados (2026-07-26)

Um pedido de seis entregas ("Fase 7": API, nginx, dashboard, watchdog, relatórios,
testes) virou uma execução única de 49 etapas, sem uma delegação sequer — com a
ferramenta disponível o tempo todo. **Não era bug de integração: era omissão de
política.** Os guard-rails do PR #136 só sabiam dizer NÃO (profundidade, orçamento,
modo gratuito, turno social); nada dizia QUANDO delegar.

Três causas, três correções:

| Causa | Correção |
| --- | --- |
| O `PLAN_BEFORE` — onde o modelo decide **como** atacar a tarefa — não menciona divisão de trabalho | `PLAN_DELEGATION_TOPIC`: sexto tópico do plano ("o que delegar e o que fazer aqui"), acrescentado pelo `loop.js` só nos modos que escrevem **e** com a ferramenta na mesa |
| A descrição da ferramenta era dissuasiva ("delegar custa tempo e tokens"), sem gatilho positivo | Gatilho explícito: **3+ entregas independentes → uma chamada por entrega**. Em `subagentToolDefinition` e no inventário (`toolAvailabilityNote`) |
| Nada reagia ao tamanho da execução — aos 40 passos o modelo não recebia sinal novo, e o contexto acumulado é justamente o custo que o sub-agente evita | `SUBAGENT_NUDGE_NOTE`: uma nota de sistema, **uma vez por execução**, ao passar de `SUBAGENT_NUDGE_STEPS` (padrão 15) sem ter delegado nada |

O lembrete tem **saída explícita** ("se o que resta depende deste contexto ou é a
integração final, siga direto e ignore"): sem ela o modelo obedeceria à nota e passaria
a delegar quando terminar ali era o certo — o oposto do problema. Pelo mesmo motivo o
tópico do plano aceita "sem delegação" com o motivo em uma linha.

O tópico do plano fica **fora** de `developerContextFor` de propósito: a ferramenta pode
não estar disponível (modo gratuito, `SUBAGENTS_ENABLED=false`), e mandar planejar
delegação sem poder delegar é pior que não mencionar. Quem sabe disso é o `loop.js`.

`SUBAGENT_NUDGE_STEPS=0` desliga o lembrete sem desligar os sub-agentes. 9 testes novos.

---

---

## Modelo de IA por projeto no Modo Design (2026-07-27)

Uma lacuna de uso que só apareceu quando o usuário perguntou "como eu troco o
modelo no design?": **não dava**. O modelo vinha do estado do app (o seletor do
chat principal), e o Modo Design ocupa a tela inteira — ou seja, o seletor ficava
ATRÁS do painel. Trocar exigia fechar o modo, trocar e reabrir.

Pior que o atrito: a escolha não pertencia a nada. O app não guarda o modelo
selecionado entre recarregamentos (cai no primeiro da lista com suporte a
ferramentas), então um projeto criado com um modelo bom era refinado semanas
depois por outro qualquer — a proposta saía diferente sem ninguém ter pedido.

O que mudou:

- **Seletor na barra do editor**, reusando o `ModelPicker` do app. Também na tela
  de criação, para o projeto já nascer com o modelo certo.
- **`design_projects.model_ref`**: a escolha é do PROJETO. A precedência mora num
  lugar só de cada lado (`modelForProject` no backend, `effectiveModel` no
  frontend, com teste espelhando um no outro): o modelo do projeto manda; o do
  app é só o padrão dos projetos criados antes da coluna existir (`NULL`).
  Deixar o seletor em branco solta a fixação e devolve o projeto a esse padrão.
- Guarda-se a referência COMPLETA (`<provedor>::<modelo>`). Um id sem prefixo faz
  `getUserProvider` cair no `rows[0]` — a causa-raiz que ainda está aberta nos
  próximos passos, e que não valia a pena reproduzir numa coluna nova.

**Um defeito que o teste de navegador pegou, causado por esta própria mudança:**
`Esc` com o seletor aberto fechava o Modo Design inteiro, em vez de só a lista. A
correção precisa acontecer na fase de **captura** do evento, e a razão é sutil: o
ModelPicker escuta no `document` (bolha), que roda antes de um ouvinte de
`window`, e o React trata `keydown` como evento discreto — o estado é descarregado
na hora. Quando o ouvinte do modo rodava, o painel do seletor já tinha saído do
DOM e qualquer checagem "tem menu aberto?" via nada.

**Mudança visível para o usuário:** dá para trocar o modelo sem sair do Modo
Design, e o modelo escolhido acompanha o projeto. O rodapé do chat diz qual está
valendo e avisa quando ele ainda vem do chat (projeto antigo, sem fixação).

Onde está: migration `024_design_modelo.sql`; `modelForProject` em
`backend/src/routes/design.js`; `effectiveModel` em
`frontend/src/design/designCore.js`; seletor em `DesignEditor.jsx` e
`DesignNewProject.jsx`. Testes: 6 de rota, 2 de banco, 1 puro no frontend e 1 em
navegador real (que é o que guarda o `Esc`).
---

## Geração de imagem: a chave é escolhida por capacidade (2026-07-27)

Sintoma relatado com print: o assistente respondeu **"Nenhuma chave de API configurada
para gerar imagens"** — e o chat, na mesma tela, estava funcionando normalmente. A
mensagem mandava cadastrar o que já estava cadastrado.

**Causa.** `generate_image` resolvia a credencial com a referência de modelo **vazia**:
`runTool` tinha `sandboxOptions.model` em mãos e não repassava. Com referência vazia,
`getUserProvider` cai no `rows[0]` — o provedor **mais antigo** da conta. Daí saíam dois
defeitos:

1. numa conta com mais de uma chave, a imagem era pedida ao provedor errado (base da
   DeepSeek + modelo da OpenRouter = 404), enquanto o chat rodava na chave certa;
2. se essa linha mais antiga estivesse órfã — cifra que a `ENCRYPTION_KEY` atual não abre
   —, `providerFromRow` devolvia `none()` e a conta inteira parecia sem chave. O modo
   gratuito, única credencial que ainda restava, nem era tentado: o `if (row)` já tinha
   retornado.

**O que mudou.** `backend/src/imageProvider.js` escolhe a credencial por **capacidade**, não
por antiguidade: entre as chaves da conta vale a que tem, no catálogo importado do
provedor, um modelo com `output_modalities` incluindo `image` — preferindo a chave do
modelo ativo na conversa, para a imagem sair pela credencial que o usuário está vendo
cobrar. `IMAGE_MODEL` continua impondo um modelo, mas só num provedor que o tenha (em
outro seria um 404 disfarçado de configuração). O **modo gratuito não gera imagem** salvo
se o operador tiver posto um modelo de imagem em `FREE_TIER_MODELS` — a chave é da
plataforma e os modelos de imagem são pagos; era exatamente o que a allowlist existe para
impedir. E `getUserProvider` deixou de morrer numa linha órfã: o padrão sem provedor
pedido é a primeira chave **utilizável**, e um provedor sem chave cai para o modo gratuito
antes de desistir.

**Mudança visível para o usuário:** quem tem uma chave capaz e outra não passa a gerar
imagem sem mexer em nada. Quem não tem nenhuma lê o motivo certo — "nenhuma das suas
chaves gera imagem, você tem DeepSeek" — em vez de "nenhuma chave configurada". Erro do
provedor também parou de virar só um HTTP nu: 401/403 dizem que a chave foi recusada, 402
que faltou crédito, e o resto carrega a mensagem do provedor.

**O que ficou de fora:** um seletor de modelo de imagem na interface (a escolha automática
+ `IMAGE_MODEL` cobre os dois casos reais) e o suporte a APIs de imagem que **não** são o
`/chat/completions` com `modalities` — `/images/generations` da OpenAI, por exemplo, é
outro contrato e exigiria um segundo caminho de chamada.

---

## Identidade "Tinta & Latão" sobre a grade do #149 (2026-07-27)

O redesenho visual dos três kits chegou pronto (docpro/xlspro/pdfpro na paleta
verde-tinta `#0C3A30` + latão `#A9812F`, Source Serif 4 sobre Source Sans 3) e
colidiu de frente com o PR #149, que tinha acabado de reescrever os MESMOS três
arquivos com a grade única e a auditoria do PDF. Duas implementações do mesmo
kit, cada uma com o que a outra não tinha.

**A decisão foi unir, não escolher:** o motor do #149 fica — grade de duas
arestas (`X_CAIXA`/`X_TEXTO`), fonte TrueType embutida com saneamento de glifo,
auditoria do arquivo pronto em `salvar()`, `lista/imagem/quebra/chave_valor/
codigo` e a limpeza de caractere de controle — e a identidade entrou por cima.

**O que a identidade trouxe:**

- **paleta e tipografia** nos três kits: verde-tinta com acento em latão,
  serifada nos títulos, na capa e nos números de destaque; sem serifa no corpo,
  nas tabelas e no rodapé. `primaria` virou alias de `tinta`, então nenhum
  bloco precisou ser reescrito só para trocar de nome;
- **títulos que numeram sozinhos** ("SEÇÃO 01" em latão acima do título) — o
  modelo não escreve mais "1." no texto; `kicker=""` desliga, `kicker="ANEXO A"`
  substitui;
- **blocos novos** no Word e no PDF: `sumario`, `citacao`, `etapas` (linha do
  tempo), `grafico_barras/linhas/pizza`, `fecho`, `contracapa` e `confidencial=`
  marcando capa e rodapés; no Word, `assinaturas(nomes, cargos=, local_data=)`
  em pares e o rótulo "Tabela N — ..." com linha de fonte;
- **aba-painel no Excel** (`p.painel`): a aba-resumo com KPIs e carimbo do
  emissor vira a PRIMEIRA aba, com os gráficos ancorados nela e os dados
  ficando na aba de origem;
- **`Sobrio`** ganhou `identificacao(titulo, qualificação)` com filete duplo
  registrável e assinaturas em pares — continua 100% preto, Times 12,
  justificado de fábrica.

**O que a grade impôs ao redesenho** (e por que o resultado é melhor que os dois
sozinhos): a auditoria do `pdfpro` roda em `salvar()` e **reprova** texto fora
da caixa útil. Então os blocos novos nasceram medidos — o gráfico é um `Drawing`
de `LARGURA_TEXTO` dentro de `_caixa()`, a linha do tempo é uma tabela com o
recuo da grade na coluna do número, e a contracapa é uma mancha de tinta na
área útil, **sem sangrar até a borda do papel** (numa impressora com área não
imprimível diferente, a sangria corta torta — é a regra do #149 e ela vale).

**Três defeitos corrigidos no caminho:**

1. **Barra de gráfico que não partia do zero:** com a base automática do
   reportlab, uma série de 4,1 a 5,8 vira quatro barras quase idênticas e a
   série menor some. O gráfico passava a mentir sobre a proporção.
2. **Pizza ilegível:** rótulo escuro dentro da fatia escura, o da esquerda fora
   da caixa (a auditoria reprovaria) e valor bruto no lugar da participação.
   Virou rosca com legenda à direita, percentual em pt-BR.
3. **Tema do gráfico do Excel nunca aplicado:** `DataPoint(graphicalProperties=…)`
   levanta `TypeError` — o argumento do construtor é `spPr` — e o `except` mudo
   engolia. Corrigido, e o `except` agora **avisa** em vez de silenciar.

**Fontes:** o `sandbox/Dockerfile` instala os TTFs estáticos (licença OFL) em
`/usr/share/fonts/truetype/tinta-latao`, e o `pdfpro` os coloca à frente de
Carlito/DejaVu/Liberation na lista de preferência — o mecanismo de degradação
do #149 continua valendo. O bloco é tolerante a falha de rede: sem as fontes o
PDF cai nas famílias antigas e o docx/xlsx no fallback do Word/Excel; nada
quebra, só perde a voz. **Para entrega externa, prefira o PDF** — ele embute a
fonte; o `.docx` depende de quem abre tê-la instalada.

**Prompt:** `atual.txt` é a **v12** (`docpro@12.0.0`); a v11 foi arquivada em
`v11.txt`. Ele mantém a REGRA ZERO do #149 — o kit é a única forma de diagramar
— e passou a ensinar os blocos novos, com o aviso de que a numeração da seção é
do kit.

**Testes:** a suíte Python do sandbox foi de 42 para **59**. E um teste de
backend novo trava o **tamanho do prompt**: o `system_prompt` é validado em
12 000 caracteres e a v12 nasceu com 12 158. Isso não quebra a semeadura (ela
escreve direto no banco) — quebra na primeira vez que alguém SALVA o assistente
pela interface. Quem pegou foi a suíte ponta a ponta, com 19 testes falhando em
`criarConta`, longe da causa; agora um teste de segundos falha primeiro, e o
prompt foi reduzido a 11 659 caracteres.

**O que ficou de fora:** o gráfico do Word continua entrando como imagem em 200
dpi (python-docx não cria gráfico nativo), e o `sumario()` do Word recebe as
páginas de você — só o do PDF se acerta sozinho, porque lá o `multiBuild` faz a
segunda passagem.

---

## Formatação dos documentos: uma grade só, e o PDF se audita (2026-07-26 — PR #149)

Um relatório entregue em PDF veio com o conteúdo certo e a construção errada. Medindo o
arquivo (não olhando: medindo), o diagnóstico foi objetivo:

| Defeito | Medida no arquivo entregue |
| --- | --- |
| Arestas esquerdas de texto na mesma página | **seis** (54,7 / 56,7 / 62,7 / 67,7 / 70,7 / 72,7 pt) |
| Marcadores de lista sem glifo (`\x7f` = DEL) | **320** |
| Trechos redesenhados com a fonte Symbol | 22 |
| Tamanhos de fonte diferentes, sem escala | 10 |
| Borda direita da numeração de página | anda ao passar de 9 para 10 (507,89 → 503,45 pt) |
| Fonte embutida / `/ToUnicode` / `/Lang` | nenhum — texto não copiável e dependente do leitor |
| Título nos metadados | `Frederico IA Studio \204 Relatório…` (travessão corrompido) |

**Causa raiz.** O arquivo não saiu do kit: a paleta dele era `#5B21B6`, e a do `pdfpro` é
`#1A3C6E`. O modelo montou reportlab na mão. E fez isso por um motivo legítimo — o kit não
tinha lista, KPI, sumário, imagem nem quebra de página, então, para um relatório de
verdade, sair do kit era a única saída. O prompt pedia "use o kit"; a arquitetura obrigava
a abandoná-lo.

**O que mudou.**

1. `sandbox/pdfpro.py` reescrito como motor de layout com **duas arestas e só duas**:
   `X_CAIXA` (fundo de callout, faixa de cabeçalho, régua do rodapé) e
   `X_TEXTO = X_CAIXA + RECUO`, onde começa *todo* texto — corpo, título, primeira coluna
   da tabela, marcador de lista, rodapé, capa. A barra de destaque virou uma **coluna** da
   tabela em vez de um `LINEBEFORE`, então ela não empurra o texto nem invade a margem.
2. Fonte **TrueType embutida** (Carlito → DejaVu → Liberation, base-14 só se não houver
   nenhuma): resolve acentuação, `/ToUnicode` (texto copiável e pesquisável) e
   renderização igual em qualquer leitor.
3. Saneamento de glifo que pergunta ao **próprio reportlab** (`unicode2T1`) se a fonte
   desenha o caractere. A pergunta intuitiva mente: `"•".encode("cp1252")` funciona, e
   mesmo assim o reportlab codifica o bullet em Helvetica como `\x7f`. Era exatamente a
   origem dos 320 marcadores quebrados.
4. Os blocos que faltavam: `lista`, `kpis`, `sumario` (com numeração de página real),
   `chave_valor`, `citacao`, `codigo`, `imagem`, `divisor`, `assinaturas`, `quebra` e o
   estilo `sobrio` para documento registrável. Agora sair do kit não é mais necessário.
5. **`salvar()` audita o arquivo pronto** e falha se sobrar achado grave (texto fora da
   grade, glifo trocado, fonte sem mapa Unicode, página irregular). O modelo também tem
   `verificar_pdf(caminho)`. Rodado no PDF que originou tudo isto, o auditor acusa 203
   trechos fora da grade e 342 glifos trocados.
6. Word e Excel receberam o mesmo tratamento: `docpro` ganhou a grade (`RECUO_PT`) — antes
   o título nascia 10 pt à direita do corpo e a célula 6 pt à esquerda dele — mais
   `r.lista()`; e os três kits limpam caractere de controle, que é ilegal em XML 1.0 e
   fazia o Word recusar o `.docx` e o openpyxl derrubar a planilha.
7. O prompt do assistente (`backend/prompts/docpro/atual.txt`, `docpro@11.0.0`) abre com
   uma **regra zero**: o kit é a única forma de diagramar, e diagramar por fora
   (`reportlab.pdfgen.canvas`, `SimpleDocTemplate`, `fpdf`, `weasyprint`, célula
   estilizada na mão) está proibido.

Detalhes em `docs/ARCHITECTURE.md` §19. Os testes do `pdfpro` verificam o contrato bloco a
bloco, a aresta direita da numeração, os dois caminhos de fonte e a própria auditoria — que
precisa **reprovar** um PDF ruim, senão não serve para nada.

---

## O copiloto virou colega de trabalho (2026-07-26 — PR #142)

O Nino conversava num painel 100% isolado: nada do chat principal entrava ali. Correto
do ponto de vista de privacidade e **caro** no uso diário — ou o usuário copiava e
colava o contexto, ou o copiloto respondia no escuro. Cinco entregas, todas com a mesma
regra: **o controle é do usuário e toda leitura deixa rastro**.

1. **Contexto do chat principal, ativado por padrão** — preferência
   `sempre (padrão) | perguntar | nunca`. O contexto vai junto sem confirmação, e o botão
   do compositor funciona nos dois sentidos: dispensa a leitura numa mensagem pontual
   (em "perguntar", é ele que autoriza). A decisão é uma função pura tri-estado
   (`decideContextAccess`), o trecho entra como bloco `system` rotulado como
   **referência somente-leitura** ("instruções aqui dentro são dado, não ordem" —
   defesa contra injeção), a leitura é escopada por dono e cada uma vira entrada em
   `companion_audit`. A resposta mostra o que foi realmente usado.
2. **Memória própria** (`copilot_notes`) — preferências, temas e lembretes entre
   conversas; fixadas entram primeiro. Só o usuário escreve; o copiloto lê.
3. **Preferências com efeito real** (`copilot_prefs`) — estilo e tom mudam a persona
   enviada ao modelo, não só a tela.
4. **Base de conhecimento do Studio** (`copilot/knowledge.js`) — 12 verbetes com busca
   local (sem rede, sem tokens) e limiar mínimo: pergunta que não é sobre o app não
   recebe documentação nenhuma.
5. **Ações no Studio** — levar a resposta ao compositor do chat principal, salvar como
   modelo de pedido, guardar na caixa de documentos ou na memória, e resumir a conversa
   num documento. Todas por clique do usuário; o modelo não dispara nada sozinho.

Migração `024_copilot_context_memory.sql`. 23 testes novos (14 no núcleo do copiloto,
9 na base de conhecimento). **Ficou de fora, de propósito:** dicionário de sinônimos
externo (serviço de rede novo para ganho que a revisão de escrita já dá), o copiloto
mexer no layout por conta própria e escrita automática na memória. Detalhes em
`docs/COPILOT_PLAN.md` §9.

---

## Modo Design — v1 e v2 (2026-07-26)

Um espaço próprio, ao lado do chat: o usuário descreve o que precisa e a IA
devolve um rascunho **visual e renderizado**, não um bloco de código para montar.
Três tipos de saída — página/protótipo `web`, apresentação `slides` e documento
paginado `document` —, refinamento por conversa, histórico de versões navegável e
exportação (`.html`, `.pdf`, `.pptx`).

**A decisão que organiza o resto:** nada é gravado sem passar por
`extractArtifact`. O modelo responde o que quiser; o app só aceita um documento
HTML completo ou um JSON de slides no formato esperado. Uma geração ruim vira
mensagem no chat do projeto — a versão boa que estava na tela continua valendo.
Isso cobre os três modos de falhar que apareceram na prática: resposta com
conversa em volta, resposta embrulhada em cerca de código e resposta **cortada
por limite de tokens** (a mais traiçoeira: o HTML pela metade "parece" válido).

**Slides guardam JSON, não HTML.** O mesmo JSON vira prévia, PDF e `.pptx`. Se o
modelo devolvesse HTML de slides, montar o `.pptx` exigiria adivinhar as caixas
de texto de volta a partir de marcação arbitrária.

**Segurança — o ponto que não pode ser afrouxado.** O HTML de um design é código
gerado por IA. Ele roda em origem OPACA, garantida em dois lugares de propósito:
`Content-Security-Policy: sandbox allow-scripts` na resposta e
`sandbox="allow-scripts"` no `<iframe>` — **sem `allow-same-origin` em nenhum dos
dois**. Juntos, os dois atributos anulariam o sandbox e dariam ao código gerado a
origem do app (cookie de sessão e DOM inclusos). A prévia é servida por uma rota
sem sessão, com token de 32 caracteres, justamente para poder morar em outra
origem (`DESIGN_PREVIEW_ORIGIN`) sem o cookie acompanhar o artefato. E a
impressão em PDF **reaproveita** `guardRoute` do `agent/pageShot.js` em vez de
abrir o próprio navegador: sem isso, uma página com
`<img src="http://169.254.169.254/…">` usaria o navegador do backend para
alcançar a rede interna.

**Um defeito real encontrado pelo teste de navegador:** a resposta de `/generate`
serializava a linha do projeto carregada ANTES da geração, então
`currentVersionId` vinha velho. Na tela o efeito era duplo — o histórico marcava
a versão errada como "em exibição" e o iframe, que recarrega quando esse id muda,
seguia mostrando o design anterior. Parecia que o pedido não tinha feito nada.
`projectPayload` passou a receber o id e reler a linha; a regressão está guardada
também no nível HTTP.

**Mudança visível para o usuário:** um item "Modo Design" na barra lateral
(grupo Produção) abre uma tela cheia com prévia, chat do projeto, histórico e
exportação. O mascote (Nino) fica escondido enquanto o modo está aberto — ele é
`position: fixed` e pousaria sobre o compositor, a mesma sobreposição que o
PR #147 corrigiu no chat principal.

**Ficou de fora, e está escrito em `docs/DESIGN_STUDIO.md` §Limites:** sem
imagens (o layout `image-full` entrega um painel na cor da marca, não uma foto);
tela de compartilhamento público; e `document` **não** reaproveita o pipeline de
Word/PDF do agente — aquele caminho roda Python numa sandbox Docker presa a uma
CONVERSA, e um projeto de design não é uma conversa nem tem workspace. Em vez de
esticar aquele pipeline, o `document` gera HTML paginado e imprime com o Chromium
que a imagem já traz; quem precisa de `.docx` editável continua no chat principal.

### v2: edição inline e controles de ajuste

**Edição inline.** Ligue "Editar elemento", clique no que quer mudar e o pedido
vale só para ele — o modelo recebe um bloco `ALVO` com tag, classes, caminho e o
trecho de HTML, mais a instrução de deixar o resto idêntico.

O caminho do clique é o ponto interessante. A prévia roda em ORIGEM OPACA: de
fora, `iframe.contentDocument` é `null` e nenhum seletor alcança o documento —
e isso é a razão de o modo ser seguro, não um obstáculo a contornar. Então o
backend injeta na prévia (e SÓ nela) um script-ponte que realça o elemento sob o
cursor e devolve o descritor por `postMessage`. A interface valida a mensagem
pela JANELA (`event.source === iframe.contentWindow`): numa origem opaca,
`event.origin` chega como "null" e comparar isso não prova nada. Em
apresentações o alvo é o NÚMERO do slide — o modelo edita o JSON, e mandar o HTML
do deck (que é nosso) o faria devolver HTML onde deve devolver JSON.

**Controles de ajuste.** Sliders de cor, tipografia, espaçamento e arredondamento
que mudam a prévia na hora, sem versão nova e sem chamada à IA.

Isso exigiu um CONTRATO, não um truque: o system prompt passou a exigir que toda
saída HTML declare um bloco `:root` com variáveis `--fred-*` e as use no resto do
CSS. Sem ele, um slider de "cor primária" seria adivinhação — num HTML arbitrário
a cor está espalhada em vinte declarações escritas de jeitos diferentes
(`#1f3b8a`, `rgb(...)`, `bg-blue-900` do Tailwind), e reescrever por regex ora
acertaria, ora pintaria o texto de fundo. Com as variáveis, o ajuste é uma
sobreposição de `:root`.

Três consequências que valem lembrar ao mexer nisso:

- **A lista de controles é derivada do artefato**, não fixa: `detectTokens` lê o
  HTML servido. Um design fora do contrato (gerado antes da v2) mostra ZERO
  controles, e a tela explica o porquê em vez de oferecer sliders inertes.
- **O ajuste é camada, não reescrita**: fica numa coluna do projeto e é aplicado
  ao renderizar e ao exportar. É o que permite mexer no slider e depois pedir uma
  edição no chat sem que uma coisa apague a outra. E o que você vê é o que você
  baixa — a exportação leva os ajustes, mas NÃO leva a ponte de edição.
- **Ajustar não cria versão.** Um arrasto de slider não é decisão de design que
  mereça histórico; uma versão por movimento comeria a janela de poda.

O deck de slides passou a usar os mesmos nomes de variável, então apresentações
também ganham os controles de cor. `--fred-fonte-base` fica de fora ali de
propósito: o deck escala a tipografia em `cqw`, e um valor em px não teria efeito
— controle que não faz nada é pior que controle nenhum.

Onde está: migrations `022_design_studio.sql` e `023_design_ajustes.sql`; backend
em `src/design/` (`core.js`, `render.js`, `tokens.js` e `bridge.js` puros,
`store.js`, `generate.js`, `pdf.js`, `pptx.js`) e `src/routes/design.js`;
frontend em `src/components/Design*.jsx`, `src/design/designCore.js`,
`src/hooks/useDesign.js` e `src/design.css`. Documentação em
`docs/DESIGN_STUDIO.md` (e `docs/SECURITY.md` §6.1).
Testes: 37 + 11 + 19 + 6 + 5 puros, 13 de banco, 38 de rota e 9 em navegador real.

---

## Estabilização do ambiente de execução do agente (2026-07-26)

O pedido era largo: tornar o ambiente onde o agente edita arquivos, instala pacotes e
roda testes **estável, persistente, observável e recuperável**, de modo que uma falha de
infraestrutura não seja confundida com falha do projeto. O diagnóstico apontou uma causa
raiz que explicava a maioria dos sintomas:

**Um timeout matava o container inteiro.** Os processos filhos morriam (correto), mas
levavam junto os pacotes instalados no turno, os serviços de apoio e todo o estado fora
do workspace — e o modelo não era avisado de nada. Ele seguia trabalhando como se o
ambiente anterior existisse: reinstalava, repetia etapas e, no pior caso, declarava
concluída uma execução que havia sido cortada.

O que mudou:

| Antes | Agora |
| --- | --- |
| Timeout derrubava o sandbox | Mata a **árvore de processos** (`FREDERICO_EXEC_ID` varrido em `/proc/*/environ`, alcança netos); só derruba o container se ela sobreviver à carência |
| Resultado era `{exitCode, output}` | + `status`, `sucesso`, `duracao_ms`, `processo_encerrado`, `saida_parcial`, `arquivos_alterados`, `diagnostico` |
| Falha de ambiente parecia bug do código | Taxonomia com `falha_do_projeto`: dependência, rede, permissão, recurso e ferramenta são do AMBIENTE; teste quebrado e exit ≠ 0 são do projeto |
| Reinício era silencioso | Evento `ambiente_reiniciado` com motivo, geração e as listas **preservado/perdido** — entregue uma única vez |
| `pip install` sumia com o container | `/cache` é bind do host por usuário (pip/npm/uv/poetry) e as instalações ficam num manifesto em `/workspace/.agent-env` |
| Sem rede de segurança para edições | Checkpoints do workspace (criar/listar/restaurar), fora da árvore da conversa, **sem segredos** |
| Sem visibilidade de recursos | Ferramenta `ambiente` → `recursos`: CPU, memória, disco, maiores diretórios e processos |
| Comando longo era uma barra parada | **Saída ao vivo** por SSE (`tool_progress`), com terminal no Ambiente de Trabalho e aviso "sem saída há Xs" |
| Resultado perdia o começo da saída | Log INTEGRAL em `/workspace/.agent-env/ultima-execucao.log` + ação `ultima_execucao` |
| Servidor subido pelo agente era invisível | `servicos` cruza o que ele subiu com o que está REALMENTE escutando (`ss`/`netstat`), marcando o que morreu no reinício |
| Edição em vários arquivos sem rede de segurança | `transacao_iniciar/confirmar/desfazer` — e a transação ABERTA reaparece no preâmbulo do turno seguinte |

Detalhe importante da classificação, achado por teste: `ModuleNotFoundError` contém a
subcadeia `eNotFound` — com regex insensível a maiúsculas, uma dependência ausente virava
"problema de rede", exatamente o diagnóstico trocado que o módulo existe para evitar. Os
códigos de erro do sistema passaram a ser casados com fronteira de palavra e sem `i`.

Também: `/containers/<id>/stats` liberado no `docker-guard` (leitura, com posse pela
label — sem ela não dá para distinguir "morreu por falta de memória" de "o código
quebrou"), `/runtime/tmp` como `TMPDIR` descartável e `/artifacts` persistente na imagem
do sandbox.

Sobre o **corte da saída**: o resultado entregue ao modelo tem os últimos 12 mil
caracteres, e o erro de uma suíte longa está quase sempre no COMEÇO — que o corte
descartava. A saída inteira agora é gravada enquanto o comando roda, e o resultado aponta
o arquivo (`progresso.log_completo`). A gravação é síncrona de propósito: com
`createWriteStream`, o `end()` não garante os bytes em disco e a leitura no mesmo tique
encontrava o arquivo vazio. E `.agent-env` saiu da impressão digital do workspace — sem
isso, gravar o log fazia `arquivos_alterados` sair `true` em toda execução.

**Mudança visível para o usuário:** o assistente passa a avisar quando uma execução não
terminou, em vez de relatar sucesso; comandos longos mostram a saída **ao vivo** (com
aviso quando o comando emudece); e o agente ganha a ferramenta `ambiente`, que acompanha
automaticamente quem já tem `run_python`/`bash` (não é uma permissão nova a ligar no
Assistant Studio).

**Ficou de fora — e dois casos são "não deve ser feito", não "faltou tempo"** (§11 de
`docs/AMBIENTE_EXECUCAO.md`):

- **Snapshot do container** (o "checkpoint de ambiente" do plano) exigiria `POST /commit`
  na API do Docker, rota fora da allowlist do `docker-guard` DE PROPÓSITO: quem pode criar
  imagem no host escapa do isolamento que o F-04 fechou. Não vale reabrir a falha mais
  grave já corrigida por conveniência — o cache de pacotes + o manifesto de instalações
  resolvem o problema real (reinstalar rápido depois de um reinício).
- **Consulta ao progresso pelo próprio modelo durante a execução** é limitação do laço de
  function-calling: enquanto a ferramenta roda, o modelo está bloqueado esperando o
  resultado dela, então não existe turno em que ele possa perguntar. Exigiria execução
  assíncrona de ferramentas. Os dois efeitos práticos estão cobertos: o usuário vê ao
  vivo, o agente lê o log integral depois.
- **Cota de disco imposta**: `WORKSPACE_QUOTA_MB` só AVISA (a partir de 85%); bloquear a
  escrita exigiria quota do sistema de arquivos, decisão do operador.

Onde está: `backend/src/agentEnv.js`, `backend/src/sandbox.js`, ferramenta `ambiente` em
`backend/src/tools.js`, prompt em `backend/src/agent/prompts.js`, aviso de reinício e
evento `tool_progress` em `backend/src/agent/loop.js`, interface em
`frontend/src/hooks/useChat.js` e `frontend/src/components/ExecutionSession.jsx`.
Documentação em `docs/AMBIENTE_EXECUCAO.md`. Testes: `src/agentEnv.test.js` (33) e
`src/sandbox.stability.test.js` (18).

---

## O Nino cobria o botão de enviar (2026-07-26 — PR #147)

Primeiro defeito que a suíte E2E encontrou sozinha — e ele era pior do que pareceu na
primeira leitura. Medindo com navegador real em oito larguras:

| Largura | Sobreposição sobre o botão | O que o clique no centro do botão atingia |
| --- | --- | --- |
| 1920px | nenhuma | o botão |
| 1440px | nenhuma | o botão |
| 1280px | 23px | **o mascote** |
| 1100px | 40px (**botão inteiro**) | **o mascote** |
| 980px | 33px | **o mascote** |
| 820px | 33px | **o mascote** |
| 560px | 40px (**botão inteiro**) | **o mascote** |
| 390px | 40px (**botão inteiro**) | **o mascote** |

Ou seja: em notebook de 1280px e em **qualquer largura de celular**, tocar em "enviar"
acertava o Nino. Só funcionava em tela larga — provavelmente por isso passou tanto tempo
sem ser notado, e por isso nenhum teste o pegava: nenhum abria o app num navegador.

**Causa.** `.companionRoot` é `position: fixed; bottom: 22px`, e o compositor ocupa
justamente a base da tela. Em telas largas o compositor (máx. 840px, centralizado) para
antes da faixa do mascote; em telas médias e no celular ele usa a largura toda, e as duas
coisas disputam o mesmo canto.

**Correção.** O personagem passa a pousar **acima** do compositor:
`bottom: calc(var(--composer-h, 6px) + 16px)`. A altura vem medida — não escrita à mão —
por `frontend/src/hooks/useComposerHeight.js`, um *callback ref* com `ResizeObserver` no
`<footer className="composerWrap">`. Medir era necessário porque o compositor **cresce
com o texto** (a textarea vai até 160px) e muda entre modos de trabalho: qualquer número
fixo acertaria um caso e erraria os outros, em silêncio. Quem arrasta o mascote (o
componente salva a posição) continua no comando — o arraste usa `left/top` inline e
ignora o `bottom`.

**Guarda:** `e2e/tests/layout.spec.js`, 4 testes — sobreposição zero nas oito larguras,
compositor alto não empurra o mascote de volta, **clique real no botão** no desktop e no
celular, e um teste contra o exagero (o mascote tem de continuar visível dentro da
janela). Conferi que servem de guarda revertendo a correção: 3 dos 4 falham, com a
mensagem certa; o quarto passa nos dois casos, de propósito.

---

## Playwright: navegador headless e suíte ponta a ponta (2026-07-26 — PR #146, F-20)

Duas frentes numa só, porque as duas trocam a mesma peça.

### 1. O navegador headless passou a ser o Playwright

`backend/src/agent/pageShot.js` (miniatura de página do `web_fetch`) saiu do
`puppeteer-core` para o `playwright-core`. A imagem Docker **continua usando o Chromium do
apt** (`CHROMIUM_PATH=/usr/bin/chromium`) em vez de baixar o do Playwright: seriam ~150 MB
a mais na imagem de produção por um navegador que o apt já instalou.

**O que quase passou batido — e é o ponto importante desta frente.** O `page.route()` do
Playwright **não** é chamado de novo no destino de um redirecionamento; o
`setRequestInterception` do puppeteer era. Medido neste repositório, com um 302 de `/a`
para `/b`:

| | guarda chamado para `/a` | guarda chamado para `/b` | navegação |
| --- | --- | --- | --- |
| puppeteer | sim | **sim** | bloqueada |
| Playwright | sim | **não** | **seguiu** |

Ou seja: uma porta linha-a-linha teria reaberto SSRF por redirecionamento — bastaria uma
página pública responder 302 para `169.254.169.254` e o navegador do backend buscaria o
endereço de metadados da nuvem, exatamente a superfície que o F-04 aponta. A correção
segue os redirecionamentos **à mão** (`route.fetch({ maxRedirects: 0 })`), validando cada
salto antes de continuar.

De quebra, dois ganhos: `newPage()` do Playwright abre contexto próprio (cookies não vazam
de uma miniatura para a seguinte) e o `catch` que fazia `req.continue()` — falha **aberta**
— virou negação.

`pageShot.test.js`: 15 casos, sem navegador (as decisões são funções puras e o guarda
depende só da interface do `route`, então um duplo basta).

### 2. Suíte ponta a ponta (`e2e/`)

Chromium real contra o **build de produção** (`vite preview`), backend real e PostgreSQL
real. O único figurante é o provedor de IA: `e2e/fixtures/provedorFalso.mjs` responde no
lugar dele, de forma determinística — **nenhum teste usa rede externa ou chave paga**.

9 testes em 3 arquivos: streaming chega aos poucos e persiste; **duas conversas com troca
no meio do stream não misturam respostas**; recarregar a página no meio da resposta não a
perde (reconexão); indicador de "processando" na barra lateral; portão de consentimento
(LGPD); e a mensagem de chave inválida nomeando o provedor certo — a regressão do PR #140,
que até aqui só tinha teste de unidade.

Novo job `e2e` no CI, com Postgres real e Chromium. Ver `e2e/README.md`.

### Duas coisas que os testes encontraram

1. **O avatar do Nino ficava por cima do botão de enviar** — não corrigido naquele PR,
   **corrigido na frente seguinte** (seção acima), onde a medição mostrou que o problema
   valia para 1280px e todas as larguras abaixo, não só para 1280px.
2. **O modelo padrão do assistente continua sem prefixo de provedor.** Ao montar os
   testes foi preciso fixar o `modelRef` completo nos assistentes: sem isso o app manda
   `deepseek/deepseek-chat`, o `getUserProvider` cai no `rows[0]` e o teste da chave
   inválida recebia um eco normal em vez do 401. É a causa-raiz que já era o item 1 dos
   próximos passos — agora com uma demonstração reproduzível.

---

## Riscos abertos

| ID | Risco | Severidade |
| --- | --- | --- |
| F-21 | `App.jsx` ainda concentra dezenas de `useState`; CSS em camadas sem inventário. O **bundle deixou de ser um chunk só** (`React.lazy` nos painéis pesados: principal ~920 KB contra o teto de 1.000 KB do CI), mas o `MultiModelBoard` segue no principal — é importado de forma estática pelo `Landing.jsx`. | 🟡 Média |

## Riscos fechados nesta sessão

### F-1 — `modelRef` completo no assistente (causa-raiz do 401 do PR #140)

A frente da **geração de imagem** (PR #168) tratou o sintoma no caminho dela
— `getUserProvider` não morre mais numa linha órfã e a imagem escolhe a
chave por capacidade — mas a raiz continuava: o assistente não guardava
um `modelRef` completo, então um id sem prefixo `<provedor>::` ainda caía
no `rows[0]` da tabela `user_ai_providers` (o provedor mais antigo da
conta). Em conta com DeepSeek + OpenRouter, o chat falhava com a chave do
provedor errado e a mensagem genérica do 401 não deixava o usuário
identificar a causa.

A correção tem quatro peças:

1. **`backend/src/defaults.js`** — a constante única
   `DEFAULT_MODEL_REF = 'deepseek/deepseek-chat'` (formato OpenRouter,
   mesmo id que o seed já gravava e que o teste E2E do provedor falso
   fixa) e o `resolveDefaultModelRef()` que respeita o `DEEPSEEK_MODEL`
   do env. Substitui as duas cadeias que viviam divergentes: o hardcoded
   em `seed.js` e `routes/assistants.js`, e o `process.env.DEEPSEEK_MODEL
   || 'deepseek-chat'` em `routes/schedules.js`, `routes/inbox.js`,
   `routes/conversations.js`, `routes/helpers.js` e
   `memory/indexer.js`. Agora a semente, a criação de conversa, a inbox,
   a rotina, o `ensureConversation` e a extração de fatos da memória
   partilham da mesma fonte — e o que está no `.env` é o que vale em
   todos eles.
2. **Migration 028** — adiciona `assistants.model_ref` (nullable).
   O `model` legado continua existindo (é a coluna que a UI exibe como
   rótulo). A migração não preenche retroativamente: o id do provedor é
   por usuário e depende da ordem de cadastro; preencher errado seria
   pior que deixar para o backend.
3. **`backend/src/userProvider.js`**:
   - `resolveBareModelToRef(userId, bareModel)` é o coração da frente:
     recebe um id de modelo nu (sem `<provedor>::`) e devolve a referência
     completa, casando com o catálogo dos provedores da conta. Sem
     provedor capaz, devolve `null` e o caller grava a linha com
     `model_ref=NULL` (modo legado, tratado em runtime).
   - `getUserProvider` deixa de cair no `rows[0]` silencioso quando o
     usuário pediu um modelo específico que não está em catálogo nenhum.
     Antes o sistema chutava o provedor mais antigo e o 401 saía com a
     chave errada; agora `attributionError` carrega a mensagem e o caminho
     segue para o modo gratuito. O fallback do `rows[0]` continua valendo
     — mas SÓ quando não há modelo pedido (o cenário "usuário não disse
     qual, pega o padrão da conta"), que é o único em que chutar é
     legítimo.
4. **`backend/src/agent/loop.js`** e **`backend/src/agent/subagents.js`**
   passam a preferir `assistant.model_ref` sobre `assistant.model`. A
   mesma precedência vale no `runSubagent` (o especialista herda o
   provedor certo, não o chute do `rows[0]`). O `runOrchestrator` checa
   o `model_ref` na allowlist do modo gratuito (o caminho antigo só
   olhava o `model` cru, que nunca casava com a `freeModels` que já é
   `free::xxx`).

**Validação:**
- `backend/src/defaults.test.js` (3 testes) — constante canônica,
  override via env, fallback no default.
- `backend/src/userProvider.test.js` (8 testes) — `resolveBareModelToRef`
  com 1 e 2 provedores, modelo ausente, `getUserProvider` com id nu
  escolhe o provedor certo, `modelRef` completo escolhe pelo prefixo,
  modelo fora de catálogo devolve erro claro, `model_ref` NULL preserva
  compatibilidade com linhas pré-migration, e o caso do PR #140 (provedor
  mais antigo com chave quebrada não é mais o escolhido).
- `backend/src/routes/assistants.test.js` (6 testes HTTP) — POST
  grava `model_ref` quando o id está no catálogo (1 provedor, formato
  nativo; 1 provedor, formato OpenRouter; modelRef completo) e
  aceita `model=NULL` para soltar a fixação. PUT atualiza `model_ref`
  quando o modelo muda.
- `cd backend && npm run check`: lint 232 arquivos + **921 passam**,
  106 pulados (estes precisam de `DATABASE_URL`; ver §Validação local
  abaixo para a tentativa de rodar contra PostgreSQL real).
- `cd frontend && npm run check`: lint 41 arquivos + **77 testes** +
  build OK.

**Validação que não rodei contra o banco real:** o `embedded-postgres`
no Windows desta sandbox inicia um cluster, mas o cluster sai com
encoding `WIN1252` (a única locale disponível no contêiner é `C`); os
testes que escrevem caracteres UTF-8 (setas `→`, acentos, etc.,
presentes em comentários de casos) batem em `0xe2 0x86 0x92` quando o
`pg` tenta serializar a query. Sem pgvector, sem pg16 nativo, e com
Docker indisponível (serviço parado, ver `dockerDesktopLinuxEngine`
ausente), o caminho de "banco real" desta frente não foi exercitado
nesta máquina — os testes novos foram ESCRITOS para rodar com
`DATABASE_URL`, têm o `if (dbReady)` padrão do projeto e o CI os
executa contra `pgvector/pgvector:pg16` (mesmo image do `docker-compose.yml`).
A cobertura nova está portanto **provada** pelo `test:count` no CI, não
por contagem local.

**Risco residual:** o fallback `rows[0]` no caminho "sem provedor
pedido e sem modelo pedido" continua valendo. É o ÚNICO caminho em
que o chute é legítimo: o app precisa de um modelo padrão quando o
usuário não disse qual, e cair no provedor mais antigo utilizável é
o mesmo comportamento de antes (com o filtro de "utilizável" que o
PR da imagem de capacidade adicionou). Quem quiser zerar o fallback
também aqui precisa decidir o que servir sem chave — fora do escopo
desta frente.

### F-16, F-18, F-19 e F-23 — as quatro lacunas de cobertura (2026-08-05)

Quatro frentes irmãs, cada uma fechando uma lacuna de teste que o
`CONTINUIDADE.md` listava como risco. Os commits originais trouxeram os
arquivos e **esqueceram de dar baixa aqui** — o registro é desta integração,
não das branches:

| Risco | O que passou a ser coberto | Onde |
| --- | --- | --- |
| F-16 | Relevância de memória nos casos NEGATIVOS (o que não deve ser lembrado) | `backend/src/memory/retrievalPolicy.relevance.test.js` |
| F-18 | Corpus Docling: whitelist de tipo e conferência por magic bytes | `backend/src/docling.corpus.test.js` |
| F-19 | Git local (clone/commit/push) contra um **bare repo** de verdade | `backend/src/connectors.github.local.test.js` |
| F-23 | Casos de borda do validador de artefatos (`pickValidatableFiles`) | (coberto pelo commit F-23, que deu a própria baixa) |

O F-19 é o mais substancial dos quatro: em vez de simular o git, cria um
repositório bare em disco e exercita o caminho real — é o único jeito de o
teste falhar quando o comando muda.

### F-05b — Allowlist de egress no sandbox (2026-08-04)

Quando o sandbox tinha `networkEnabled=true`, o container conseguia
falar com QUALQUER destino: metadados de nuvem (`169.254.169.254`),
outros containers na mesma rede Docker, serviços internos do host. Era
o vetor de risco mais sério restante na fronteira do container.

A correção adiciona allowlist de egress no nível do comando — a
defesa real continua sendo o Docker/network, mas esta camada é o que
o usuário vê quando tenta acessar um destino proibido (a tentativa
aparece como "Comando bloqueado" no log do run).

- **`SANDBOX_NETWORK_ALLOWLIST`** (env, vírgula separa): lista de
  destinos permitidos. Aceita:
  - Domínio exato: `api.openai.com`
  - Domínio com sufixo (subdomínios): `.openai.com`
  - IP literal (com porta opcional): `192.168.1.5` ou `8.8.8.8:53`
  - CIDR: `10.0.0.0/8`
- **Default fail-closed**: allowlist vazia = NADA de rede passa. Sem
  opt-in explícito, o sandbox é tão fechado quanto antes do
  `networkEnabled=true` — só que agora o caminho para abrir é
  explícito (definir a env) em vez de implícito (assumir "tudo aberto").
- **`compileNetworkAllowlist` / `parseAllowlistEntry`** transformam
  string/array/objeto em regras estruturadas (`{kind, value, port?}`).
  IPv6 fica para uma frente posterior (a sintaxe é diferente e o volume
  de teste real é baixo).
- **`hostMatchesAllowlist`** aplica as regras — e a semântica de porta
  é conservadora: regra COM porta só casa com a mesma porta na
  chamada (sem fallback para "porta padrão"). Quem abriu 443 não
  aceitou 80 por tabela.
- **`extractHostCandidates`** varre `curl`/`wget`/`ping`/`nc`/`ssh`/`nslookup`/etc.
  com regex e devolve `{host, port}[]`. Cobre o uso real, não tenta
  ser exaustivo (defesa em profundidade).
- **`guardNetworkEgress`** itera os hosts extraídos e bloqueia o
  comando se ALGUM não casa. `pipe`-chains (`curl A | curl B`) são
  cobertos: se B não está na allowlist, A também não roda.
- **`guardCommand`** chama `guardNetworkEgress` quando recebe
  `networkAllowlist` no context — integração direta com `runTool`'s
  `bash` e `run_python`. Com rede desligada (`networkEnabled=false`),
  a allowlist fica vazia e o gate não dispara (sem custo extra).

**Limite honesto:** a análise é textual. O modelo que monta o host via
variável, ofusca com `${HOST}`, ou usa uma ferramenta própria escapa.
A defesa em camadas continua: Docker network + `CapDrop: ALL` +
`no-new-privileges`. Esta camada reduz a superfície e é o que aparece
no log — é melhor que nada, mas não é "à prova de modelo".

**Validação:**
- `backend/src/execGuard.networkAllowlist.test.js`: 23/23 — parsing
  (domínio/IP/CIDR/sufixo/porta), matching (case-insensitive, sufixo,
  IP, CIDR, porta), extração (`curl` URL, `curl` IP+porta, `ping`,
  `wget`, comando sem rede), fail-closed, IP proibido (metadados),
  integração via `guardCommand`
- `cd backend && npm run check`: 946/946 (79 pulados por Postgres)
- `cd frontend && npm run check`: lint + 70 testes + build OK

### F-15 — Coordenador durável de pipelines multimodelo (completo) (2026-08-05)

O `runMultiModel` opera em estágios sequenciais (modo `pipeline`) ou em
rodadas paralelas (`compare`/`council`/`debate`). Sem persistência, um
kill-9 ou restart no meio de uma execução descartava o progresso dos
estágios anteriores — o usuário tinha de reenviar o pedido e refazer
CADA chamada de modelo, pagando o custo em tokens e segundos novamente.

**Entregue em duas etapas:**

**Etapa 1 (2026-08-04) — infraestrutura:**
- **Migration 027**: tabela `pipeline_runs` com PK `pipeline_run_id`
  (`pipe_<nanoid>`), índices em `(conversation_id, status)` e
  `(user_id, status)`, e **UNIQUE INDEX parcial** em
  `(conversation_id) WHERE status='running'` — defesa em profundidade
  contra duas instâncias do backend inserirem a mesma linha em uma race.
- **`agent/pipelineRuns.js`** exporta as primitivas:
  - `createPipelineRun`, `updatePipelineRun`, `loadPipelineRun`,
    `completePipelineRun`, `sweepStalePipelineRuns`.

**Etapa 2 (2026-08-05) — integração (esta frente):**
- **`multiModel.js`**: `createPipelineRun` na entrada do pipeline;
  `updatePipelineRun` (currentStage + state_json) após cada etapa;
  `completePipelineRun` (done/stopped/error) na saída e no finally.
  A retomada é EXPLÍCITA: só o `/resume` a dispara (passa `pipelineResume`).
  Mensagem nova numa conversa com run órfão fecha o órfão como `error` —
  herdá-lo faria a resposta nova sair costurada sobre a tarefa antiga, e o
  sweeper nunca o removeria (ele só varre terminais).
- **`conversations.js`**: rota `/resume` detecta `pipeline_runs` ativo
  antes do checkpoint, reconstrói config e chama `runMultiModel` com
  `pipelineResume`.
- **`server.js`**: `sweepStalePipelineRuns()` no boot e a cada hora.
- **`docs/MULTIMODEL.md`**: seção 5 reescrita com o estado implementado.

**Validação:**
- `backend/src/agent.pipelineRuns.test.js`: 12 testes (7 originais +
  5 de integração) — retomada do estágio correto após boot simulado
  (pool novo), cancelamento sem órfão, falha completa run como error,
  config_json preservado integralmente entre save/load, e o órfão em
  `running` sobrevivendo ao sweeper (o que obriga o fechamento explícito).
- `cd backend && npm run check`: **1032/1032** com PostgreSQL 16 real
  recém-criado, nada pulado.
- `cd frontend && npm run check`: **77/77** + lint + build.

### F-14 — Teste de retomada após interrupção real do processo (2026-08-04)

O caminho kill-9 + boot + resume era coberto só indiretamente: as funções
puras (`buildResumeMessages`, `trimCheckpointMessages`) tinham testes de
unidade, e a rota `/resume` funcionava em produção, mas NADA provava que
um checkpoint gravado por um processo A era recuperado intacto por um
processo B. O `kill -9` no meio de um run era exatamente o cenário mais
importante para validar — e o único sem cobertura.

`backend/src/checkpoint.kill9.test.js` fecha essa lacuna:

- **Detecção de DB** no topo do arquivo — sem `DATABASE_URL`, todos os
  testes pulam com a mensagem padrão da suíte (`requer PostgreSQL
  (DATABASE_URL)`). Em CI com Postgres, rodam de verdade.
- **Cenário 1**: salva um checkpoint com array completo de mensagens
  (system + user + assistant com tool_calls + tool + assistant com
  tool_calls + tool), lê de volta, valida:
  - `objective`, `runId`, `reason`, `step` íntegros
  - `messages.length` preservada
  - `buildResumeMessages` adiciona a nota de continuidade sem
    duplicar trabalho
  - pareamento `assistant.tool_calls ↔ tool.tool_call_id` mantido
- **Cenário 2**: isolamento por `(user_id, conversation_id)` — uma
  conversa de OUTRO usuário não vê o checkpoint (defesa contra
  vazamento entre tenants).
- **Mecanismo de "morte"**: o pool do `pg` já usa clientes ociosos
  separados por query, então cada `loadCheckpoint` AGORA vem de uma
  conexão NOVA — equivalente a um processo que acabou de subir e não
  tem cache do cliente anterior. O banco é a fonte de verdade.

A diferença prática: antes deste teste, uma regressão silenciosa em
`saveCheckpoint` (ex.: serializar `tried_models` errado, ou cortar
mensagens no meio de um pareamento) só aparecia em produção, na hora em
que o usuário precisava retomar de verdade.

**Validação:**
- `cd backend && npm run check`: 915/915 (72 pulados por exigir Postgres —
  era 70, +2 deste arquivo)
- `cd frontend && npm run check`: lint + 70 testes + build OK

### F-26 — Cota global de checkpoints por usuário (2026-08-04)

A poda de checkpoints era por conversa — `pruneCheckpoints(checkpointsDir, keep)`
mantém os `CHECKPOINT_KEEP=5` mais novos POR conversa. Com `CHECKPOINT_MAX_MB=300`
e muitas conversas, um único usuário podia estourar o disco: 300 MB × 5 ×
N conversas. `WORKSPACE_QUOTA_MB` só avisa — não bloqueia.

A correção introduz **`pruneCheckpointsGlobal(userCheckpointsRoot, { maxBytes, skipDirName })`**
que varre TODAS as conversas do usuário, soma os bytes e remove os mais
antigos até o total ficar abaixo de `CHECKPOINT_GLOBAL_MAX_MB` (default
**2 GB**; configurável por env).

**Piso por conversa** (crítico): sem ele, a quota global poderia apagar
o ÚNICO checkpoint da conversa A para liberar espaço para a conversa B
— e a retomada de A deixaria de existir. O `shift()` da fila é pulado
se for o último checkpoint daquela conversa. Testado.

**`skipDirName`** (defesa em profundidade): `createCheckpoint` chama a
poda global ANTES de retornar. Para evitar que o checkpoint recém-criado
seja candidato à remoção na mesma passada (caso o usuário já esteja
estourado), a função recebe o nome da conversa atual e a ignora.

**Validação:**
- `backend/src/agentEnv.checkpointsGlobal.test.js`: 6/6 — cota desligada,
  abaixo da cota, acima da cota (remove do mais antigo), piso per-conversa,
  `skipDirName`, soma global entre conversas
- `cd backend && npm run check`: 913/913 (70 pulados por exigir Postgres)
- `cd frontend && npm run check`: lint + 70 testes + build OK

**O que ficou de fora (intencional):** contador `currentBytes` exposto no
`/api/health`. A correção de disco já basta; o contador seria cosmético
e adiciona uma varredura a cada healthcheck.

### F-24 — Sub-agentes: orçamento próprio + catálogo persistido de tool calling (2026-08-04)

Dois problemas coexistiam na delegação a sub-agentes:

1. **Sem teto por delegação** — o filho herdava o orçamento cheio do pai e
   podia queimar minutos de chave em uma subtarefa que era pra ser rápida.
   Em paralelo, o tempo total era a SOMA dos filhos, sem limite global.

2. **Catálogo de tool calling só em memória** — `markModelCapabilityUnsupported`
   registra no `Map` que o modelo não suporta ferramentas, mas o `Map` se
   perde no reinício. Resultado: um modelo que falhou ontem com "No
   endpoints found that support tool use" volta HOJE como apto, recebe a
   subtarefa, falha de novo, e o usuário paga o ciclo.

**Correção:**

- **Migration 026**: tabela `model_tool_capability_cache(provider_id, model,
  supports_tools, last_attempt_at, last_error, attempts, updated_at)`. PK
  composta por `(provider_id, model)`. Índice em `(supports_tools,
  last_attempt_at)` para a consulta "o que ainda está marcado como ruim".
- **`markModelCapabilityUnsupported(id, 'tools', { providerId, errorMessage })`**
  grava também no DB. Falha de DB não derruba (a cache em memória já basta
  para a sessão atual; a persistência é otimização para o próximo boot).
- **`loadModelToolCapabilityCache()`** roda uma vez no boot, repopula a
  cache em memória com os `(provedor, modelo)` já conhecidos como ruins.
- **`modelLacksToolsInCache(providerId, model)`** consulta rápida para
  quem for decidir se oferece a ferramenta de delegação ao modelo.
- **`clearModelToolCapabilityCache(providerId, model)`** para o operador
  forçar uma re-tentativa quando o provedor publica endpoints novos.

Para o orçamento:

- **`SUBAGENT_DEFAULTS`** centraliza defaults (12 etapas / 18 hard / 30k
  tokens / 8min total). Overrides por env: `SUBAGENT_BUDGET_STEPS`,
  `SUBAGENT_BUDGET_TOKENS`, `SUBAGENT_BUDGET_TOTAL_MS`, `SUBAGENT_BUDGET_HARD_STEPS`.
- **`buildSubagentBudget({ now, deadlineMs, totalMs })`** constrói o
  objeto `{ maxSteps, hardMaxSteps, maxTokens, deadlineMs }`. Quando o pai
  passa `deadlineMs`, todas as delegações paralelas compartilham o MESMO
  relógio — sem isto, duas paralelas dariam o dobro do tempo total.
- **`runAgent({ subagentRunBudget })`** aplica os tetos (cap nos tetos do
  pai) e checa o `deadlineMs` + `usage.total_tokens` a cada iteração do
  loop. Estouro gera `incomplete=true` + `checkpointReason='deadline'`
  ou `'token_budget'` + `failureMessage` em português.
- **Compartilhamento no pai**: `runBudget = buildSubagentBudget({ now: Date.now() })`
  é criado UMA vez por turno e passado para TODAS as chamadas
  `runSubagent(...)` — garantindo que paralelas param juntas.

**Validação:**
- `backend/src/subagents.budget.test.js`: 5/5 — defaults, deadline
  calculado, deadline explícito compartilhado, defaults finitos,
  totalMs acima do timeout duro do stream
- `cd backend && npm run check`: 907/907 (70 pulados por exigir Postgres)
- `cd frontend && npm run check`: lint + 70 testes + build OK

**O que ficou de fora (intencional):** UI para o usuário ver/limpar a
lista de `(provedor, modelo)` rejeitados. A correção de infra está
completa — a tela seria puro cosmético e aumenta superfície.

### F-11 — Quarentena de uploads aceitos com antivírus degradado (2026-08-04)

Quando o ClamAV está fora do ar (modo fail-open), os uploads eram aceitos
em `uploads/` com o selo "não verificado" — o que era o pior dos dois
mundos: o usuário conseguia ENVIAR o arquivo para o agente, que ia usá-lo
como contexto. Se o clamd estivesse caído por causa de um incidente de
segurança, isso virava distribuição de malware via Studio.

A correção introduz uma pasta `uploads/.quarantine/` e uma tabela
`quarantined_uploads` que acompanha cada arquivo aceito em modo
degradado. O fluxo:

1. **Na entrada** (`scanUploadBatch`): se `status === 'degradado'`, o
   arquivo é gravado em `uploads/.quarantine/` em vez de `uploads/` e
   uma linha é inserida com `status='pending'`. O `kickProcessing` do
   Docling NÃO roda — o conteúdo ainda não é confiável.

2. **Na recuperação** (mesmo `scanUploadBatch`, quando o clamd volta):
   o `reprocessQuarantine()` é chamado como efeito colateral do scan
   bem-sucedido. Limite de 10 itens por chamada (o resto fica para a
   próxima). Cada item é re-escaneado e tem três destinos:
   - `clean` → movido para `uploads/<name>` (caminho em `files`
     atualizado), `status='cleared'`. O Docling pode rodar agora.
   - `infected` → arquivo apagado, `status='infected'`, `virus_name`
     registrado para auditoria.
   - erro de infra → `status='stale'`, `attempts++`, `last_error`
     guardado. Próxima chamada tenta de novo.

3. **Tabela** com índices em `(status, quarantined_at)` e `user_id` —
   a consulta quente é "o que está pronto para nova tentativa",
   ordenada pela idade (FIFO). O `claimQuarantineItem` é o lock
   pessimista que evita dois reprocessamentos simultâneos no mesmo
   arquivo (anti-dupla-execução).

4. **Métricas** (`scanHealth.quarentenaTotal/Limpos/Infectados`) expostas
   no `/api/health`, junto com a política vigente — o operador vê se
   tem arquivo parado em quarentena sem precisar fuçar o banco.

**Defesa contra path traversal no nome do arquivo** (F-11 aproveita
o mesmo saneamento do F-25): caracteres fora de `[a-zA-Z0-9._ -]` viram
`_`, e o `..` literal vira parte do nome, não referência de diretório
— porque o `/` separador foi removido.

**Validação:**
- `backend/src/clamav.quarantine.test.js`: 4/4 — `quarantineDirFor`,
  `quarantineUploadedFile` move e devolve path relativo, cria
  `.quarantine` se não existir, saneia nome (path traversal fechado)
- `cd backend && npm run check`: 901/901 (70 pulados por exigir Postgres)
- `cd frontend && npm run check`: lint + 70 testes + build OK
- Os 10 testes do `clamav.test.js` continuam passando — o
  `reprocessQuarantine` é tolerante a DB indisponível (try/catch
  silencioso, retorna `skipped`) e o mock do clamd funciona normalmente

### F-25 — Sub-agentes: outputs isolados por delegação e rótulo correto (2026-08-04)

O conjunto de arquivos que o pai entregava ao usuário sempre foi certo
(o diff `outputsAfter` × `outputsBefore` filtra só os NOVOS), mas dois
problemas coexistiam:

1. **Colisão**: dois sub-agentes em paralelo que escolhessem o mesmo nome
   (`relatorio.xlsx`) sobrescreviam um ao outro na raiz `outputs/`.
2. **Atribuição**: o rótulo por sub-agente não era confiável — o pai
   emitia `files` sem dizer quem produziu o quê.

A correção isola cada delegação numa subpasta de outputs e propaga o
rótulo até o cartão de arquivo:

- **`runAgent({ outputsSubdir })`** — novo parâmetro. Quando presente,
  `generateImage` grava em `outputs/<subdir>/...` em vez de `outputs/`.
  O id da delegação (`tool_call.id`) é usado como subdir: é determinístico
  e único por chamada.
- **`buildSubagentTask`** injeta a subpasta na instrução do sub-agente,
  para que `write_file`, `bash` e `run_python` sigam o mesmo isolamento
  (as ferramentas leves lêem o caminho do tool call e o agente obedece).
- **`resolveOutputsTarget`** — função pura extraída para testes. Faz o
  saneamento do subdir (mantém só `[a-zA-Z0-9._-]`, troca `/` por `_`),
  fechando a porta para path traversal via id malicioso.
- **`subagentProducers`** (mapa no loop) registra `{ delegationId ->
  label, prefix }`. O label começa como `sub-agente` e é atualizado com
  o nome real do especialista quando o `delegation.result` é parseado
  (campo `especialista` retornado por `summarizeSubagentResult`).
- **Atribuição no `files`** — cada cartão recebe `producer = <label>` se
  o `path` começa com `outputs/<delegationId>/`. Arquivos do próprio
  agente principal ficam sem `producer` (mantém o comportamento atual).

**Validação:**
- `backend/src/tools.outputsSubdir.test.js`: 5/5 — root, com subdir,
  saneamento contra path traversal, vazio cai na raiz, número/string
- `cd backend && npm run check`: 896/896 (70 pulados por exigir Postgres)
- `cd frontend && npm run check`: lint + 70 testes + build OK

### F-12 — SSE: reconexão com cursor (fromSeq + runId) sem duplicar (2026-08-04)

A rota `GET /conversations/:id/stream` aceitava `fromSeq` desde o PR #146,
mas o frontend nunca enviava — toda reconexão pedia o replay inteiro, e o
front "remontava do zero" (limpava o balão e aplicava o replay). Resultado:
flicker visível em cada oscilação de rede e re-renderização de centenas de
blocos à toa.

A correção tem três peças coordenadas:

1. **Carimbo de runId** — `openLiveStream(convId, runId)` agora recebe o
   runId; cada `rec` no buffer carrega o carimbo. O runId é gerado em
   `conversations.js` (e em `checkpoint.runId` na retomada) e passado ao
   `runAgent` via `runIdOverride`. Sem esta propagação, não há como
   distinguir "ainda é o mesmo run" de "um run novo começou".

2. **Filtro no subscribe** — `subscribe(fn, { fromSeq, runId })` filtra
   TANTO o replay quanto novos eventos. O `runId` é estrito: se o cliente
   pediu um runId que não bate com o buffer atual, recebe vazio (o front
   decide resetar). Fallback silencioso para "replay do começo" mascararia
   a colisão "seq antigo vs seq novo" e produziria texto aparentemente
   correto mas com buraco no início.

3. **Cursor no front** — `liveCursorRef[convId]` guarda o último
   `(_runId, _seq)` recebido. `reconnectLiveRun` passa-os na URL
   `?runId=...&fromSeq=...`. O balão SÓ é zerado se o cursor veio vazio
   (cliente sem referência anterior — primeira reconexão após reload).

**Por que `runId` é obrigatório em vez de só `fromSeq`:** um POST /chat
entre a desconexão e a reconexão cria um run novo com seq reiniciado em 1.
Sem o filtro de runId, o cliente mandaria `fromSeq=K` (do run antigo) e
pularia os primeiros K eventos do novo — texto faltando na remontagem.

**Validação:**
- `backend/src/liveStream.test.js`: 10 testes (4 novos) — fromSeq, runId,
  runId estrito, replay após novo run, filtro em eventos pós-subscribe
- `e2e/tests/reconexao.spec.js`: a rota `/stream` aceita os novos params
  sem quebrar; o caminho legado (sem cursor) continua respondendo
- `cd backend && npm run check`: 891/891 (70 pulados por exigir Postgres)
- `cd frontend && npm run check`: lint + 70 testes + build OK

A cobertura do caminho front→back dentro da MESMA aba (sem reload) ficou
nos testes unitários do `liveStream` — o `useChat` não expõe um ponto
estável para forçar uma reconexão SSE sem reload, e o caminho
cross-page (reload) já era coberto por `multiconversa.spec.js`.

### F-13 — Provedor falso com tool_calls e stall (2026-08-04)

O provedor simulado (`e2e/fixtures/provedorFalso.mjs`) agora cobre os dois
caminhos que faltavam para o laço do agente:

- **`ferramentas`** — emite uma `tool_call` (`bash echo ok-e2e-tool`) na 1ª
  rodada, com `finish_reason: 'tool_calls'`. Quando o backend reenvia com o
  `tool_result` na conversa, o provedor devolve texto e fecha com `stop`. Os
  deltas seguem o formato OpenAI: `tool_calls` vem em duas etapas (id + nome,
  depois argumentos), com `index` para o backend mesclar.
- **`travado`** — abre o stream, envia apenas o delta inicial (`role`) e
  fica em silêncio. Forçar o socket vivo sem fechar é o cenário que o
  `guardStreamStall` foi feito para detectar (proxy engolindo resposta,
  upstream congelado, rede móvel trocando de antena) — fechar o socket seria
  outro caminho de erro, e ambos precisam de cobertura.

**Por que dois caminhos de teste e não só o E2E completo:** o laço do agente
em volta do stall envolve o backend inteiro (provider → OpenAI SDK → loop →
recuperação → aviso ao usuário). O E2E cobre isso ponta a ponta, mas exige
Postgres, build de produção e Playwright. Para a guarda barata — sem rede,
sem banco, em milissegundos — há `e2e/verificar-provedor-falso.mjs`, rodado
via `npm run verificar:provedor-falso`. Ele valida os três comportamentos
(ferramentas 1ª chamada, ferramentas 2ª chamada, travado) sem subir nada
além do próprio provedor.

**Ajuste no `playwright.config.js`:** o backend de E2E agora sobe com
`STREAM_STALL_TIMEOUT_MS=2000` e `MODEL_STREAM_RECOVERY_LIMIT=1` — sem isto
o teste de stall esperaria 180s pelo watchdog e 3 ciclos de recuperação
antes do aviso.

---

## Próximos passos (em ordem)

1. **Frente 9 — Desmontar o App.jsx (etapa 1: shell).** Extrair shell (layout,
   sidebar, drawers de abertura) para componentes próprios, sem mudar comportamento.
2. **Frentes seguintes** conforme o backlog ordenado.

---

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

**Mapa da documentação:** `docs/ARCHITECTURE.md` (como funciona) ·
`docs/SECURITY.md` (ameaças e controles) · `docs/OPERATIONS.md` (runbook) ·
`docs/BACKUP_RESTORE.md` · `docs/TESTING.md` · `docs/AUDITORIA_2026-07.md` ·
`docs/CHANGELOG_HISTORY.md` (histórico).
