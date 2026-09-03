# Histórico de desenvolvimento — Frederico AI Studio

> Este arquivo é o **histórico** do projeto, preservado integralmente. Era o antigo
> `CONTINUIDADE.md`, que havia se tornado um diário de 2.640 linhas misturando
> decisões antigas (SQLite, `APP_PASSWORD`, fases já concluídas) com o estado
> vigente — o que tornava impossível saber, ao abrir o arquivo, o que ainda valia.
>
> **Nada foi apagado.** O que mudou é o endereço:
>
> | Para saber... | Leia |
> | --- | --- |
> | Estado atual, riscos abertos e como retomar | `CONTINUIDADE.md` (na raiz, curto) |
> | Como o sistema funciona de verdade | `docs/ARCHITECTURE.md` |
> | Modelo de ameaça e controles | `docs/SECURITY.md` |
> | Operação, limites e runbook | `docs/OPERATIONS.md` |
> | Backup e restauração | `docs/BACKUP_RESTORE.md` |
> | Testes e lacunas de cobertura | `docs/TESTING.md` |
> | Auditoria de produção de 2026-07 | `docs/AUDITORIA_2026-07.md` |
>
> Entradas abaixo estão em ordem cronológica inversa (mais recente primeiro).
> **Cuidado:** trechos antigos descrevem decisões que já foram substituídas —
> use-os como registro do "porquê", não como referência do que vale hoje.

---

## Prompt v4.2 unificado — um texto no lugar da colagem (2026-09-03)

**O que estava errado.** O `messages[0]` era a soma de cinco constantes escritas
em épocas diferentes: `IMMUTABLE_CORE_PROMPT`, o perfil do assistente,
`QUALITY_BAR`, `EXECUTION_UX_RULES`, `SANDBOX_RULES` e `COMPLETION_PROTOCOL` —
mais o bloco de kits, que só o assistente "Documentos profissionais" recebia.
Três consequências concretas:

1. **A mesma regra em três vozes.** "Não diga que concluiu quando o status é
   timeout" existia no `EXECUTION_UX_RULES`, no `SANDBOX_RULES` e no
   `COMPLETION_PROTOCOL`, em três redações. Regra repetida em redações
   diferentes é como elas divergem — e o modelo passa a seguir a mais fraca.
2. **A ordem era acidental.** Nada dizia ao modelo qual bloco vence qual.
3. **A API dos kits não chegava a quem podia usá-la.** Um assistente
   personalizado com `run_python` gerava `.docx` sem saber que o kit existia, e
   diagramava na mão — o defeito que a REGRA ZERO tentava fechar.

**O que mudou.** `backend/src/agent/systemPromptV4.js` passou a montar um texto
único, com uma seção por assunto e a hierarquia de conflito declarada no fim:
núcleo → perfil → PADRÃO DE RESPOSTA → CICLO DE EXECUÇÃO → (DOCUMENTOS
PROFISSIONAIS) → SANDBOX → EXEMPLOS → EM CASO DE CONFLITO → CONTEXTO DESTA
CHAMADA. As três constantes absorvidas foram REMOVIDAS, não reescritas: duas
fontes para a mesma regra é como elas divergiram.

- **A seção de documentos virou da BASE** e entra só quando `run_python` está na
  chamada. O prompt sai com ~20,4 mil caracteres para quem executa e ~9,6 mil
  para quem não executa — antes, ~21,8 mil só para o assistente de documentos e
  ~9,8 mil (sem kit nenhum) para todos os outros.
- **CONTEXTO DESTA CHAMADA** leva a data de hoje no fuso do aplicativo, o modelo
  e o estado da rede. A **hora** ficou de fora de propósito: `messages[0]` é o
  primeiro breakpoint do cache de prompt, e uma hora ali o invalidaria a cada
  turno.
- **Quem não recebe o v4.2:** os especialistas do Modo Equipe e o coordenador do
  multimodelo continuam com `protectedProfilePrompt()` (núcleo + perfil +
  `QUALITY_BAR` + `COMPLETION_PROTOCOL`, < 6 mil caracteres). Eles não executam
  ferramentas; arrastar o ciclo de execução para cada parecer custaria 20 mil
  caracteres por especialista, por rodada, sem uso.
- **Núcleo, regra 7:** "Responda no idioma do usuário" virou "Responda em
  português do Brasil, salvo se o usuário escrever em outro idioma". O produto é
  pt-BR; a redação antiga deixava o modelo escolher pelo idioma do próprio
  raciocínio.

**Testes.** `agent/prompts.context.test.js` (novo): data e fuso corretos,
nenhum `{{...}}` cru sobrevivendo, a hora NÃO entrando (dois horários do mesmo
dia produzem prompts idênticos), a ordem dos blocos finais e as catracas de
tamanho (< 23 mil com documentos, < 11 mil sem). `agent/promptPolicy.test.js`
ganhou a ordem das seções, a prova de que as constantes absorvidas não voltam
coladas e de que o envelope dos especialistas segue enxuto.
`promptKits.test.js` e os testes de kit do `qaFixes` passaram a ler a seção da
BASE, não mais o perfil do assistente. Backend: 1414 testes, 0 falhas.

**O que NÃO foi feito, e é o gate que falta:** a validação de COMPORTAMENTO. A
mudança é de texto, e texto não tem teste unitário que prove que o modelo
responde melhor. O plano da revisão pede uma bateria de mensagens reais contra
um modelo forte e um gratuito, comparando v4.1 e v4.2 — ela exige chave de
provedor e a aplicação de pé, e não pôde ser executada aqui.

---

## Kits de documento v2 — revisão de design aplicada (2026-09-03)

**O que motivou.** A revisão gerou quatro documentos reais com os kits v1
(relatório gerencial em Word, ata em Word sóbrio, planilha com painel em Excel e
proposta em PDF), converteu tudo para PDF, rasterizou as páginas e **olhou o
resultado**. Os achados tinham página e causa no código, e quatro eram críticos:

1. **A fonte que o cliente vê não era a que foi conferida.** O `.docx` pedia
   "Source Serif 4"/"Source Sans 3" pelo nome; elas não existem no Windows nem
   no Mac, o Word substituía e a conferência — feita no PDF gêmeo do sandbox —
   passava a valer para outro documento.
2. **Sumário do Word com a página informada pelo modelo** — e errado no próprio
   teste: "Sumário executivo … 3" com a seção na página 2.
3. **Tabela quebrada com a linha TOTAL sozinha** no topo da página seguinte.
4. **Assinatura sozinha numa página** na proposta em PDF.

**O que mudou.**

- Nasceu `sandbox/kits.py`, a base COMUM dos três kits: paleta, escala
  tipográfica fechada, formatação pt-BR (`fmt`), tipagem de coluna, cálculo do
  TOTAL, regras de leitura (corpo do KPI, eixo em milhar) e a auditoria
  compartilhada. Antes isso vivia triplicado e divergia.
- **Tipografia com fidelidade no cliente:** Cambria sobre Calibri (existem em
  todo Office desde 2007). No Linux o LibreOffice as substitui por
  Caladea/Carlito, metricamente idênticas — o PDF gêmeo quebra a linha no mesmo
  lugar que o Word do cliente. Source virou `tipografia="editorial"`, só para
  PDF, onde a fonte vai embutida.
- **Presets** (`gerencial | parecer | proposta | carta | sobrio`): o modelo
  escolhe o registro do documento e o kit decide capa, sumário, numeração de
  seção, alinhamento do corpo e fechamento.
- **Números pertencem ao kit.** O modelo passa `int`/`float`/`date`; a coluna
  (`moeda=`, `pct=`, `milhar=`, `data=`) formata, alinha e escreve o negativo
  entre parênteses em vermelho. `total="soma"` CALCULA a linha.
- **Sumário com as páginas REAIS:** `salvar()` grava, converte para PDF,
  descobre em que página cada título caiu (ignorando as linhas do próprio
  sumário, senão o índice aponta para si mesmo) e converte de novo.
- **Paginação virou código:** tabela de até 15 linhas indivisível, TOTAL nunca
  órfão, "Fonte:" colada, fecho + assinaturas + testemunhas num bloco
  indivisível que **cola no conteúdo anterior**, sumário sem página própria
  abaixo de 10 entradas, fechamento em faixa no pé da última página.
- **`salvar()` dos TRÊS kits audita o arquivo pronto** e levanta `KitError` no
  achado grave: placeholder de rascunho, linha fora do cabeçalho, sumário
  divergente, página em branco, assinatura órfã, coluna numérica com texto,
  fórmula com erro, gráfico sem série. Antes só o `pdfpro` auditava.
- **Excel:** filtro no cabeçalho, `total="formula"` para a planilha viva, aba
  de Notas por último e impressão ajustada à largura — com os **gráficos**
  dentro da área de impressão (eles flutuam sobre a grade e não entram em
  `max_row`, então o painel imprimia sem eles).
- **Sóbrio:** hífen não separável em CNPJ/CPF/NIRE/CEP e helpers de redação
  jurídica (`clausula`, `paragrafo_unico`, `paragrafo_numerado`, `inciso`,
  `item`, `testemunhas`, `rubrica`).
- **PDF:** marcadores (outline) a partir dos títulos, registrados na reemissão
  de páginas do `_CanvasNumerado` — durante o build todos apontariam para a
  página 1.

**Prompt.** `backend/prompts/docpro/atual.txt` foi reescrito para a API v2
(`docpro` 12.0.0 → 13.0.0) e `backend/src/promptKits.test.js` passou a travá-lo
contra o código: todo `objeto.metodo(` citado tem de existir em `sandbox/*.py`,
os parâmetros nomeados têm de estar na assinatura, os quatro kits têm de usar os
mesmos nomes (`cargos=`, `fonte=`, `moeda=`, `total=`) e a API aposentada não
pode voltar. Era daí que vinha a rodada perdida: o prompt ensinava
`assinaturas(cargos=)` num kit e `subtitulos=` no outro.

**Compatibilidade.** Os nomes de método antigos continuam funcionando;
`subtitulos=`, `autor=`, `estilo="sobrio"` e `sumario(entradas)` viraram alias
(o último com aviso). O que MUDOU de comportamento e pode surpreender um script
antigo: linha fora do cabeçalho e placeholder agora **reprovam** em vez de
passar em silêncio, e a contracapa padrão é a faixa, não a página inteira.

**Validação.** 160 testes de sandbox (eram 97), backend 1402/0, frontend
170/170. O job "Artefatos" do CI passou a instalar matplotlib, LibreOffice e as
fontes Carlito/Caladea — sem eles os testes de gráfico e de PDF gêmeo se
auto-pulavam e a cobertura sumia em silêncio. Os quatro documentos da revisão
foram regerados por `sandbox/exemplos/gerar_exemplos.py` e conferidos em tela.

**Ficou de fora, de propósito:** o prompt v4.1/v4.2 **unificado** (a fusão de
`IMMUTABLE_CORE_PROMPT` + `QUALITY_BAR` + `EXECUTION_UX_RULES` + `SANDBOX_RULES`
+ `COMPLETION_PROTOCOL` numa constante única) — é uma reorganização da
arquitetura de prompts, com testes próprios, e o próprio plano de entrega da
revisão a coloca num PR separado, depois de os kits serem conferidos em tela.
Aqui entrou só a seção DOCUMENTOS PROFISSIONAIS, que ficaria **errada** se não
acompanhasse a mudança de API.

---

## Developer Workspace 3.0 — Frentes 10 a 20 e antecedentes (2026-08-05 → 2026-08-07)

Entradas que saíram do `CONTINUIDADE.md` na poda de 2026-08-08, quando o
arquivo do presente chegou a 1.991 linhas. Ficaram lá as frentes 21 em diante;
estas continuam valendo como registro do "porquê", não como estado atual.

- a **Frente 20 — Branch de trabalho por tarefa**
  (decisão 2A) fechou o isolamento de HISTÓRICO — o de arquivos já vinha do
  clone por conversa. Em modo de escrita sobre branch protegida (main/master/
  develop…) ou sem branch fixada, a tarefa passa a commitar numa branch
  derivada determinística (`frederico/<projeto>-<conversa>`), com a vinculada
  como base do PR; a mesma conversa retomada volta para a MESMA branch, em vez
  de criar uma nova a cada turno. Branch de trabalho explícita no vínculo
  continua mandando.
  A decisão mora no `githubPreflight` (fonte única de inventário, interface e
  prompt) e o escopo da autorização estruturada passou a ser conferido contra a
  branch EFETIVA: uma autorização emitida para a protegida agora dá
  `scope_mismatch` em vez de liberar o push do trabalho. **O caminho legado de
  autorização por texto do turno NÃO ganhou alcance** — continua exigindo
  branch explícita no vínculo (era o ponto de atenção do teste de
  compatibilidade, que pegou a regressão).
  No painel do projeto, com vínculo em branch protegida, o botão "Autorizar
  publicação" dá lugar a uma explicação honesta: a autorização é pedida
  **dentro da tarefa**, já com o nome real da branch — o painel roda antes de a
  conversa existir e não pode prometer um nome que ainda não é conhecido.
- a **Frente 19 — Projetos dev no servidor (ADR 0004)**
  fechou o risco R7 da auditoria: a fonte de verdade dos projetos do Modo
  Desenvolvedor (vínculo repo/pasta, regras, memória permanente, permissões
  concedidas, modo) saiu do localStorage e foi para o banco.
  - Migration 033 completa `dev_projects` com `permissions`/`mode` (COALESCE no
    upsert: chamador antigo não apaga o registro); a lista de conversas deriva
    de `conversations.project_id`.
  - Rotas autenticadas `GET/PUT/DELETE /api/dev-projects` + `POST /import`
    (migração única do acervo local, idempotente, guardada por marcador no
    navegador — servidor esvaziado em outro dispositivo não é re-populado por
    cache antigo). Excluir projeto SOLTA as conversas, nunca apaga histórico.
  - `useDevProjects` virou cache sincronizado: bootstrap do servidor, mudanças
    por PUT com debounce, exclusão imediata; offline segue funcionando no
    cache. `projectFromServer` pura e testada.
  **Consequência prática:** trocar de navegador/dispositivo não perde mais o
  vínculo nem as autorizações; o pré-voo e as rotas de botão GitHub validam
  contra o MESMO registro que a UI mostra.
- a **Frente 18 — Developer Workspace 3.0: ChangeSet real,
  Code Intelligence leve e doom loop**. Três respostas diretas às perguntas de
  confiança da Fase 73 ("Quais arquivos mudaram?", "Está travado?"):
  1. **ChangeSet real** (`agent/changeSet.js` + `GET /conversations/:id/changes`):
     a aba "Alterações" passa a mostrar a VERDADE do git no clone da conversa —
     status M/A/D/R + ±linhas por arquivo e totais, lidos pelo backend sem
     token e sem sandbox. Sem repositório git, a UI mantém o fallback
     heurístico, agora rotulado como pista ("selo M/A é pista, não diff").
  2. **Code Intelligence leve (decisão 6A)** (`agent/codeIntel.js`): ferramentas
     `find_file` (glob/trecho de nome) e `search_text` (literal/regex + filtro
     glob → arquivo+linha+trecho), acompanhantes automáticas de quem já lê o
     workspace (como a `ambiente` — a migration 011 é imutável e não foi
     tocada). Contenção: só `ws.base`, sem symlink, sem node_modules/.git,
     binário ignorado, limites com aviso explícito. Sem LSP nesta fase, de
     propósito.
  3. **Doom loop detection** (`agent/doomLoop.js`): a 3ª chamada idêntica
     (ferramenta+argumentos) com o MESMO resultado é bloqueada antes do
     executor, com erro estruturado mandando mudar de estratégia; resultado
     novo zera a contagem. O bloqueio alimenta o freio de falhas consecutivas.
  **Pendências que continuam abertas** (da Frente 17): worktrees/branch por
  tarefa, layout de 3 colunas, review gate, projetos dev no banco, e o
  streaming do terminal fora do event log durável.
- a **Frente 17 — Developer Workspace 3.0 (fundação)**
  atacou as causas estruturais da fragilidade do Modo Desenvolvedor, mapeadas
  por uma auditoria completa (frontend, backend, durabilidade/SSE) + pesquisa
  da documentação oficial de Cursor, OpenCode e Codex. Cinco entregas:
  1. **Máquina de estados explícita + runs duráveis (ADR 0003).**
     `agent/runStateMachine.js` valida transições (inválida não derruba o run:
     carimba `invalidTransition` e loga); `agent_runs`/`agent_run_events`
     (migration 032) persistem a estrutura da execução — reload e restart
     deixam de apagar terminal/etapas (`GET /conversations/:id/runs` +
     `runHydration.js` remontam com timestamps reais); no boot, run órfão de
     restart vira `recoverable_error` em vez de "executando" para sempre.
  2. **Correções críticas da auditoria:** orçamento de sub-agente NUNCA era
     aplicado (`subagentBudget` vs `subagentRunBudget` — o filho herdava 200
     etapas sem teto); `ReferenceError` latente no deadline; TOCTOU em que um
     segundo POST /chat destruía o LiveStream do run ativo (controle agora é
     adquirido pela rota ANTES do stream); rotas de botão GitHub sem escopo
     (push agora exige o vínculo do projeto no servidor); crash do diálogo de
     pergunta (`CircleHelp` não importado); `clearCheckpoint` sem dono;
     `_seq`/`_runId` ausentes do stream primário.
  3. **Política de comandos allow/ask/deny** (`agent/permissionPolicy.js`):
     comuns seguem sem prompt; destrutivos de trabalho não commitado pedem
     confirmação via `ask_user` com escopo carimbado pelo backend; a
     confirmação vira `commandGrants` re-validado (falha fechada) e herdado
     pelos sub-agentes. Política de produto SOBRE as fronteiras duras.
  4. **Plano estruturado visível** (`update_plan` + `PlanChecklist`): passos
     com status e EVIDÊNCIA obrigatória para `completed` (validada no
     backend); sobrevive a reload, replay e retomada.
  5. **Frontend honesto:** etapa `running` no fim do stream só fecha como
     `done` se o backend declarou `completed` (senão `interrupted`, com ícone
     próprio); pill do modo dev lê o estado real da máquina (não
     `messages.length`); cursor de replay não pula mais o balão recriado;
     timer morto `nowTick` removido (re-render global de 1s).
  **Limite conhecido:** `tool_progress` (saída ao vivo do terminal) segue fora
  do event log durável de propósito (alta frequência) — a reconstrução pós-
  reload mostra etapas e resultados, não o streaming intermediário. As fases
  seguintes do Workspace 3.0 (worktrees, code intelligence leve, layout de 3
  colunas, review gate) ficaram registradas no plano da frente e NÃO estão
  implementadas.
- o **Nino arrastado não cobre mais os controles do rodapé**.
  A Frente 16 corrigiu o personagem ANCORADO (o `bottom` do `companion.css` soma
  `--composer-h` + `--dock-h`) e o PR #184 corrigiu a **visibilidade** do
  personagem arrastado (revalidação por `clampCompanionPosition`). As duas
  convivem — medido: 16px de folga no caso padrão —, mas sobrava uma lacuna que
  nenhuma das duas cobria: **arrastado**, o Nino tem `left`/`top` absolutos, o CSS
  deixa de valer, e ele voltava a pousar sobre o botão de enviar e sobre o
  cabeçalho do terminal. Provado por hit test em navegador real:
  `elementFromPoint` no botão "Maximizar o terminal" devolvia o SVG do mascote e o
  clique era recusado. A lacuna é anterior às duas frentes — o arraste vem do
  #130/#142 —, porque a revalidação reservava só o recuo DIREITO (a coluna
  Atividade), e o inferior ficava na margem padrão de 8px.
  Agora a regra é uma só, pura e testada, em `frontend/src/companionPosition.js`:
  `PROTECTED_CONTROL_SELECTORS` (`.composerWrap`, `.dockHead`, `.chatJump`) +
  `protectedBottomInset`, que converte as medidas reais desses controles no recuo
  inferior que o `clampCompanionPosition` já sabia aplicar. Cobrir a **área de
  log** do terminal continua permitido — quem arrastou para lá quis isso; cobrir
  **botão** não. O recuo entra nos dois caminhos (no arraste, medido uma vez no
  início do gesto; e na revalidação), e como a faixa muda de altura sem a janela
  mudar de tamanho, o `useComposerHeight` anuncia cada mudança no evento
  `BOTTOM_BAND_EVENT` (`fred:bottom-band`) — sem ele, abrir o terminal por baixo
  de um Nino já arrastado o deixaria parado em cima dos botões.
  **Limite conhecido:** o botão "Ir para o final" aparece conforme a rolagem, sem
  passar pela faixa medida — é respeitado no arraste, mas um Nino já parado ali
  não sai do caminho quando o botão surge.
  **Validação:** frontend 130/130 (lint + testes + build + budget 918/920 KB +
  catraca de CSS) e **41/41 ponta a ponta**, com os três casos novos de arraste
  conferidos nos dois sentidos — desligando o recuo, os três falham.
  Doc: `docs/FREDERICO_COMPANION.md` § "A faixa de controles do rodapé".
- a **Frente 16 — Modo Desenvolvedor: rolagem, perguntas,
  terminal e publicação no GitHub** fechou quatro defeitos que se reforçavam.
  1. **Smart Auto-scroll real.** O efeito antigo dependia da identidade do array
     `messages` e chamava `scrollIntoView({behavior:'smooth'})` — durante o
     streaming a animação reiniciava a cada token, e quem subia para reler algo
     era arrastado de volta. Agora há estado explícito de acompanhamento
     (`chatScroll.js` + `hooks/useSmartAutoScroll.js`): roda, teclado e gesto de
     toque pausam **na hora**, o botão "Ir para o final" retoma, enviar força o
     acompanhamento uma vez, streaming nunca usa animação suave e a chave de
     conteúdo é derivada do que realmente cresceu (não do tique do relógio).
  2. **Perguntas interativas (`ask_user`).** Pedir uma decisão deixou de ser
     falha: uma ferramenta interna, interceptada antes do `runTool`, encerra o
     turno em `awaiting_user`, emite `input_required` e persiste em
     `execution_meta.inputRequest` (sem migration). `classifyTaskResult` devolve
     `waiting_user` e as rotas **não** emitem mais `execution_failed` nesse caso.
     A interface tem texto, confirmação e seleção; fechar não descarta; sobrevive
     ao reload e ao replay.
  3. **Terminal inferior expansível.** O cartão grande e vivo saiu do balão (que
     ele empurrava para fora da tela) e virou uma faixa do layout do chat —
     recolhível, expansível, maximizável, redimensionável por ponteiro **e por
     teclado**, com rolagem própria e "Novos logs". O relógio bate dentro do
     terminal, não no chat. O overlay em tela cheia continua como visualização
     secundária, lendo as mesmas etapas.
  4. **Publicação no GitHub.** `autorização do usuário ≠ disponibilidade da
     ferramenta`: a liberação de `github_push`/`github_create_pr` dependia de uma
     regex no texto do turno atual, então a autorização morria no turno seguinte
     e o agente respondia "as ferramentas não estão habilitadas nesta sessão".
     Agora há uma decisão só (`agent/githubAccess.js`): autorização
     **estruturada** e escopada a repositório/branch/base/ações, re-validada no
     backend, viajando no checkpoint; um pré-voo que a interface mostra com a
     **causa real** de cada bloqueio; e git remoto pelo bash do sandbox
     **bloqueado**, apontando as ferramentas certas.
  Três achados do próprio teste de navegador, todos corrigidos aqui:
  * **Um quadro de animação já agendado ignorava a pausa.** A decisão "acompanhar"
    era tomada no efeito e executada no `requestAnimationFrame` seguinte; se o
    usuário girasse a roda nesse intervalo, o quadro descia mesmo assim. O efeito
    visível era o pior possível: o gesto funcionava, a pausa passava a valer, mas
    o usuário levava um "puxão" de volta ao fim logo depois de subir. A trilha de
    rolagem medida no navegador mostrou exatamente um salto, 16 ms após o gesto.
    O quadro agora reavalia a pausa antes de rolar.
  * **A coluna do chat não era limitada pela janela.** `.app` é um grid com
    `height:100vh`, mas a linha era de tamanho automático: numa conversa longa ela
    crescia com o conteúdo, `.messages` (flex:1, overflow:auto) nunca precisava
    rolar — a **página** rolava — e **o compositor era empurrado para fora da
    tela**. O sintoma ficava escondido porque a rolagem antiga usava
    `scrollIntoView()`, que rola qualquer ancestral. Rolando o contêiner (o certo),
    o teste mediu `scrollHeight - clientHeight === 0` com nove parágrafos passando
    do rodapé. Corrigido com `grid-template-rows:minmax(0,1fr)` em `.app` e
    `min-height:0;overflow:hidden` em `.chat`.
  * **O personagem do copiloto pousava sobre o cabeçalho do terminal** e
    interceptava os cliques de recolher/expandir — mesma classe de defeito que ele
    já tinha com o botão de enviar. Corrigido com `--dock-h`: quem flutua no
    rodapé soma compositor + terminal.
  **Limite conhecido:** as etapas de ferramenta não são persistidas no banco (só o
  resumo, em `execution_meta`), então reabrir uma conversa antiga **não**
  reconstrói o terminal — é o mesmo limite que o cartão de execução sempre teve.
  Dentro da sessão, a sessão concluída reabre pelo botão "Ver detalhes"; a
  preferência de estado e de altura do terminal sobrevive ao reload.
- o **portão de bundle passou a medir a coisa certa**. Ele somava
  todo o JS contra um teto único de 1.000 KB — e a `main` estava exatamente em 1.000,
  com 100% do orçamento consumido: qualquer PR de frontend reprovava. Pior, ele punia
  code splitting (cada chunk novo soma invólucro), reprovando o PR da Frente 10 que
  BAIXOU a primeira pintura de 909 para 896 KB. Agora são dois tetos — entrada
  (920 KB) e total (1.100 KB) — e a regra roda no `npm run check`, não só no CI.
- a **Frente 5 — IPv6 + `git` na allowlist de egress do
  sandbox** fechou duas lacunas do F-05b: endereços IPv6 literais (`[::1]`,
  `[2001:db8::1]`) são bloqueados com mensagem clara quando a allowlist está
  ativa (fail-closed), e comandos `git` (clone/push/pull/fetch/remote)
  passaram a ser varridos pela extração de hosts. 10 testes novos; casos
  existentes intactos.
  Antes dela, a **Frente 4 — Vulnerabilidades de dependências** (#173) zerou
  as 4 vulnerabilidades com overrides em `package.json`.
- a **Frente 6 — Extração de memória usa o modelo da
  conversa** corrigiu o ruído nos E2E. O `indexAfterReply` agora recebe o
  `modelRef` da conversa (via `loop.js`, `multiModel.js`, `orchestrator.js`)
  e o repassa ao `getUserProvider`, eliminando o 404 de "modelo não pertence a
  este provedor" em contas multi-chave. O log virou `console.warn` com mensagem
  mais informativa. 9 testes unitários cobrem a precedência.
- a **Frente 7 — Reconciliação de sandbox ligada por
  padrão** ajustou a política de `SANDBOX_RECONCILE_ON_BOOT`: fora de
  `NODE_ENV=test` a reconciliação é LIGADA por padrão (remove containers
  órfãos no boot); em teste, DESLIGADA (a suíte não tem Docker). O boot
  agora sempre relata o resultado da reconciliação (mesmo sem órfãos).
  5 testes de política pura cobrem todos os cenários.
- a **Frente 8 — Retomada real pós-kill-9** fecha o F-14
  de verdade: teste de integração com `child_process` onde o processo A grava
  checkpoint com tool calls e encerra (simulando SIGKILL), e o processo B
  carrega e reconstrói via `buildResumeMessages` sem duplicar ferramentas.
  Pula com a mensagem padrão sem PostgreSQL; com banco, exerce o caminho real.
- a **Frente 9 — Desmontar o App.jsx (etapa 1: shell)**
  extraiu a sidebar (~70 linhas de JSX) para `Sidebar.jsx`, reduzindo o
  `App.jsx` de 1550 para ~1480 linhas. Comportamento idêntico: 77 testes
  passam, build OK. As próximas etapas (estado da conversa, estado da
  execução, drawers/configurações) estão registradas abaixo.
- a **Frente 11 — Inventário e poda do CSS (F-21)** fechou
  a dívida do CSS solto: o `frontend/scripts/cssInventory.mjs` (plugado em
  `npm run check`) varre os `frontend/src/*.css` por classes realmente usadas
  nos JSX/JS/HTML — literal, template string, classNames() e concatenação —
  e classifica cada regra como viva, morta-removível ou mista (mortas
  combinadas com vivas). A catraca: o número de regras mortas removíveis NÃO
  pode subir em relação ao snapshot em
  `frontend/scripts/cssInventory.snapshot.json`, lido em todo check.
  A poda removeu os arquivos `promptcoach.css` (3,4 KB, 90% morto — o módulo
  `promptCoach.js` existe mas o componente UI nunca foi escrito) e
  `dev-handoff.css` (10,2 KB, ancorado em `.workspace-developer` que nenhum
  JSX aplica) e mais 84 regras mortas dos demais arquivos. Resultado:
  CSS fonte caiu de 248.813 para 226.903 bytes (-22 KB / -9%); o bundle
  final minificado caiu de **206,08 KB para 186,96 KB (-19,12 KB / -9,3%)**.
  O estado pós-poda: 10 arquivos CSS, 2.117 regras, 3 removíveis
  (vs. 117 antes da poda), 123 mistas (mortas combinadas com vivas — não
  tocadas), 1.963 vivas. 81/81 testes do frontend passam, lint limpo, build
  dentro do orçamento. As 123 regras mistas ficam para frente futura com
  E2E ponta a ponta — o ambiente deste sandbox não tem servidor Postgres
  nem `/opt/pw-browsers/`, então a prova visual de UI ficou fora. A
  catraca impede regredir; o detector é determinístico.
- a **Frente 14 — Métricas operacionais reais no painel admin**
  instrumentou a tabela `usage` com `feature` (TEXT) e `cost_usd` (NUMERIC(10,6)),
  centralizou os 7 INSERTs espalhados por 6 arquivos num único helper `recordUsage()`
  com lista canônica de features (`chat`, `multimodel`, `design`, `design-image`,
  `scheduled-task`), e expôs a rota admin `GET /api/admin/usage/dashboard` —
  agregado por feature (hoje/7d/30d), custo mensal, top 5 usuários 30d, top 10
  modelos no mês e pressão de cota contra `FREE_TIER_DAILY_LIMIT`. Falha no
  INSERT é logada mas não propaga; custo estimado em USD só entra quando o
  profile do modelo tem `pricingKnown`. Sem DB ativo no sandbox: 4 testes do
  helper pulados, 4 testes do dashboard passam, 85/85 do Design intactos,
  10/10 do routes/, 81/81 do frontend, lint limpo nos 243 arquivos do backend.
  Doc: `docs/OBSERVABILITY.md`.
- a **Frente 10 — MultiModelBoard fora do chunk principal**
  moveu `MULTI_MODE_LABEL` para `constants.js`, eliminando o import estático do
  `MultiModelBoard` no `Landing.jsx` e `MultiModelPicker.jsx`. O aviso
  `INEFFECTIVE_DYNAMIC_IMPORT` sumiu do build; chunk principal caiu de 922 para
  907 KB; `MultiModelBoard` ganhou chunk próprio (13.82 KB).
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

---

## Rastro de validações por frente (até 2026-08-08)

O `CONTINUIDADE.md` guarda só a validação da frente corrente; o histórico de
contagens por frente fica aqui.

- **2026-08-08 (série temporal):** backend 1366 testes, 0 falhas, 144 pulados;
  frontend 166/166 (entrada 890/920 KB, total 1064/1100 KB, catraca de CSS 3 ≤ 3).
- **Veredito → review gate:** backend 1355, 0 falhas, 144 pulados; frontend
  inalterado.
- **Frente 26 (telemetria):** backend 1347, 0 falhas, 144 pulados; frontend
  162/162 (entrada 890/920 KB, total 1063/1100 KB). O portão de autenticação do
  CI passou a cobrir `/api/reliability`.
- **Frente 25 (`validar_pagina`):** backend 1331, 0 falhas, 144 pulados;
  frontend inalterado (frente só de backend). O servidor de pré-visualização é
  exercitado com HTTP de verdade (fetch contra a porta efêmera), inclusive a
  recusa de link simbólico apontando para fora da raiz; o veredito tem 12
  testes; o modo sandbox roda com o `execInSandbox` INJETADO, o que exercita o
  parser de saída suja, truncada e ausente, mais um `node --check` sobre o
  script gerado. **Nenhum navegador roda naquele ambiente** — o teste que prova
  o `disponivel: false` em vez de um "validado" falso é o que cobre esse
  contrato nos dois modos.
- **Frente 24 (handoff):** backend 1293, 0 falhas, 144 pulados; frontend
  155/155 (entrada 890/920 KB, total 1058/1100 KB; o painel de handoff é chunk
  próprio). O ciclo foi exercitado contra git de verdade, com um repositório
  bare local fazendo as vezes de remoto. Sem prova visual.
- **Frente 23:** backend 1273, frontend 149/149. **Frente 22:** backend 1273,
  frontend 140/140. **Frente 21:** backend 1265, 0 falhas. **Frente 20:**
  backend 1253, 0 falhas.
- **Frente 19:** backend 1240, 0 falhas, 144 pulados; frontend 140/140 (entrada
  916/920 KB). **Frente 18:** backend 1236/0, frontend 135/135. **Frente 17:**
  backend 1221/0 (2026-08-07).
- **2026-08-06:** frontend 81/81. **2026-08-05:** backend 1008/1008 com Postgres.
  Os 26 E2E ponta a ponta exigem Postgres + Chromium do contêiner
  (`/opt/pw-browsers/`).

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

## Riscos fechados (2026-07 → 2026-08)


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

## Frentes 14 e 15 — métricas operacionais e sonda de tool calling (mergeadas)

Estavam listadas como "próximos passos" no `CONTINUIDADE.md` mesmo já
mergeadas; o registro técnico delas fica aqui.

- **Frente 15 — Sonda controlada de tool calling.**
   Branch `t6-frente-15-tool-call-probe`. Componentes novos em
   `backend/src/tools/probe/`: 5 cenários canônicos (`scenarios.js`),
   3 schemas didáticos (`schemas.js`), classificador com 4 modos de
   parse (`classifier.js`: nativo → `json_block` → `xml_block` →
   fallback), agregador com 6 vereditos categóricos (`results.js`:
   `native_supported` ≥80%, `text_only` 100% fallback, `json_block`/
   `xml_block` maioria em um modo, `unreliable` mistura, `no_capability`
   >50% provider error), orquestrador com timeout 30s + concorrência 2
   (`probeRunner.js`), JSON seguro (`parseFallback.js`). CLI
   `scripts/run-tool-probe.mjs` com flag `--live` para chamar provider
   real. Rota admin `POST /api/admin/tool-probe` (registra em
   `admin_audit`). Diretório `tools/probe-results/` para histórico por
   modelo (formato `probe-<modelo>-<YYYY-MM-DD>.{json,md}`). Testes:
   28 do classificador + agregador + scenarios + JSONAttempt, 2 do
   router; lint limpo em 253 arquivos; 85 do Design intactos, 10 do
   routes/, 81 do frontend. Doc: `docs/TOOL_CALLING_PROBE.md`.
- **Frente 14 — Métricas operacionais reais no painel admin.**
   Branch `t6-frente-14-operational-metrics`. Migration 031 adiciona
   `feature` (TEXT) e `cost_usd` (NUMERIC(10,6)) em `usage`, com 2
   índices para agregação. Helper `recordUsage()` em `src/usage.js`
   centraliza os 7 INSERTs espalhados por 6 arquivos (`tasks.js`,
   `conversations.js` ×3, `design.js`, `design/images.js`), com
   `KNOWN_FEATURES` canônico (`chat`, `multimodel`, `design`,
   `design-image`, `scheduled-task`) e estimativa automática de
   `cost_usd` quando o profile tem `pricingKnown`. Rota admin nova:
   `GET /api/admin/usage/dashboard` retorna agregado por feature
   (hoje/7d/30d), custo mensal, top 5 usuários 30d, top 10 modelos
   no mês e pressão de cota (`FREE_TIER_DAILY_LIMIT × 0.8`). Falha
   no INSERT é logada mas NÃO propaga (cobrança é secundária).
   Testes: 4 do helper (cost, feature desconhecida, sem userId) e 4
   do dashboard (startOfUtcDay, lista canônica, exports, quotaPressure
   sem env). Doc: `docs/OBSERVABILITY.md`.

---

## Sub-agentes: as sete falhas P0 (2026-07-26 — PR #145)

Revisão técnica externa do mecanismo de delegação apontou 7 achados P0. Todos confirmados
contra o código e corrigidos nesta frente.

| # | Falha | Correção |
| --- | --- | --- |
| P0-01 | Sem especialista válido, o filho rodava com `assistant = null` e `toolsFor(null)` liberava **todas** as ferramentas — um assistente só-leitura ganhava `bash`/`write_file` ao delegar | `allowedTools = pai ∩ especialista` (`intersectToolDefinitions`); sem especialista, o filho herda o **perfil do pai** |
| P0-02 | `runAgent` recalculava rede e escrita no PC a partir do `userText` — que, no filho, é a subtarefa **escrita pelo modelo** | Herdadas do `DelegationContext`; o filho não chama `resolveSandboxNetwork` nem `explicitlyAuthorizesPcWrite` |
| P0-03 | Pai em `write:<projeto>` e filho em `read-only`: cada um derrubava o container do outro na primeira ferramenta | `sandboxOptions` e `developerContext` herdados verbatim → mesma `sandboxPolicy().key` |
| P0-04 | O prompt dizia "você não vê o histórico", mas o filho usava o mesmo `conversationId` e recebia memória + histórico inteiros | Janela isolada: sem `buildContext` e sem `selectHistoryForContext` quando `isSubagent` |
| P0-05 | `Promise.race([...ativas])` liberava **várias** tarefas por vaga: limite 2, pico 3 | Semáforo com contador + fila FIFO |
| P0-06 | Delegações do lote eram lançadas **antes** das outras ferramentas: `write_file` + delegar para revisar o arquivo → o filho lia o que ainda não existia | Paralelismo só em lote homogêneo (`canLaunchDelegationsInParallel`); lote misto roda em série |
| P0-07 | `control.activeTool` era slot único: com dois filhos executando, o Parar abortava só o último | `control.activeTools` virou `Set` |

De carona, três achados P1/P2 que tornavam os P0 difíceis de perceber:

- **P1-01/P1-02** — `especialista` era texto livre pedindo "o nome exato" sem o modelo saber
  quais existem: ele inventava "Fiscal", "Revisor", e o código caía no assistente padrão em
  silêncio, com a interface anunciando o nome pedido. Agora vai `especialista_id` com
  **`enum` dos ids reais** da conta e id inexistente devolve `SUBAGENT_SPECIALIST_NOT_FOUND`.
  O resultado carrega o especialista e o modelo que **de fato** rodaram, e a interface mostra.
- **P2-01** — a subtarefa era cortada em 6.000 caracteres em silêncio (o que se perde são as
  regras do final). O corte passa a ser declarado ao sub-agente.

**ARMADILHA:** a fronteira de autorização é o `DelegationContext` **congelado**, montado uma
vez pelo pai. Qualquer permissão nova do filho tem de entrar ali — derivar do texto da
subtarefa devolve a decisão ao modelo, que é exatamente o defeito de origem.

Detalhe em `docs/SECURITY.md` §8.1 e `docs/ARCHITECTURE.md` §13.1.

---

## GraphQL no sandbox e o inventário do modelo (2026-07-26 — PR #144)

`strawberry-graphql[fastapi,cli]` entrou na imagem do sandbox — schema por type hints,
`Schema.execute_sync` para consultar sem subir servidor, `strawberry.fastapi.GraphQLRouter`
para expor pelo FastAPI que já estava lá e o comando `strawberry` (GraphiQL local).

O inventário que o modelo lê foi atualizado nos **três** lugares em que ele existe — eram
independentes e é fácil mexer num e esquecer os outros:
`PYTHON_INVENTORY` (`agent/prompts.js`), a descrição do `run_python` (`tools.js`, que é o
que muitos modelos leem para decidir chamar a ferramenta) e a verificação automática de
ambiente (`ENVIRONMENT_QUERY_RE` + `ENVIRONMENT_AUDIT_COMMAND`, para "tem GraphQL aí?"
rodar `import strawberry` de verdade em vez de o modelo responder de memória).

**ARMADILHA (duas):**

1. O pacote é `strawberry-graphql`, o módulo é `strawberry` — mesma classe do `odfpy`/`odf`.
   Por isso ele entrou na lista de auditoria, que existe exatamente para os nomes que não
   batem.
2. O `pip install` fica numa camada **ao fim** do Dockerfile, não junto do `flask fastapi`.
   Acrescentar no meio do arquivo invalidaria todas as camadas seguintes — dotnet, Kotlin,
   Chromium, Playwright — e cada atualização baixaria tudo de novo numa VPS pequena. É o
   mesmo motivo já documentado no bloco acima dele.

Guarda novo: `agent/prompts.inventory.test.js` compara o que o modelo lê com o que o
Dockerfile instala. Ele **descarta os comentários** do Dockerfile antes de comparar — a
primeira versão passava com o pacote desinstalado porque casava com o comentário que o
cita. Verificado nos dois sentidos: falha ao remover o `pip install`, passa ao devolver.

`atualizar.sh` e o `docker compose up -d --build` já reconstroem a imagem do sandbox
(`sandbox-image`). Quem subir **sem** `--build` fica com a imagem antiga e o inventário
promete o que não existe — a regra de conferir no terminal antes de afirmar cobre o caso,
mas o certo é reconstruir.

O README também passou a descrever a caixa de ferramentas do sandbox (antes era só
"Python, Bash e geração de arquivos"), incluindo REST e GraphQL. Vale a regra de sempre:
só entra ali o que está de fato instalado na imagem.

---

## Bateria adversarial de injeção de prompt (2026-07-26 — PR #143, F-17)

`backend/src/agent/promptInjection.adversarial.test.js` — 33 casos escritos do ponto de
vista de quem controla o conteúdo externo, cobrindo os quatro vetores previstos no F-17:
README malicioso no repositório, memória envenenada em turno anterior, delimitador fechado
à força e resposta maliciosa de outro modelo no multimodelo.

Rodada contra o código anterior, a bateria acusou **15 falhas** — duas causas reais:

**1. O selo do delimitador só cobria a forma canônica.** `untrustedContext()` escapava
`</untrusted-context>` exato; escapavam da caixa `</untrusted-context foo="1">`,
`</untrusted-context/>`, `< /…>`, `</ …>` e a tag de **abertura** (que faz o fechamento
legítimo encerrar o bloco forjado, deixando o resto do payload aparentemente fora dele).
Os metadados do cabeçalho escapavam só aspas: um `>` ou uma quebra de linha no valor punha
texto do atacante **antes** do aviso "isto é dado" — o único trecho que o modelo lê como voz
do aplicativo.

**2. 🔴 O resultado de ferramenta ia CRU para o modelo.** `loop.js` fazia
`messages.push({ role: 'tool', content: result })` sem wrapper nenhum — apesar de o
`docs/SECURITY.md` §8 já afirmar que passava por `untrustedContext()`. É o maior canal de
texto de terceiros do app (`web_fetch` traz a página inteira, `read_file`/`bash` o arquivo
ou a saída do comando, `github_clone` o README) e a cadeia mais curta até **execução**: o
mesmo loop converte protocolo textual (`<tool_call>`, `<function=…>`) achado no texto do
modelo em chamada nativa, então bastava o modelo repetir um trecho da página lida para o
comando do atacante rodar no sandbox. O teste "a cadeia completa" prova os dois lados:
sem defesa o eco vira 1 chamada real; com o dado neutralizado, 0.

Correção em `promptRegistry.js`: `neutralizeExternalMarkup()` escapa a marcação estrutural
(delimitador em qualquer forma tolerante, `trusted-instruction` e o protocolo textual de
ferramenta), os atributos passam a escapar `<`, `>` e quebra de linha, e
`untrustedToolResult()` embrulha o resultado no `loop.js`. O `result` **cru** continua indo
para a interface e para `classifyToolOutcome` — quem precisa dele intacto.

**ARMADILHA:** o casamento é limitado a esses nomes de propósito. Escapar marcação genérica
mutilaria HTML, XML e código legítimos — e num domínio contábil/fiscal o conteúdo *é* o
dado. Quatro testes de não-regressão guardam isso (`R$ 1.234,56`, `a < b && b > c`,
bloco de código, `<div class="card">`).

---

## "Chave da API inválida" apontando o provedor errado (2026-07-26 — PR #140)

Conta com DeepSeek **e** OpenRouter: o OpenRouter sincronizou 345 modelos às
21:42:55 (chave válida) e o chat falhou às 21:42 com "Chave da API inválida ou
expirada". Mesma chave, mesmo minuto — ou seja, **a chamada que falhou não era a
do OpenRouter**.

Cadeia da causa:

1. `seed.js` grava nos assistentes padrão o modelo `deepseek/deepseek-chat` — um
   id **sem prefixo `<provedor>::`**. (O repositório ainda tem dois defaults
   incoerentes: `deepseek/deepseek-chat`, nome do OpenRouter, em `seed.js` e
   `routes/assistants.js`; e `deepseek-chat`, nome nativo, em `routes/schedules.js`,
   `inbox.js`, `conversations.js` e `helpers.js`.)
2. `getUserProvider` não acha esse id em catálogo nenhum e cai em `rows[0]` —
   **o provedor mais antigo**, que nesta conta é a DeepSeek.
3. A chave da DeepSeek é recusada → 401 → mensagem genérica mandando "confira sua
   chave", sem dizer de quem.

Corrigido **o diagnóstico**: `tagProviderError` marca no erro qual provedor e qual
modelo falharam (em `loop.js` nos dois catches do stream, no `multiModel.js` por
cartão e no `orchestrator.js`), e `friendlyApiError` nomeia os dois no 401/402.
7 testes novos, incluindo os casos sem contexto (a mensagem antiga não regride).

**Ainda em aberto (causa raiz):** `rows[0]` continua sendo um chute silencioso, e
os defaults sem prefixo continuam sendo gravados. O certo é o assistente guardar um
`modelRef` completo — frente própria, ainda não feita.

---

## 🔴 O sandbox não subia em NENHUM ambiente (2026-07-26 — PR #140)

`POST /containers/create` era recusado pelo guarda em toda tentativa, então
nenhuma ferramenta rodava. Mesmo sintoma no PC e na VPS, causas diferentes:

| Ambiente | Log | Causa |
| --- | --- | --- |
| Windows (Docker Desktop) | `bind por volume nomeado não é permitido: C:\Users\...\workspaces\...:/workspace` | `bindSource` cortava no primeiro `:` — o da **letra de unidade**. A origem virava `"C"`, que não começa com `/`, e caía na regra de volume nomeado. |
| VPS | `caminho proibido no host: /root/...` | `git clone` logado como root (o que o `VPS-DEPLOY.md` manda fazer) põe o projeto em `/root/<projeto>`, então `GUARD_WORKSPACE_ROOT` vira `/root/<projeto>/workspaces` — e a blocklist tem `/^\/root/`. |

Correções em `docker-guard/src/policy.js`:

- `normalizeHostPath` aceita caminho do Windows (`C:\a\b` / `C:/a/b`), devolve a
  forma canônica e continua recusando UNC e volume nomeado; `isInsideRoot`
  compara sem caixa quando os dois lados têm letra de unidade.
- `bindSource` ignora o `:` da unidade.
- **A raiz do workspace tem precedência sobre a blocklist de diretórios de
  sistema** — ela vem da configuração do operador, não do backend, então confiar
  nela não amplia a superfície que o F-04 fecha.
- O **socket do Docker saiu da blocklist comum** (`isDockerSocket`) e é barrado
  antes de tudo: nem uma raiz mal configurada o libera.
- Blocklist equivalente para Windows (`C:\Windows`, `Program Files`,
  `ProgramData`, `AppData`) — sem ela, ligar "Pastas do PC" num host Windows
  ficaria sem blocklist nenhuma, já que as regras POSIX nunca casam com `C:/...`.

9 testes novos (40 → 49), incluindo os invariantes: socket sempre barrado, `/root`
**fora** da raiz segue barrado e os diretórios de sistema do Windows também.

---

## 🔴 A tela "Algo deu errado por aqui" (2026-07-26 — PR #140)

Abrir **qualquer conversa em que a IA tivesse usado uma ferramenta** derrubava a
aplicação inteira na tela do `ErrorBoundary`. Causa:

```js
export { SUBAGENT_TOOL } from '../executionSteps.js';   // ExecutionSession.jsx
```

Um re-export cria a **entrada de exportação** do módulo, mas **não** uma variável
local. `SUBAGENT_TOOL` era usado logo abaixo em `summarize()` e em `ResultView()` —
ou seja, referência a um global inexistente. `summarize()` roda num `useMemo` do
`ExecutionSessionInner`, que o `App.jsx` monta para todo bloco `type: 'tool'`:
`ReferenceError` na primeira renderização e a árvore inteira caindo. Corrigido
importando o nome (binding de verdade) e reexportando a partir dele — a superfície
pública do módulo continua igual. Reproduzido no Chromium antes e depois.

**É a segunda ocorrência da mesma classe de bug** (a primeira foi `chunksIncluded`,
no Context Builder). Nada pegava: `node --check` não pega — a sintaxe é válida; o
build não pega — o bundler resolve exportações, não escopo; e o `lint` do frontend
**ignorava os `.jsx` por inteiro**. Daí a rede nova: `frontend/scripts/reexportBindings.mjs`
acusa nome re-exportado que é usado no próprio arquivo, roda também nos `.jsx` e tem
12 testes próprios (`scripts/` entrou na varredura do `run-tests.mjs` — um guarda que
erra é pior que guarda nenhum).

---

## O que mudou por último (embeddings sem a árvore vulnerável, 2026-07-25 — PR novo)

Migração de `@xenova/transformers@2.17.2` (parado, sem manutenção) para
`@huggingface/transformers@4` — o sucessor mantido. **`npm audit --omit=dev`:
7 vulnerabilidades (1 crítica, 4 altas) → 2 moderadas.**

| Antes | Depois |
| --- | --- |
| `protobufjs` — execução arbitrária de código (**crítica**) | eliminada |
| `onnx-proto`, `onnxruntime-web` (altas) | eliminadas |
| `sharp <0.35.0` — CVEs herdadas do libvips (alta) | `override` para `^0.35.3` |
| `adm-zip <0.6.0` — ZIP forjado aloca 4 GB (alta, via `onnxruntime-node`) | `override` para `^0.6.0` |
| `uuid <11.1.1` via `dockerode` (moderada) | **mantida, com justificativa** |

O `npm` marcava `sharp` e `adm-zip` como "sem correção" porque as versões
corrigidas estão fora do range declarado pelas dependências; `overrides` no
`package.json` resolve. A do `uuid` exigiria forçar um major no `dockerode`
(que declara `^10.0.0`) — e o `dockerode` só chama `uuid.v4()` sem o parâmetro
`buf`, então o caminho vulnerável (bounds check em v3/v5/v6 com `buf`) é
**inalcançável**. Forçar o major arriscaria a execução de código no sandbox
para fechar um risco que não existe aqui.

### A armadilha real: a quantização

A v4 mudou o padrão de `model_quantized.onnx` (int8) para `model.onnx` (fp32).
Aceitar o padrão novo teria dois efeitos silenciosos: o download saltaria de
**113 MB para 470 MB** (com a RAM proporcional, numa VPS pequena) e — pior — os
**vetores mudariam de valor**. Os que já estão no banco e nos artefatos do
Docling foram gerados com o modelo quantizado; a comparação por cosseno passaria
a misturar duas escalas, sem erro nenhum, só recuperação pior.

Correção em três partes:
1. `dtype: 'q8'` fixo (`EMBEDDING_DTYPE`) — exatamente o mesmo arquivo de pesos.
2. A **identidade do vetor** passou a incluir a quantização
   (`Xenova/multilingual-e5-small@q8`). `maybeReindexOnModelChange` compara essa
   identidade, então qualquer mudança futura de modelo OU de quantização dispara
   a reindexação sozinha — antes só o nome do modelo era comparado.
3. Os vetores dos artefatos do Docling ficam **fora** do alcance do `reindexAll`
   (que só cobre `memory` e `conversation_chunks`) e a chave do cache do Docling
   não inclui o modelo. Agora a identidade é gravada junto do `embeddings.json` e
   conferida na leitura; quando não bate, os vetores são descartados e o
   `context.js` cai na seleção por palavras — pior, porém correta.

**Medição, não suposição:** instalando as duas bibliotecas lado a lado e gerando
os mesmos textos, os vetores do `@xenova/transformers@2.17.2` e do
`@huggingface/transformers@4` com `q8` são **bit a bit idênticos** (diferença
máxima por componente 0, cosseno 1,000000). Por isso a identidade legada (sem
sufixo) é aceita como equivalente: **nenhuma instalação existente reindexa nem
reprocessa documento** por causa desta troca.

**Validação:** backend 590 testes (577 ✓, 13 pulados por exigirem PostgreSQL),
frontend 45 ✓, build ✓. Testes novos: `memory/embeddings.test.js` (14) e
`docling/artifacts.test.js` (7), cobrindo identidade, compatibilidade retroativa
e as entradas degeneradas dos artefatos.

---

## O que mudou por último (auditoria PC + Docling, 2026-07-25 — PR #132)

Auditoria de ponta a ponta da integração com o computador do usuário e da camada
documental. Achados corrigidos, com testes de regressão para cada um:

| Área | Achado | Correção |
| --- | --- | --- |
| Execução | `run_python` **não passava por guarda nenhuma** — só o `bash` era validado, e ele era contornável por heredoc | Novo `backend/src/execGuard.js`: mount somente-leitura sem autorização do turno (garantia do Docker), análise linha a linha do Python e auditoria em `companion_audit` |
| Execução | `rm -rf /home` e `/var` passavam pelo padrão antigo | Alvo passa a listar os diretórios de sistema por nome |
| Docling | Progresso calculado e **descartado** — a UI lia `stats.stage`, nunca preenchido (`setStatus` era código morto) | Estágio persistido a cada mudança; barra de progresso no painel |
| Docling | Cancelamento existia no serviço e no runner **sem rota nem botão** | `POST /docling/documents/:id/cancel` de ponta a ponta, com status `canceled` próprio |
| Docling | `pypdf` importado sem estar declarado: a detecção de PDF com senha **nunca rodava** | Declarado no `requirements.txt`; ausência agora é logada |
| Docling | Conteúdo dos documentos não chegava ao **multimodelo** nem ao **Modo Equipe** (modos que não executam ferramentas) | Bloco `document-content` nos três caminhos |
| Markdown | **Perda total de dados**: relatório de 120 páginas virava string vazia; páginas que diferiam só nos valores eram descartadas como duplicatas | `norm()` preserva dígitos; só linhas de paginação são mascaradas; rede de segurança impede esvaziar página com conteúdo |
| Serviço | Cache de resultados sem teto de memória; `_gc_jobs` coletava jobs vivos; hash recebido ignorado | Teto em bytes com LRU; só jobs terminados são coletados; hash conferido |

Causa raiz das duas perdas de dados: mascarar todos os dígitos ao comparar linhas,
num domínio contábil/fiscal em que **o número é o conteúdo**.

Também nesta frente: `CLAUDE.md` (regra permanente de abrir PR ao concluir),
repaginação do README como vitrine do produto, e `docs/CONFIGURACAO.md`.

> Convergência com o PR #133: os dois PRs corrigiram, de forma independente, o
> `destroyAllSandboxes` global que derrubava containers de todos os usuários. Ficou
> a versão da `main` (`destroySandboxesForUser`), mais completa. O `docs/ARQUITETURA.md`
> que esta frente criou foi removido em favor do `docs/ARCHITECTURE.md` do #133.

---

## O que mudou por último (auditoria de produção, 2026-07-25 — PR #133)

| Commit | Assunto |
| --- | --- |
| `78fd482` | Workspace e sandbox escopados por usuário; invalidação direcionada; labels e reconciliação de containers órfãos |
| `1ff3c4f` | Backup com chave mestra + manifesto/checksum/trava; administração persistida em `user_roles` com auditoria |
| `fd70dac` | Uploads por streaming em disco, tetos e cotas; antivírus com status honesto |
| `ad7879c` | CI com PostgreSQL real, migrações, todos os testes do frontend, smoke de boot e portão de autenticação |
| PR seguinte | **F-04 fechado**: serviço `docker-guard` — o backend perdeu o socket do Docker |
| `7a56b1f` | Reorganização da documentação e relatório da auditoria |

Detalhe de cada achado (evidência, causa raiz, correção, testes) em
`docs/AUDITORIA_2026-07.md`.

---

## Correção da memória (Context Builder 3.1, 2026-07-25 — branch `claude/memoria-dominio-conversa`)

Numa conversa de software, "vamos continuar o projeto" recuperava 38 memórias e 20
conversas contábeis (IRPF, aviso prévio, alteração contratual). Duas causas somadas:

1. **Pedido sem palavra-chave desligava o crivo inteiro.** Sem 2 hits de domínio, o
   prompt caía em `general`, o que liberava os quatro domínios e desativava as
   penalidades de desvio. O domínio passa a vir também do **contexto da conversa**
   (modo desenvolvedor com repositório, ou as últimas mensagens do usuário).
2. **O limiar não correspondia à escala do modelo.** O `multilingual-e5-small` nunca
   desce de ~0,79, mesmo para textos sem relação; os pisos eram 0,25/0,30. A
   similaridade passa a ser calibrada (0,80–0,92 → 0..1) antes de virar pontuação e
   antes de ser exibida na interface.

O nome do projeto é deliberadamente ignorado na classificação: "SPED-HUB" é software
mas cai inteiro no dicionário contábil. Detalhe completo, com as medições do modelo,
em `docs/CHANGELOG_HISTORY.md`. Piso configurável por `MEMORY_MIN_SIM`.

### Ao atualizar uma instalação existente para esta versão

1. **Faça backup antes** (`GET /api/backup` — agora leva a chave mestra junto).
2. Suba normalmente. No log do boot, confira as duas linhas novas:
   `[workspace] migração de layout: N movido(s)…` e `[sandbox] reconciliação: …`.
3. Acesse uma rota administrativa uma vez para o papel de admin ser gravado em
   `user_roles` (o `ADMIN_EMAIL` atual continua valendo como bootstrap).
4. Confira em `/api/health` que `sandbox.docker.modo` é `"guarda"` — o backend deve
   alcançar o Docker **só** pelo serviço `docker-guard`.
5. Em instalação PESSOAL com "Pastas do PC" ligadas, ponha também
   `GUARD_ALLOW_PC_FOLDERS=true` no serviço `docker-guard` — do contrário os mounts de
   pastas do host serão recusados (de propósito).
6. Em instalação pública, revise: `CLAMAV_REQUIRED=true`, `ADMIN_USER_ID`,
   `UPLOAD_USER_QUOTA_MB`. Ver `docs/SECURITY.md` §10.

---

## System prompt consolidado (2026-07-25 — branch `claude/system-prompt-review-mte8v0`)

Retomada dos itens 1–3 que ficaram pendentes quando o PR #43 foi fechado (a refatoração
modular invalidou o diff), agora refeitos contra `backend/src/agent/*`:

- **Preâmbulo em poucas mensagens system**, alinhado aos breakpoints do prompt caching:
  `messages[0]` = prompt-base + `QUALITY_BAR` (estável na conversa — breakpoint 1);
  `messages[1]` = nota de ferramentas (**índice reservado**, reescrito quando as
  ferramentas mudam); dados não confiáveis seguem como `user` (`untrustedContext`); e
  UMA mensagem reúne as notas de sistema da chamada, fechando o prefixo estático
  (breakpoint 2). Mesma consolidação no Modo Equipe e no multimodelo. Motivo: vários
  modelos servidos via OpenRouter tratam mal uma pilha de mensagens system.
- **Deduplicação**: caminho de arquivos/downloads e aviso anti-`/mnt/user-data` só na
  `toolAvailabilityNote`; "uma frase antes das ferramentas" só em `EXECUTION_UX_RULES`;
  rede/pacotes/apt só em `SANDBOX_RULES` (o modo Programação perdeu os bullets
  repetidos); checklist final do `QUALITY_BAR` comprimido.
- **Precedência de estilo**: o sufixo dos sliders de personalidade prevalece sobre as
  regras gerais de estilo.
- `PROMPT_RELEASE` → `2026.07.25.1`; módulos `global`/`tools` → `3.2.0`.

**ARMADILHA:** `messages[1]` continua reservado à nota de ferramentas; `QUALITY_BAR`
agora mora DENTRO de `messages[0]` — não voltar a empilhá-lo como mensagem própria.

---

## Continuidade por projeto (Context Builder 4.0, 2026-07-25 — branch `claude/mobile-site-responsiveness-8z0eb9`)

Abrir um chat **novo dentro de um projeto** começava do zero: o agente ignorava as
últimas conversas e decisões e trazia memória antiga sem relação. O 3.1 melhorou o
crivo, mas não podia resolver isto — **não existia vínculo entre projeto, conversa e
memória**. Os projetos do Modo Desenvolvedor viviam só no `localStorage`; o backend
nunca soube a que projeto uma conversa pertencia, então "as últimas conversas deste
projeto" era impossível de consultar. Pesos e limiares não criam um dado que não está
no banco — daí a reincidência ao longo de 3.0, 3.0.1 e 3.1.

- **Migração `018`** — `dev_projects` e `project_id` em `conversations`,
  `conversation_chunks`, `memory` e `memory_suggestions`.
- **Camadas de continuidade** com prioridade acima de tudo (últimas a serem cortadas
  pelo orçamento): identidade e memória permanente do projeto → últimas conversas dele
  → decisões, correções e pendências.
- **`projectLinked`** no scorer: conteúdo do projeto ativo ganha bônus forte e fica
  imune à penalidade de domínio. Recência vale 0,15 (decai em 30 dias) dentro do
  projeto e segue fraca fora.
- Projetos antigos são **adotados** na primeira mensagem — o histórico do navegador
  entra de uma vez, sem reabrir conversa a conversa.
- Só as **tecnologias** do projeto entram na detecção de domínio; nome e descrição
  ficam de fora pelo mesmo motivo já documentado no 3.1 ("SPED-HUB" é software mas cai
  no dicionário contábil).

Todo o 3.1 foi preservado (calibração de similaridade, `softDomain`, `domainsAllowed`,
`DOMAIN_INDEX`, dedup real). O PR #125 foi fechado como superado, com a otimização de
performance dele já incorporada pelo #134.

### 🔴 Corrigido de carona: o Context Builder não rodava

O 3.1 usava `chunksIncluded` sem declarar. O `push` ficava dentro de um `try {} catch {}`
que engolia o `ReferenceError`, e a montagem seguinte — fora do try — derrubava o
`buildContext` inteiro. Como `loop.js` também tem `try/catch` com fallback, a falha era
silenciosa e total: **toda resposta caía no `memoryNote` simples**. Confirmado rodando a
versão do `main`: `ReferenceError: chunksIncluded is not defined`. Corrigido com a
declaração faltante e teste de regressão.

---

## Modo Desenvolvedor no celular (2026-07-25 — mesma branch)

O Modo Desenvolvedor abria quebrado no celular: texto quebrando letra a letra e botões
sobrepostos. O grid de 4 colunas (`barra lateral · explorador · conversa · atividade`)
assumia a conversa sempre na 3ª coluna; no celular a barra lateral vira gaveta
(`position:fixed`) e os trilhos somem, então a conversa caía na 1ª faixa — de **0px** —
deixando a faixa útil vazia. Os pontos de quebra do arquivo (900/1180px) também não
batiam com os 980px do resto do app. Corrigido em `frontend/src/dev-handoff.css`:
até 1180px vira barra lateral + conversa; até 980px, coluna única. Verificado com
renderização real (Playwright) em 360, 393, 600, 900, 1000 e 1300px.

---


## 🧠 Memória: pedido curto desligava o crivo inteiro (Context Builder 3.1) (2026-07-25 — branch `claude/memoria-dominio-conversa`)


**Sintoma relatado:** na conversa do projeto **SPED-HUB** (software), a mensagem
"vamos continuar o projeto" recuperou **38 memórias e 20 conversas antigas** —
IRPF ficha por ficha, redução de aviso prévio, alteração contratual, faturamento
mensal. Nada disso tem relação com o pedido. A interface exibia "similaridade
semântica 85%" para todas.


**Causa 1 — "sem assunto" era lido como "qualquer assunto serve".** `analyzePrompt`
exige 2 hits de palavra-chave para fixar um domínio. "vamos continuar o projeto"
tem ZERO (medido: `{software: 0, accounting: 0, finance: 0}`), então caía em
`domain='general'` — e aí TODA proteção se desligava de uma vez:
`MEMORY_INTENT_MAP.general` liberava os quatro domínios, `diversionRisk` e
`subjectPenalty` eram guardados por `domain !== 'general'`, e `validateRelevance`
saía pela primeira porta. Toda memória de perfil/preferência marcava 0,46 contra
um limiar de 0,25. O `softDomain` do 3.0.1 não alcança este caso: sem nenhum hit,
não há nem inclinação fraca.


**Causa 2 — o limiar não correspondia à escala do modelo.** O
`multilingual-e5-small` não usa a faixa 0..1. Medido com o próprio modelo:
"o gato subiu no telhado" ↔ "balanço patrimonial" dá **0,786**; "vamos continuar
o projeto" ↔ "alteração contratual" dá **0,818**; o par de fato relacionado
("aviso prévio" ↔ "aviso prévio indenizado") dá **0,905**. Os pisos de busca
eram 0,25 e 0,30 — muito abaixo do CHÃO de ~0,79 do modelo —, então nenhum
candidato era descartado e a busca sempre devolvia a cota cheia. Pior: em
`scoreConversation`, `0,40 × 0,85 = 0,34` já passava sozinho do limiar de 0,30.


**Correção:**
- **Domínio vindo do contexto da conversa** (`conversationDomain` no
  contextBuilder → `analyzePrompt(texto, { contextDomain })`). Duas fontes: estar
  em modo desenvolvedor com repositório vinculado (fato estrutural, passado pelo
  `loop.js`/`orchestrator.js` como `developerDomain`) e, na falta dele, as últimas
  12 mensagens do usuário na conversa — com margem folgada (≥4 pontos e o dobro do
  segundo colocado) para não chutar. **O nome do projeto é deliberadamente
  ignorado**: "SPED-HUB" é software, mas cai inteiro no dicionário contábil.
- **Domínios aceitáveis viram um conjunto** (`domainsAllowed`), não um valor único:
  mensagem e conversa podem apontar para lados diferentes de forma legítima —
  perguntar a regra do SPED dentro de um projeto que processa SPED é válido.
- **Sem sinal nenhum deixa de ser passe-livre**: `MEMORY_INTENT_MAP.general` passa
  de quatro domínios para `['general']`, e memória de assunto específico perde os
  bônus estruturais de perfil/preferência — tem de merecer a entrada por
  similaridade ou entidades.
- **Similaridade calibrada** (`calibrateSimilarity`): a faixa útil 0,80–0,92 é
  reescalada para 0..1 antes de virar pontuação, e é a calibrada que a interface
  mostra. Pisos de busca sobem para 0,80 (`MEMORY_MIN_SIM`). A contagem de
  palavras do modo degradado tem escala própria e não é calibrada — daí o
  `_simKind` carregado desde o `memoryService`.


**Efeito medido** (com "vamos continuar o projeto" numa conversa de dev): as três
memórias contábeis vão de 0,46 para −0,44 (barradas); a conversa de alteração
contratual vai de 0,39 para −0,02 (barrada); "O usuário se chama Frederico"
(neutra) e a de experiência em Node.js/Python (mesmo domínio) continuam entrando.
Com um pedido contábil de verdade, as memórias contábeis voltam a entrar — o caso
de controle está preservado.


**Testes:** `relevanceScorer.test.js` 37/37 (+6 de regressão); suíte do backend
460 passam, 2 pulados (exigem PostgreSQL, pré-existente). Os fixtures de
similaridade foram corrigidos para a escala real do e5 — estavam numa escala
0..1 que o modelo nunca produz.


## 🔧 Correções do Context Builder 3.0.1 — dedup real, vazamento de domínio e performance (2026-07-24 — branch `claude/conversation-memory-changes-i2i4vz`)


**Contexto:** revisão do Context Builder 3.0 (recuperação de memória/conversa no
início da conversa). A arquitetura estava boa, mas a revisão encontrou três
defeitos concretos que faziam a funcionalidade não cumprir a promessa em casos
comuns. Corrigidos aqui.


**Bugs corrigidos:**

1. **Deduplicação morta (não deduplicava nada).** Em `contextBuilder.js`, o
   resultado de `deduplicateContext(...)` era descartado — só o `.length` virava
   contador de diagnóstico. Os blocos enviados ao modelo nunca eram filtrados, ou
   seja, duplicatas continuavam indo no prompt. **Correção:** os itens agora são
   coletados primeiro, deduplicados **de verdade** em ordem de prioridade
   (perfil → notas → relevantes → conversas) e só então viram texto.

2. **Vazamento do filtro de domínio em pedidos curtos (falha do objetivo central).**
   O domínio só era classificado com **≥2 keyword-hits**; pedidos reais e curtos
   ("dá uma olhada no app e encontra bugs") caíam em `domain='general'`, o que
   desligava a penalidade de desvio, a checagem de `validateRelevance` e liberava
   todos os domínios via `MEMORY_INTENT_MAP['general']`. Resultado: memória
   contábil fixada/importante voltava a entrar num pedido de software (o exato
   problema que a 3.0 dizia corrigir). **Correção:** novo conceito de **domínio
   efetivo** — quando não há domínio forte, usa-se a **inclinação fraca**
   (`softDomain`, argmax dos hits mesmo abaixo de 2). O crivo passa a operar sobre
   o domínio efetivo em `scoreMemory`, `scoreConversation` e `validateRelevance`.
   Também foram adicionadas palavras-chave de **UI** (layout, tela, login, botão,
   menu, formulário, painel, responsivo…) para reduzir pedidos de "sinal zero".

3. **Typo de copy-paste** em `relevanceScorer.js`: `chunk.created_at || chunk.created_at`
   (fallback repetia o mesmo campo) → `chunk.created_at || chunk.updated_at`.

4. **Performance:** `detectContentDomain` renormalizava ~500 palavras-chave a cada
   chamada (e é chamado várias vezes por candidato). Agora as keywords são
   normalizadas **uma vez** no carregamento do módulo (`DOMAIN_INDEX`, com RegExp
   de fronteira pré-compiladas para termos curtos) e há uma função única
   `scoreDomains()` usada por `analyzePrompt` e `detectContentDomain`.


**Arquivos:**
- `backend/src/memory/relevanceScorer.js` — domínio efetivo/`softDomain`,
  `DOMAIN_INDEX` pré-computado, keywords de UI, correção do typo
- `backend/src/memory/contextBuilder.js` — dedup real antes de montar os blocos
- `backend/src/memory/relevanceScorer.test.js` — +4 testes de regressão
  (vazamento em prompt curto, controle contábil, `softDomain`, keywords de UI)


**Validação:** `relevanceScorer.test.js` → 31/31; `contextBuilder.test.js` → 1
pulado (exige PostgreSQL, pré-existente); verificação empírica: memória contábil
não entra mais em pedidos curtos de software (score cai para −0.25) e continua
entrando em pedidos contábeis reais (score 0.69).


## 🌱 Redesign do copiloto: o personagem agora é o Nino (2026-07-25 — branch `claude/nino-copilot-redesign`)


**Motivação:** o personagem era um "orb" azul genérico com antena — dois olhos, uma
boca e sete estados que quase não se distinguiam entre si. Ele não comunicava o que
o Studio estava fazendo (`pensando` e `executando` eram visualmente parecidos) nem
tinha identidade própria. O redesign troca a apresentação inteira, sem mexer em
NADA da mecânica: arrastar com posição no `localStorage`, minimizar, níveis de
animação, fila de eventos, isolamento do chat do copiloto e o balão proativo de
revisão continuam exatamente como estavam.


**O personagem (`components/NinoAvatar.jsx` + `nino.css`, ambos novos):** corpo
super-arredondado em terracota com broto de folha no topo, olhos grandes que
acompanham o cursor, bochechas coradas, 6 formas de boca e um halo que comunica
urgência sem texto. Exporta `NinoAvatar` (props `state`, `name`, `quiet`) e
`NINO_CAPTION` (a legenda de cada estado). Cutucar o personagem gera uma reação
com fala curta — o `pointerdown` NÃO é consumido, então arrastar/abrir seguem
funcionando no mesmo evento.


**Máquina de estados mais fina (`Companion.jsx`):** o que era um par
`pensando`/`executando` virou `pensando` (sem pista), `analisando` (ferramenta,
sandbox, arquivo, planilha) e `digitando` (escrita/resposta em stream), lidos do
`statusText` que o chat já publicava — nada de estado inventado. `alerta` se
separou em `sugestao` (aviso real ou balão oferecendo revisão) e `duvida` (eventos
não lidos sem gravidade); `ausente` saiu porque não era alcançável. O balão de
revisão agora avisa o personagem via `onPhase`, então ele reage junto. No celular,
após 8s de ociosidade o personagem encolhe e se encosta na borda direita — qualquer
toque ou tecla o traz de volta.


**Painel e configuração:** `CopilotWorkspace.jsx` põe o personagem no cabeçalho com
a legenda do estado ao vivo, carinha ao lado de cada resposta e no indicador de
digitação, e estados vazios com ele no lugar de ícones genéricos; as abas viraram
"Conversa/Documentos" em pílula. `CompanionConfig.jsx` ganhou prévia ao vivo (reage
ao nível de animação e a cliques antes de salvar) e uma dica por nível.


**Nome padrão:** `Nino` no `useCompanion.js`, no `COMPANION_DEFAULTS` do backend e
como primeiro preset em `CHARACTER_PRESETS`. O campo segue livre — quem já salvou
outro nome não é afetado, porque o valor persistido tem prioridade sobre o padrão.


**Desempenho e acessibilidade:** só `transform` e `opacity` animam (nenhum
`filter`/`blur` em laço). O olhar usa UM listener passivo por instância com o centro
do personagem em cache (recalculado só em `scroll`/`resize`) — sem re-render do
React e sem leitura de layout por pixel. O nível "nenhum" (prop `quiet`) desliga
listener, piscada e movimento, mas mantém as EXPRESSÕES, porque é a expressão que
carrega o significado do estado. `prefers-reduced-motion: reduce` desliga tudo
sozinho, no CSS. Foco de teclado com anel próprio de 2px na cor do personagem.


**Limpeza:** o bloco do avatar antigo saiu do `companion.css` (`.cmpAvatarWrap`
original, `.cmpAvatar`, `.cmpPulse`, todas as regras `.state-*`, o bloco de nível de
animação e os `@keyframes cmp*` do personagem). O restante do arquivo — painel,
alertas, formulário, balão e tema claro — ficou intacto e recebeu no fim o ajuste
de cores/tamanhos do novo personagem.


**Validação:** build do frontend ✓; `node --test src/*.test.js` → 29/29; backend
`node --test 'src/**/*.test.js'` → 450 passam, 2 pulados (exigem PostgreSQL,
pré-existente).


## 🚀 Botões de GitHub no modo desenvolvedor: "Enviar para o GitHub" e "Continuar no repositório" (1 clique) (2026-07-25 — PR #129, branch `claude/dev-github-buttons`)


**Motivação:** enviar o trabalho de uma conversa de dev ao GitHub dependia de
duas condições nada óbvias — estar num MODO DE ESCRITA (build/fix/auto) E a
mensagem AUTORIZAR o push com palavras soltas (`explicitlyAuthorizesGitWrite`). Se
faltasse alguma, as ferramentas `github_push`/`github_create_pr` nem apareciam e o
modelo caía no `git push` pelo bash do sandbox (que falha de propósito — sem
credencial lá), às vezes sugerindo ao usuário rodar `git push` num caminho que só
existe DENTRO do sandbox. Resultado: commit pronto no workspace e nenhum jeito
óbvio de subir.


**Correção — ação determinística por botão, sem IA:**
- Backend `routes/conversations.js`: dois endpoints escopados por conversa (posse
  checada) — `POST /conversations/:id/github/clone` e `.../github/push` — que
  chamam `runGithubTool('github_clone'|'github_push', …)` DIRETO no backend, com o
  token do usuário. Sem passar pelo modelo, sem depender de modo/frase, sem gastar
  tokens. O push devolve `needsCommitMessage` quando há mudanças pendentes, para o
  front pedir a mensagem e repetir.
- Frontend `App.jsx`: na barra do modo desenvolvedor, quando há repositório
  vinculado, dois botões — **"Continuar no repositório"** (clone/atualiza nesta
  conversa) e **"Enviar para o GitHub"** (commit se preciso + push). Estado de
  carregando por botão; ao faltar mensagem de commit, pede via `askPrompt` e
  repete. `styles.css`: estilo dos botões.


**Efeito:** o caso clássico "o commit já está pronto no workspace e só falta o
push" vira **1 clique**. Combina com o PR #127 (que restaura o vínculo do repo ao
reabrir a conversa): reabre → clica em "Enviar para o GitHub" → sobe.


## 🔑 ENCRYPTION_KEY automática (self-hosted sem terminal) + correção do repositório sumindo no modo dev (2026-07-24 — PRs #127 e #128)


**Correção do modo dev (PR #127 — branch `claude/dev-mode-repo-persist`):** ao
reabrir uma conversa de projeto, o vínculo com o repositório GitHub (repo/branch),
o modo e as regras eram PERDIDOS — `openConversation` zerava `developerSession` e
nada o reconstruía. Sem `developer.github`, o backend não recebia o vínculo e o
agente dizia "não encontro o repositório", travando o desenvolvimento (o clone
seguia no workspace da conversa em disco; o agente só deixava de saber que
existia). Agora a sessão é RECONSTRUÍDA a partir do projeto dono (persistido no
navegador com seus `conversationIds`) — mesmo padrão que já restaurava o modelo da
conversa. Novo helper puro `developerSessionForConversation` (com teste), resolver
via ref em `useConversations`, e volta ao workspace de desenvolvimento.


**ENCRYPTION_KEY automática (PR #128 — branch `claude/auto-encryption-key`):**
antes, a `ENCRYPTION_KEY` (que cifra token do GitHub + chaves de API por usuário)
era obrigatória no `.env` e, se mudasse entre deploys, os segredos ficavam
ilegíveis ("perdi o acesso ao GitHub"). Complicado demais para o usuário comum que
apenas instala o app. Agora `backend/src/crypto.js` resolve a chave por
prioridade: (1) env `ENCRYPTION_KEY` se definida (SaaS/secret manager); (2) senão,
o arquivo `DATA_DIR/encryption.key`; (3) senão, gera uma e a PERSISTE nesse arquivo
(0600) — no MESMO volume do banco. Resultado: `docker compose up` funciona de
primeira, sem `openssl`/terminal, e a chave fica estável entre reinícios (lida
sempre do arquivo, nunca regenerada à toa; arquivo inválido lança em vez de
sobrescrever). `.env.example`/README documentam que a env é opcional e tem
prioridade. Decisão pura `chooseKeyHex` testada + teste e2e da geração/persistência.


## 🤖 Copiloto com espaço próprio: Chat + Documentos isolados, config nas Configurações e balão proativo de revisão (2026-07-24 — PR #126, branch `claude/copilot-refactor`)


**Contexto:** o "copiloto" estava espalhado em três peças diferentes e com papéis
misturados: o **avatar flutuante** (Companion) cuja engrenagem abria um modal de
configuração do personagem; um **painel técnico** separado (Diagnósticos/Saúde/
Permissões); e o **PromptCoach**, que oferecia revisão de prompt durante a
digitação no chat principal. Além disso, o avatar não tinha cérebro próprio — o
envio rápido dele delegava ao `sendMessage` do chat principal, sem contexto,
memória nem armazenamento próprios. A reorganização (R1–R4) dá ao copiloto um
**espaço próprio e isolado**.


**Mudanças:**
- **R1 — Configuração sai do avatar → Configurações.** Removido o modal
  `CompanionSettings` e o painel rápido do avatar. Nova tela **Configurações ›
  Agente › "Copiloto — Personalização"** (`CompanionConfig.jsx`): personagem,
  persona, modelo, modo, proatividade e animação. O painel técnico continua em
  **"Copiloto — Diagnósticos"**. Clicar no avatar passa a abrir **apenas** o
  painel do copiloto (abas Chat e Documentos).
- **R2 — Balão proativo de revisão de escrita.** O avatar observa o rascunho do
  chat principal e, após uma pausa (`PAUSA_MS=3000`) + tamanho mínimo
  (`MIN_CHARS` por sensibilidade), oferece revisar (**Sim / Agora não**). Aceitar
  chama `/api/copilot/revise` e mostra um **cartão clicável** que substitui o
  texto pelo revisado. Frases sorteadas sem repetir, Esc/clique-fora fecham,
  cooldown por rascunho. Removida a faixa do PromptCoach do compositor (não há
  mais oferta de prompt durante a digitação); as 10 ações de prompt foram
  preservadas **dentro do chat do copiloto**.
- **R3 — Chat com contexto 100% isolado.** Novas tabelas
  `copilot_conversations`/`copilot_messages` (migration `018`), separadas de
  `conversations`/`messages`. Backend `copilot/core.js` (puro) + `copilot/store.js`
  + rotas `/api/copilot/chat` (GET/POST/DELETE) com persona dedicada. O isolamento
  é garantido em `buildChatMessages` (só `system` + histórico do **próprio**
  copiloto — nunca a conversa principal nem a memória dela).
- **R4 — Caixa de documentos própria.** Nova tabela `copilot_documents`
  (migration `019`), separada dos anexos das conversas (`files`). Rotas de
  listar/ver/baixar/excluir e criação automática dos textos revisados pelo balão.
  Aba Documentos com estados vazio/carregando/lista.


**Decisões de engenharia:**
- O copiloto usa o **mesmo provedor de IA do usuário** (`getUserProvider`), com o
  modelo definido na config do Companion (`settings.model`; vazio = provedor
  padrão). Sem chave configurada, o chat/revisão respondem com mensagem amigável
  em vez de erro.
- O chat mantém **uma thread contínua por usuário** (MVP), com botão de limpar
  histórico. Documentos guardam o conteúdo textual inline na tabela.
- O painel técnico (Diagnósticos/Saúde/Permissões) foi **mantido** — o prompt não
  pedia removê-lo e ele já vivia nas Configurações, não no avatar.


**Arquivos:**
- Backend: `migrations/018_copilot_chat.sql`, `migrations/019_copilot_documents.sql`,
  `src/copilot/core.js`, `src/copilot/core.test.js`, `src/copilot/store.js`,
  `src/routes/copilot.js`, `src/routes/companion.js` (novos campos
  `proactiveWriting`/`writingSensitivity`), `src/server.js` (monta o router).
- Frontend: `Companion.jsx` (reescrito — avatar abre o painel + balão proativo),
  `components/CopilotWorkspace.jsx` (abas Chat/Documentos), `components/CompanionConfig.jsx`,
  `hooks/useCopilotChat.js`, `hooks/useCompanion.js`, `components/SettingsHub.jsx`,
  `App.jsx`, `companion.css`. Removido `components/PromptCoach.jsx` (órfão).


**Validação:** Postgres real — migrations `001`–`019` aplicam limpas; E2E do
`store` contra o banco confirma **isolamento por usuário** (um usuário não lê/apaga
dados de outro) e o CRUD de chat e documentos; testes unitários do núcleo
(`core.test.js`, incluindo o invariante de isolamento das mensagens) e
`sanitizeSettings` verdes; build do frontend OK. Não exercitado ponta a ponta: a
chamada real ao provedor de IA (sem chave no ambiente) — as peças em volta estão
testadas.


## 🎚️ Roteamento OpenRouter: qualidade × resiliência + transparência de troca de modelo (2026-07-24 — PR #124, branch `claude/open-router-provider-lock-6iywu6`)


**Contexto:** investigação a partir de uma reclamação de que um app agêntico via
OpenRouter parecia **trocar de modelo silenciosamente** (DeepSeek V4 Pro → V3)
durante a execução. A análise do código + dos dados reais da API pública do
OpenRouter (`/models/<slug>/endpoints`) mostrou **dois fenômenos distintos**:
(1) o OpenRouter balanceia cada requisição entre vários provedores do MESMO
modelo, e esses provedores rodam o modelo em **precisões diferentes**
(quantização) — as faixas agressivas (`int4/int8/fp4/fp6`) degradam a qualidade;
(2) a "troca de modelo" relatada **não era downgrade da tarefa**: a conversa
rodou inteira no modelo escolhido, e as chamadas pequenas a um modelo mais barato
eram a **extração de memória em segundo plano** (`indexer.js` / `EXTRACT_MODEL`,
default `deepseek/deepseek-chat`), cobrada ao preço correto e apenas misturada no
Activity do OpenRouter.


**Correção:**
- **`agent/provider.js` — `openRouterRouting`:** meio-termo qualidade × resiliência.
  `allow_fallbacks: true` mantém a resiliência (reroteia só entre provedores que
  ainda atendem o filtro de qualidade, em vez de falhar) e `quantizations`
  (padrão `fp8,fp16,bf16,fp32,unknown`) exclui só a compressão agressiva sem
  prender a um provedor único. `unknown` fica na lista porque modelos reais em uso
  (ex.: `gpt-4o`) só têm provedores `unknown` e ficariam sem endpoint se fossem
  excluídos. Ajustável por ambiente: `OPENROUTER_QUANTIZATIONS` (inclui `off` e a
  precisão cheia `bf16,fp16,fp32`) e `OPENROUTER_ALLOW_FALLBACKS=0` (trava no
  provedor preferido — erro em vez de troca de provedor).
- **`memory/indexer.js`:** as chamadas de extração de memória passam a herdar o
  mesmo `openRouterRouting` das respostas principais — o filtro de qualidade
  (evita `fp4` etc.) vale também no segundo plano.
- **`agent/loop.js`:** quando um failover troca o modelo no meio da execução, a
  troca é registrada **na própria resposta salva** (antes só havia um status
  efêmero que sumia — por isso "só se notava depois"). Compara o modelo final com
  o inicial (`startedModel`) e anexa uma nota explicando qual reserva concluiu e
  como desativar a troca automática (`MODEL_FALLBACKS`).


**Decisão de engenharia:** a extração de memória **continua** num modelo barato
(configurável via `EXTRACT_MODEL`), não no modelo premium da conversa — ela roda a
cada resposta e usar um modelo caro multiplicaria o custo sem benefício visível;
agora apenas com a mesma proteção de qualidade das respostas principais.


**Arquivos:**
- `backend/src/agent/provider.js` — filtro de quantização + `allow_fallbacks`
- `backend/src/agent/provider.promptCache.test.js` — testes do roteamento (padrão,
  modo estrito, trava de provedor, filtro desligado)
- `backend/src/memory/indexer.js` — roteamento de qualidade nas 2 chamadas de extração
- `backend/src/agent/loop.js` — nota persistente de troca de modelo
- `.env.example`, `README.md` — `OPENROUTER_QUANTIZATIONS` e `OPENROUTER_ALLOW_FALLBACKS`


**Validação:** suíte completa do backend → 434 pass / 2 skipped / 0 falhas;
`node --check` nos arquivos alterados + verificação de import (sem ciclo).


## 🎯 Filtro de relevância por domínio na recuperação de contexto — Context Builder 3.0 (2026-07-24 — PR #120, merge `31303fd`)


**Problema:** a recuperação de contexto (memórias + conversas antigas) injetava
material irrelevante nos pedidos. Ex.: memórias de domínio **contábil** entravam
num pedido de **desenvolvimento de software**, poluindo o contexto e gastando
tokens à toa. Causas: injeção incondicional de memórias de perfil/pinned,
limiares semânticos baixos demais, peso excessivo de recência e preenchimento
por cota (encher o orçamento mesmo sem relevância real).


**Correção:** novo módulo **puro** `backend/src/memory/relevanceScorer.js` (sem
I/O nem DB) que pontua cada memória e conversa antiga por **domínio**
(software / contábil / financeiro / geral, com penalidade para domínio
incompatível), **intenção**, **projeto**, **entidades** do prompt e
**similaridade semântica**. Limiares separados (memória `0.25`, conversa `0.30`),
validação de relevância, deduplicação e extração de trecho relevante. O
`contextBuilder.js` (Context Builder 3.0) passa a filtrar o material recuperado
por essas pontuações antes de montar o contexto.


**Arquivos:**
- `backend/src/memory/relevanceScorer.js` — novo, módulo puro
- `backend/src/memory/relevanceScorer.test.js` — novo, 27 testes
- `backend/src/memory/contextBuilder.js` — integra o scorer (v3.0)
- `frontend/src/components/MemoryTrace.jsx` — MemoryTrace 3.0: rótulo do botão por
  tipo de contexto recuperado (memórias / conversas / ambos) + motivo por item


**Validação:** `relevanceScorer.test.js` → 27/27; suíte completa do backend →
417 pass / 2 skipped / 0 falhas; `vite build` do frontend limpo (`dist`
reconstruído). Origem: correção feita por um agente no sandbox de dev (sem rede
para push); os arquivos foram trazidos e publicados a partir do ambiente com rede.


## 🩺 Correção de watchdog de streaming (C7) + métricas de saúde no healthcheck (C8) (2026-07-24 — branch `main`, commit `d393640`)


**Contexto:** auditoria técnica (`AUDITORIA_TECNICA_FREDERICO_AI_STUDIO.md`) 
listou 10 problemas; dois foram corrigidos nesta rodada (os de curto prazo 
factíveis sem reestruturação).


### C7 — Unificar watchdogs de streaming (backend como fonte de verdade)


**Problema:** o frontend tinha `SSE_STALL_MS = 60000` (60s) e o backend tinha 
`guardStreamStall` (180s). Como o timeout do frontend era menor, ele abortava 
antes do backend, gerando falsos positivos — o usuário via "stream travado" 
quando na verdade o modelo só estava pensando (ex.: DeepSeek R1 com <think> 
longo, ou o primeiro token de um modelo lento em pico de uso).


**Correção:** `SSE_STALL_MS` do frontend (`frontend/src/hooks/useChat.js`) 
subiu de 60s → 300s (5 min). O backend (`guardStreamStall` em 180s) continua 
sendo a fonte de verdade — ele tem visibilidade real do socket e do heartbeat 
do provedor. O frontend agora é apenas um **fallback de conexão TCP perdida** 
(se o EventSource morrer sem notificar, o timeout de 5 min evita que o chat 
fique pendurado para sempre). Comentário documentando a hierarquia de duas 
camadas adicionado no hook.


### C8 — `unhandledRejection` counter + healthcheck


**Problema:** `process.on('unhandledRejection')` no `server.js` só dava 
`console.error`, sem visibilidade em produção. Se promessas começassem a 
vazar (ex.: após um deploy com bug), ninguém saberia até o processo crashar 
por memória ou o event loop ficar lento.


**Correção:** novo módulo `backend/src/healthMetrics.js` exporta objeto 
`{ unhandledRejections, bootAt }`. O handler de `unhandledRejection` em 
`server.js` incrementa o contador. O endpoint `GET /api/health` 
(`backend/src/routes/account.js`) agora inclui `bootAt` e `unhandledRejections` 
na resposta — compatível com versão anterior (campos adicionados, nenhum 
removido). Assim um monitor externo (Uptime Kuma, Healthchecks.io, Grafana) 
pode alertar quando `unhandledRejections > 0`.


**Arquivos modificados:** `frontend/src/hooks/useChat.js`, 
`backend/src/server.js`, `backend/src/routes/account.js`. 
**Arquivo novo:** `backend/src/healthMetrics.js`.


**Validação:** `node --check` nos 3 arquivos backend; suíte `streamGuard.test.js` 
(6/6 passando); `curl /api/health` confirmando os novos campos. 
Commit direto em `main` (sem PR).


**Pendências da auditoria (médio prazo, não mexidas):** React Router (C1/C6), 
projetos no banco (C3), prompt modular (C5), proxy de containers (C9).


## 🔒 Revisão dos PRs #102–#107 (Companion + Docling): isolamento, churn de sandbox e contradição de prompt (2026-07-23 — branch `claude/steps-count-bug-v879qz`)

Análise completa do código novo (Companion fases 1–2, Docling fases 1–2,
launcher). Quatro correções aplicadas:

1. **SEGURANÇA (grave) — posse no monitor de Git do Companion:**
   `POST /companion/monitor/git` só validava o FORMATO do `conversationId`;
   qualquer usuário logado com o id de uma conversa alheia lia branch +
   arquivos alterados do workspace de outro dono (e fazia o servidor criar um
   container para isso). Agora a rota exige posse
   (`WHERE id=? AND user_id=?` → 404), como manda a regra multi-tenant.
2. **Recursos/VPS — monitor OBSERVA, não cria:** `inspectGit` usava
   `execInSandbox`, que (a) MATERIALIZAVA um container a cada ciclo de polling
   (90 s) quando não havia um, e (b) pior: com opções default, DERRUBAVA e
   recriava um sandbox ativo de política diferente (`getContainer` troca o
   container quando a policyKey não bate) — podia matar um sandbox do modo dev
   no meio do trabalho. Novo `execInActiveSandbox` (sandbox.js): executa SÓ se
   já houver sandbox ativo, nunca cria/troca/mata, não estende o lastUsed
   (observar não deve impedir o reaper) e no timeout apenas desiste da leitura.
   Sem sandbox → `{ isRepo:false, noSandbox:true }`.
3. **Contradição de prompt (Docling ligado):** a `uploadsNote` (system) manda
   extrair anexos com ferramentas; o contexto do Docling manda NÃO reextrair —
   e `mustInspectUploads` ainda FORÇAVA `tool_choice='required'`. Mesma classe
   do bug "não tenho acesso ao GitHub" (2026-07-22). Agora: nota de
   precedência `DOC_PRECEDENCE_NOTE` (context.js) publicada entre as duas
   ("pré-processados usam o conteúdo fornecido; ferramentas valem para os
   demais anexos e para cálculos/conversões"), a nota do Docling é escopada
   aos documentos listados, e `mustInspectUploads` não força ferramenta quando
   o conteúdo documental já foi injetado.
4. **Botão "Reprocessar" do Docling era no-op:** com a mesma config, o
   `processFile` devolvia o cache (early-return) e nada reprocessava. Agora a
   rota passa `force:true` e o `processFile` ignora o cache nesse caso; o hash
   usa `f.hash || row.hash` (arquivos antigos sem hash na tabela files).

**Registrados sem correção (menores):** docling-service ignora `ocr:auto|never`
(`do_ocr=True` sempre — a config prometida entra no config_version mas não é a
efetiva); `inbox.js` insere em files sem hash/mime (anexos do inbox ficam fora
do Docling — o fallback cobre); `selectChunks` não inclui chunks sem match "se
sobrar espaço" (comentário promete, código não faz); no caminho "documento
completo" as páginas vão como `<!-- page: N -->` e o modelo pode não citá-las;
definir `DOCLING_INTERNAL_TOKEN` no .env da VPS ao ligar o Docling.

**Validação:** `node --check` em todos os arquivos tocados; suíte
`node --test` → 337 testes, 335 pass, 0 fail (inclui teste novo do
`inspectGit` sem sandbox). Nenhuma migração nem mudança de frontend.

## 🔁 FIM do "limite de N etapas" em tarefa produtiva — fôlego automático + retomada na pipeline (2026-07-23 — branch `claude/steps-count-bug-v879qz`)

**Sintoma (com print):** pipeline multimodelo ("Especialistas em sequência"), a
etapa 2 (Revisão especializada, Kimi K3) morre com _"A tarefa atingiu o limite
de 90 etapas antes da conclusão"_ e o estágio vira **"● Erro"** — no MEIO de
trabalho legítimo (inspecionando/corrigindo um .xlsx, 11,4M tokens, 84 min).
Bug "consertado várias vezes" (PR #58 subiu 60→90) mas sempre voltava, porque
as correções mexiam no NÚMERO, não no MODELO do limite.

**Causa raiz (por que o Claude Code não sofre disso):** ferramentas maduras de
agente NÃO limitam por contador de etapas — os freios são de **falta de
progresso** (repetição, falhas seguidas, estagnação) e o contexto é
**compactado** quando cresce. Aqui, qualquer teto fixo (60, 90, 200…) sempre
será alcançado por uma tarefa pesada honesta: cada etapa = 1 turno do modelo
(~1 ferramenta), e revisar uma planilha real consome dezenas de turnos. Dois
agravantes: (1) o loop abortava a tarefa **ainda produtiva** ao bater
`hardMaxSteps`; (2) na pipeline multimodelo o `step_limit` era terminal — o
estágio virava Erro e a sequência parava, pois o botão "Continuar" do chat não
existe dentro do quadro multimodelo (o checkpoint ficava salvo sem ninguém usar).

**Correção (modelo novo, não número novo):**
- **`loop.js` — fôlego automático:** `hardMaxSteps` passa a valer por JANELA.
  Ao bater o teto com progresso recente (o mesmo sinal `lastProductiveStep`/
  `IDLE_STEP_GRACE` de antes), o loop **compacta o histórico**
  (`trimCheckpointMessages`, o mesmo apara do checkpoint — preserva preâmbulo
  de sistema + cauda recente) + injeta `AUTO_CONTINUE_NOTE` (checkpoint.js) e
  **renova a janela de orçamento**, até `AGENT_MAX_AUTO_CONTINUES` vezes
  (padrão 6; 0 desliga = comportamento antigo). É o que o "Continuar" faria,
  sem parar. Estagnação, 5 falhas seguidas, degeneração e limites de pesquisa
  web continuam encerrando como antes. Mensagem de limite agora cita o total
  REAL de etapas executadas.
- **`multiModel.js` — retomada automática da etapa:** se mesmo assim uma etapa
  da pipeline terminar `resumable` por `step_limit`, o orquestrador recarrega o
  checkpoint (`loadCheckpoint`) e chama `runAgent({ resume })` de novo, até
  `PIPELINE_STAGE_RESUME_LIMIT` vezes (padrão 2), antes de marcar Erro. Só
  `step_limit` retoma na hora (falha de provedor já esgotou a cadeia de reserva).
  Usage somado UMA vez no final (o resume acumula o consumo anterior — somar a
  cada tentativa duplicaria).
- **Custo/latência:** a compactação também resolve o crescimento sem fim do
  array `messages` (era reenviado inteiro a cada turno — daí 11,4M tokens);
  janelas seguintes partem de um contexto aparado.
- Docs: `.env.example` + tabela do README com as duas variáveis novas.

**Regra para não regredir:** NUNCA "resolver" limite de etapas aumentando o
número. Tarefa produtiva não morre por contador; morre por falta de progresso.
Os tetos são para-raios, e a resposta ao teto é compactar + continuar.

## 🐛 Corrige "conecto o GitHub e a IA diz que não tem acesso" (2026-07-22 — branch `claude/resumo-alteracoes-tres-dias-vukd8t`)

**Sintoma relatado (com print):** no Modo Desenvolvedor, com um repositório
GitHub selecionado, a IA respondia que **"não tem acesso ao GitHub"** e às vezes
a execução terminava com o selo **"● Erro"**. O usuário suspeitou (corretamente)
que era bug do app, não do OpenRouter.

**Causa raiz encontrada (contradição interna do app):**
1. O prompt do modo desenvolvedor mandava **clonar** (`prompts.js`, "PRIMEIRO
   PASSO OBRIGATÓRIO: chame github_clone") sempre que um repo estava
   *selecionado* — independente de haver conexão.
2. Mas as ferramentas `github_*` só eram entregues ao modelo se
   `hasGithubConnection(userId)` fosse verdadeiro (`loop.js`).
3. Quando os dois discordavam (repo selecionado + conexão ausente), o modelo era
   mandado usar uma ferramenta **que não estava na lista dele** → respondia o
   "não tenho acesso" genérico.
4. Agravante: `getGithubConnection` (`connectors/github.js`) engolia **qualquer**
   erro em silêncio (`catch { return null }`, e `if (!token) return null` quando
   a descriptografia falhava) — então, se a `ENCRYPTION_KEY` mudou entre deploys,
   o usuário aparecia "conectado" no banco mas o app o tratava como desconectado,
   **sem nenhum log** apontando a causa.

**Correções aplicadas:**
- **`loop.js`**: consulta `hasGithubConnection` UMA vez, passa `{ githubConnected }`
  para `developerContextFor` e reaproveita no gate das ferramentas (fim da
  consulta dupla ao banco).
- **`prompts.js`** (`developerContextFor(request, userId, opts)`): quando há repo
  selecionado mas **sem conexão**, a nota deixa de mandar clonar e passa a
  instruir o modelo a explicar objetivamente que o usuário precisa **reconectar
  em Configurações → Conectores** — em vez do "não tenho acesso" confuso. Default
  `githubConnected=true` preserva os demais chamadores (orchestrator/multiModel).
- **`connectors/github.js`**: `getGithubConnection` passa a **logar** os dois
  casos antes engolidos — token que não descriptografa (ENCRYPTION_KEY mudou) e
  erro de banco — distinguindo "nunca conectou" de "conexão quebrada".

**Sobre o selo "● Erro" (sintoma separado):** vem de um `throw` de erro de
provedor no `loop.js` (não é incompatibilidade de ferramentas — essa já é
tratada sem erro, "respondendo em texto"). Provável erro do provedor do modelo
escolhido (ex.: Kimi K3) ao receber ferramentas. **Não** foi alterado às cegas —
depende do texto real do erro para classificar sem regressão; fica registrado
como próximo passo caso persista com modelos específicos.

**Testes:** `prompts.dev.test.js` ganhou 3 casos (conectado manda clonar; sem
conexão pede reconexão e não emite o comando de clone; sem opts preserva o
comportamento antigo). Suíte completa: **179 testes, 177 passam, 0 falham**, 2
pulados (Postgres).

## 🔎 Auditoria cruzada Git × CONTINUIDADE + registro de lacunas (2026-07-22 — branch `claude/resumo-alteracoes-tres-dias-vukd8t`)

**Pedido:** o usuário achou o app "muito bugado" e pediu um resumo detalhado de
tudo que foi feito, e depois uma **conferência cruzada** entre o histórico real
do Git (PRs #18→#77) e este arquivo, para auditar e melhorar o `CONTINUIDADE.md`.

**Método:** listei os 59 PRs do histórico do Git e cruzei um a um contra as 30
seções deste arquivo (busca por palavra-chave + leitura de contexto).
**Resultado:** o arquivo não inventa nada e cobre ~90% do trabalho, mas
encontrei **4 frentes que entraram no código e não tinham registro aqui** — são
lacunas de OMISSÃO, não de divergência (as features existem no app; só não
estavam anotadas). Registradas abaixo, com detalhe, para fechar as lacunas.

**Nota de numeração:** o histórico deste repositório **começa no PR #18**
(18/07/2026, "Câmera no chat"). Os PRs **#1–#17 não existem neste repositório**
(predatam o histórico atual) e o **#43 foi fechado como superado** pela
modularização do backend (ver primeira seção de 07-21). Ao auditar cronologia,
lembrar que datas de seção às vezes são a data de AUTORIA da branch, enquanto o
merge do PR ocorreu 1 dia depois (ex.: "Catálogo de modelos" rotulado 07-20,
PR #55 mergeado 07-21).

### 💾 Cache — prompt caching, embeddings, CNPJ e busca web (PR #57, 2026-07-20) — LACUNA PREENCHIDA

A memória de longo prazo já preservava contexto; faltava a camada de **CACHE**
para reduzir custo de tokens, evitar chamadas externas repetidas e acelerar
respostas. Utilitário único `backend/src/cache.js` (TTL + LRU, sem dependências)
aplicado em 4 frentes:
1. **Prompt caching do LLM** (`provider.applyPromptCache`): marca o preâmbulo
   estável (prompt-base + notas de sistema) com `cache_control` para o provedor
   reaproveitar entre mensagens/etapas — menos tokens de ENTRADA e menor
   latência. Só onde é seguro: via OpenRouter para Anthropic/Gemini. A API
   direta da DeepSeek já cacheia sozinha (não recebe `cache_control`).
   `usage.cached_tokens` passa a ser contabilizado. Ligado no agente único e nos
   3 pontos do Modo Equipe.
2. **Embeddings** (`memory/embeddings.js`): memoiza por `hash(kind, texto)` — a
   mesma pergunta não é re-embedada a cada mensagem.
3. **Consulta de CNPJ** (`tools.js`): TTL longo (12h); guarda só resultados
   definitivos (sucesso ou "não encontrado"), nunca erros transitórios.
4. **Busca web** (`tools.js`): TTL curto (10min) contra repetição imediata.

Observabilidade: `GET /api/cache/stats` (tamanho, TTL, taxa de acerto). Tudo
desligável por env (`PROMPT_CACHE`, `EMBED_CACHE_MAX`, `TOOL_CACHE`,
`*_CACHE_TTL_MS`). Testes: `cache.test.js`, `provider.promptCache.test.js`.

### 🆓 Modo gratuito para novos usuários sem chave de API (PR #67, 2026-07-21) — LACUNA PREENCHIDA

Primeiro acesso sem barreira: quem não tem chave escolhe entre **"Começar
gratuitamente"** (chave da plataforma, só no backend) e **"Configurar minha
própria chave"** (assistente `KeyWizard` para OpenRouter, DeepSeek, Groq, Gemini,
Mistral). Backend:
- `freeTier.js`: allowlist de modelos gratuitos (padrão OpenRouter `:free`, com
  fallback), limite diário por usuário + sobreposição individual, freio por
  minuto, bloqueio por abuso, registro de consumo/erros, config do admin com
  efeito imediato (`free_tier_settings`).
- `freeQueue.js`: fila global com concorrência limitada, posição visível e
  cancelamento (Parar cancela job ainda na fila).
- `userProvider.js`: nova fonte `'free'` (usuário > modo gratuito > chave do
  servidor); loop/orquestrador/multimodelo restringem modelos à allowlist.
- Rotas `/api/free-tier/status` e `/opt-in`; painel admin `/api/admin/free-tier`
  (somente `ADMIN_EMAIL`). **Migração 007** (`free_mode` + tabelas `free_tier_*`);
  **depois renumerada para 008** porque a main já usara a 007 para checkpoints.

Frontend: onboarding com as 2 opções + aviso das limitações; chip "Modo
gratuito" no chat (modelo, restantes) + gaveta (provedor, fila, renovação);
tela amigável de limite atingido; `FreeAdminPanel`. **A chave gratuita vive só
no `.env` do servidor** (nunca no cliente/repo). Pesquisa jul/2026 documentada
no README: OpenRouter permite servir usuários finais via backend próprio;
NVIDIA NIM, Cohere trial e GitHub Models **proíbem** — não usar.

### 🔗 Atribuição do app no OpenRouter + failover de modelo 404 (PRs #70–#76, 2026-07-20/21) — LACUNA PREENCHIDA

Frente de estabilidade/identidade do provedor (6 PRs), antes sem registro:
- **Identificação do app** (`aiClient.js`, PRs #70/#71): as chamadas ao
  OpenRouter chegavam sem `HTTP-Referer`/`X-Title` — o app aparecia como
  "desconhecido" nos Registros. Helper único `createAiClient` injeta os
  cabeçalhos quando a base URL é do OpenRouter; aplicado em TODOS os pontos que
  criam cliente (BYOK `userProvider.js`, cliente legado, indexador de memória,
  teste de chave). Nome/URL via `OPENROUTER_APP_TITLE`/`OPENROUTER_APP_URL`.
- **Prioriza `BETTER_AUTH_URL`** na atribuição (PR #71): em produção o
  docker-compose define `BETTER_AUTH_URL` a partir do `DOMAIN`, enquanto o
  `FRONTEND_URL` do `.env.example` ainda é localhost — sem isso o app seria
  marcado com URL de dev. Fallback reordenado para preferir `BETTER_AUTH_URL`.
- **404 de modelo faz FAILOVER** em vez de erro fatal (PR #72): vários modelos
  davam "Modelo não encontrado" (404) e a tarefa encerrava de vez.
  `isModelUnavailableError` detecta 404 / "not a valid model id" / "no endpoints
  available" e, no loop do agente, aciona o failover para o próximo modelo de
  reserva. `friendlyApiError` passa a mostrar o motivo real do provedor. A lista
  PADRÃO de modelos gratuitos apontava para IDs mortos (gemma-4,
  nemotron-3-super-120b, openrouter/free) → trocada por IDs `:free` vivos.
  Testes: `agent.modelUnavailable.test.js`.

### 🧩 Repositório selecionado informado aos modelos no Modo Multimodelo (2026-07-22) — LACUNA PREENCHIDA (mudança mais recente)

O fix anterior (`072884f`, Modo Equipe) só cobriu o `orchestrator.js` (N
assistentes no MESMO modelo). O **multimodelo real** — N modelos DISTINTOS nos
modos compare/council/debate/pipeline — roda em `multiModel.js`, que nunca
recebia o contexto do repositório. Por isso, com um repo GitHub selecionado no
Modo Desenvolvedor, os modelos ainda respondiam "me mande o link do
repositório" / "não tenho acesso ao GitHub". Agora `runMultiModel` calcula a nota
do time uma vez (`developerTeamContextFor`), e `multiModelSystemBlocks` injeta
papel + nota do repositório como 2º bloco de sistema em `slotMessages` (cobre
compare/council/debate + etapas não-executoras do pipeline) e no
`streamCoordinator`. Execução real (clone/leitura) segue no executor via
`runAgent`. Testes de regressão em `multiModel.test.js`.

### 🔐 Nota: rodada de segurança inicial (PR #21, 2026-07-18) — antes sem parágrafo próprio

Registrado aqui para completar a auditoria. **Críticos:** `/api/backup` virou
SOMENTE admin (`ADMIN_EMAIL`) — antes qualquer usuário logado baixava o banco
inteiro + todos os workspaces (incluindo chaves BYOK); "Pastas do PC" desativado
por padrão (`ENABLE_PC_FOLDERS=false`), `isDangerousHostPath` passa a rejeitar
qualquer `..`. **Altos:** Multer 1.x → 2.2.0 (DoS) + limite de 20 arquivos;
fuso `America/Sao_Paulo` por padrão (antes contadores diários ~3h fora no
Brasil); "pode/sim/não/continua" deixam de ser tratados como baixo sinal (senão
o agente perdia as ferramentas ao confirmar "posso gerar?"); `POST
/api/provider/test` passa a testar a chave DIGITADA no corpo.

## 🧹 Varredura de PRs antigos abertos + remoção dos pins de versão do prompt (2026-07-21 — branch `claude/version-pins-cleanup`)

**Pedido:** buscar PRs abertos esquecidos no repositório e mesclar.

Achados 2 PRs de 2026-07-19 (#40 e #43), ambos com conflito contra o `main`
atual — natural, dado o tanto que mudou desde então (checkpoint/resume,
multiconversa, modo gratuito, LGPD, antivírus, redesign do Modo Desenvolvedor).

- **PR #40 (correção de SSRF no `web_fetch`)** — conferido: a vulnerabilidade
  ainda estava presente no `tools.js` atual (bypass por IPv6 entre colchetes +
  falta de defesa contra DNS rebinding). Fiz `git rebase` da branch sobre o
  `main` atual — o código aplicou limpo (só o texto do CONTINUIDADE.md teve
  conflito, resolvido mantendo as duas entradas). Suíte completa: 166 testes,
  164 passam, 2 pulados (Postgres). **Mesclado.**
- **PR #43 (consolidação do system prompt)** — este **não deu para simplesmente
  rebasear**: o `backend/src/agent.js` que ele editava (113 linhas mudadas)
  virou, depois de 2026-07-19, uma FACHADA de 43 linhas que só reexporta de
  `backend/src/agent/*.js` (loop, prompts, orchestrator...). Reaplicar o diff
  original não faz sentido — a estrutura mudou por completo. Da lista de 4
  melhorias do PR, conferi cada uma contra o código de hoje:
  1. Mensagem system única — ainda não está assim hoje (`agent/loop.js` monta
     várias mensagens `system`); precisaria ser refeito do zero contra a
     arquitetura atual (loop.js + checkpoint/resume), não é um ajuste pequeno.
  2. Deduplicação de regras — mesma situação.
  3. Precedência de estilo dos sliders — idem.
  4. **Pins de versão no prompt** (`Python 3.12`, `kotlinc 2.3.21`) — ainda
     presentes, e o motivo do PR continua válido: a versão real já é conferida
     AO VIVO pelo audit de ambiente (`verifiedEnvironmentNote`, ainda existe em
     `agent/prompts.js`), então o pin é só informação que pode ficar desatualizada
     silenciosamente. Esta parte É pequena e segura, então apliquei de novo à
     mão nos arquivos atuais (`agent/prompts.js`, `agent/orchestrator.js`,
     `tools.js`): "Python 3.12" → "Python 3", "kotlinc 2.3.21" → "kotlinc".
     Testado: suíte completa (166, 164 passam, 2 pulados) + `prompts.dev.test.js`.

  **PR #43 fechado** como superado pela reorganização do backend, com o pedaço
  seguro (pins de versão) reaplicado nesta branch. Os itens 1–3 (mensagem
  system única, dedup de regras, precedência de sliders) ficam como
  **pendência real** para quem quiser reabrir essa frente — exigem entender a
  fundo `agent/loop.js` atual (que já ganhou checkpoint/resume no meio) antes
  de mexer, para não regredir nada.

## 🏆 Classificação de referência dos modelos no seletor (2026-07-21 — branch `claude/antivirus-vps-42tstn`)

**Pedido:** o usuário tem um ranking pessoal dos 100 melhores modelos (Tier
S+/S/A+/A/B+/B) e queria essa informação disponível no seletor de modelo, sem
"bagunçar o layout" nem complicar a visualização.

**Decisão de design:** nada de seção nova, coluna nova ou painel novo — só um
**selo discreto** (`S+`/`S`/`A+`/.../`B`) colado ao nome do modelo, e mais UMA
opção no `<select>` "Ordenar" que já existia (Nome/Lançamentos/Menor custo →
+ "Classificação de referência"). Modelo sem correspondência no ranking não
ganha selo nenhum — o app nunca inventa uma posição.

**`frontend/src/modelRanking.js`** (novo): os 100 nomes na ordem informada
(posição no array = rank), faixas de tier fixas (1–10 S+, 11–25 S, 26–50 A+,
51–75 A, 76–90 B+, 91–100 B) e `findRanking(model)`. O casamento é por NOME
normalizado contra o catálogo real (que vem do OpenRouter/DeepSeek em tempo de
execução) — não por id, porque os nomes na lista ("Claude Opus 4.8 Thinking")
raramente batem exatamente com o slug do catálogo
(`anthropic/claude-opus-4.8`). Normalização: minúsculas, travessão usado como
separador vira espaço (mas hífen colado numa palavra como `gpt-5.6` ou `x-ai`
não é tocado), pontuação removida sem quebrar número de versão (`5.6` → `56`,
não `5 6`). Se não bate exato, tenta bater pela versão "sem ruído" (remove
palavras como thinking/high/preview/turbo/instant/beta N) — assim "Claude Opus
4.8" (nome simples do catálogo) encontra a entrada "Claude Opus 4.8 Thinking"
da lista quando não existe uma entrada sem qualificador. **Sem match nenhum →
`null` → sem selo.** Nunca chuta.

**`components.jsx` (`ModelPicker`)**: `row(model)` calcula `findRanking(model)`
uma vez e, se existir, insere `<span class="mpRank tier{X}">{tier}</span>`
logo depois do nome, com `title` explicando a posição exata (ex.: "#22 de 100
· Tier S"). Novo `sort==='rank'` no `sortFn` existente + `<option
value="rank">` no select "Ordenar" (mesmo padrão de "Lançamentos"/"Menor
custo" — nada de UI nova).

**CSS (`styles.css`)**: `.mpRank` é uma pastilha pequena, cor **derivada de
`var(--accent)`** por `color-mix` (mais forte em S+/S, neutra em B+/B) — não
hex fixo, mantém a regra das 7 paletas. Um bloco de 8 linhas, sem novo layout.

**Honestidade sobre o rótulo:** o app é multiusuário (SaaS). Chamei de
"Classificação de referência" em vez de "Sua classificação"/"Minha
classificação" no texto visível, porque é uma curadoria do dono do app
embutida como dado estático — não é a opinião de quem está logado no momento
(mesmo cuidado já aplicado noutras partes do produto, ex.: seção de segurança
da landing só anuncia o que está de fato ativo).

**Teste:** dataset com 100 entradas confirmado (contagem por tier bate:
10/15/25/25/15/10), casamento verificado com nomes reais plausíveis do
catálogo (`Claude Sonnet 5`→#22, `Claude Opus 4.8`→#11 exato, `GPT-5.6
Sol`→#2 via fallback sem "xHigh", nome desconhecido→`null`), e render real
(`renderToStaticMarkup`) do `ModelPicker` confirmando que o HTML gerado tem o
selo certo (`tierS`, tooltip com #22) no lugar certo.

## 🖥️ Redesign do Modo Desenvolvedor a partir de handoff de design (2026-07-21 — branch `claude/antivirus-vps-42tstn`)

**Pedido:** aplicar no app um handoff de design (`.dc.html` + README, protótipo
Codex/Claude-Code-style) para o Modo Desenvolvedor — sidebar de projetos/tarefas,
centro com stage-driven timeline, gaveta direita com abas Atividade/Arquivos/
Alterações/Memória.

**Descoberta antes de codar (mudou o plano):** o repositório já tinha avançado
~49 commits desde a última vez que essa área foi tocada nesta sessão. O que o
handoff descrevia como "a ser construído" **já existia, mais avançado**: 6
modos de trabalho ponta a ponta (`DEV_WORK_MODES`/`DEV_MODES` no backend),
projetos persistentes (`useDevProjects.js`, localStorage: nome, descrição,
techs, vínculo pasta/GitHub, regras, memória em 6 categorias, histórico de
conversas), layout de 4 colunas (`workspace-developer`: sidebar + `DevProjectRail`
+ chat + `DevActivityRail`), e um `ExecutionSession` rico (cartão + overlay em
tela cheia, categorização por ferramenta, miniaturas reais de página via
`pageShot.js`). Reconstruir do zero teria REGREDIDO checkpoint/resume,
multiconversa e o `ExecutionSession` — todos maduros e testados. Decisão:
**redesenhar visual/interação em cima do que já existe**, não substituir.

**O que foi feito (só frontend):**
- `components/ExecutionSession.jsx`: exporta `metaOf`/`describe`/`CAT_META`/
  `statusIcon`/`tryParse` (antes privados do módulo) — o painel de Atividade
  reaproveita a MESMA categorização/rótulo por ferramenta que o "Ambiente de
  Trabalho da IA" já usa, em vez de duplicar/divergir.
- `components/DevActivityRail.jsx`: virou painel com 4 abas.
  - **Atividade**: além do cartão de status (mantido), lista cronológica dos
    passos da última resposta, com chamadas CONSECUTIVAS da mesma ferramenta
    agrupadas ("2× Comando no terminal", expansível) em vez de um item por
    chamada.
  - **Arquivos**: `read_file`/`list_files` da resposta (analisados).
  - **Alterações**: `write_file` com path/tamanho REAIS (do JSON que a
    ferramenta devolve) e selo A/M — M se o mesmo caminho já apareceu numa
    leitura antes na mesma resposta, A caso contrário. **Não inventa contagem
    de linhas/diff** — o backend não devolve isso.
  - **Memória**: o editor de 6 campos que já existia, só migrado para aba.
- `components/DevProjectRail.jsx`: a seção "Conversas do projeto" (só uma
  contagem, sem lista) virou **"Tarefas recentes"** clicável de verdade —
  resolve `project.conversationIds` para título real via `allConvs` (não
  mostra nada se a conversa não existir mais).
- `App.jsx`: pill de status no cabeçalho do workspace dev — **honesto**, 3-5
  estados derivados de sinais reais (`busy`/`paused`/`statusText`/
  `message.failed`/`message.resumable`), SEM fingir o pipeline de 5 etapas do
  protótipo (Analisando/Planejando/.../Revisando) que o backend não expõe
  (modos são um seletor de tipo de tarefa, não estágios sequenciais — confirmado
  por leitura de `backend/src/agent/prompts.js`/`loop.js`). Novo chip
  **Permissões** no composer (mesmo padrão do chip Esforço): popover só-leitura
  mostrando o modo ativo (edita/não edita) e o vínculo do projeto — dado real,
  não um toggle fictício. Cores decorativas dos 4 cartões de modo na tela vazia
  (azul/verde/âmbar/violeta) seguindo o MESMO precedente já usado nos
  `QUICK_ACTIONS` (`:nth-child` escopado, `v2.css`) — não um tema fixo.
- **Removido**: `ToolStep` (componente + CSS `.toolstep/.toolwrap/.tchev/
  .tooldetail`) — zero usos em todo o frontend, órfão desde que
  `ExecutionSession` assumiu esse papel.

**Decisão deliberada de NÃO seguir o handoff ao pé da letra (paletas):** o
protótipo define uma paleta escura fixa em hex. Este projeto tem uma regra já
documentada e reforçada por sessões anteriores — "Regra das 7 paletas: cores
saem de `var(--accent/--muted/--line)` ou `color-mix`, nunca hex fixo, senão
Claro/Sépia herdam azul" (`v2.css`, cabeçalho). Forçar o tema escuro do
protótipo ignoraria essa regra e quebraria a experiência de quem usa Claro/
Sépia/Slate/etc. no Modo Desenvolvedor. Em vez disso, o redesign usa os MESMOS
tokens semânticos (`--accent`, `--ok`, `--warn`, `--danger`) para computar os
mesmos papéis de cor do handoff (azul=ação, verde=sucesso/edita, âmbar=atenção/
corrigir, roxo=revisar — fixo, mesmo precedente decorativo do `QUICK_ACTIONS`),
então o resultado se adapta às 7 paletas em vez de fixar uma só.
**Também fora do escopo, por honestidade**: a barra de "Protótipo · estados"/
toggle desktop-mobile/overlay "Mudanças de arquitetura" do topo do `.dc.html`
— o próprio README do handoff diz que é chrome da ferramenta de design, não
parte do produto.

**Gaps conhecidos que ficam para depois (não bloqueiam este redesign):**
- `POST /tasks` (fila em segundo plano) não aceita contexto `developer` nem
  `effort` hoje — confirmado lendo `backend/src/routes/tasks.js`. O chip
  "Executar em segundo plano" já existia e continua funcionando, mas uma
  tarefa de dev enviada em 2º plano perde o modo/projeto/regras (só o texto
  vai). Se algum dia isso incomodar, dá para persistir `developer`/`effort` na
  tabela `tasks` e repassar em `processTasks()`.
- "Tarefas recentes" e a memória do projeto continuam só em `localStorage`
  (`useDevProjects.js`) — não sincronizam entre navegadores/dispositivos. Virar
  persistência no servidor é um projeto à parte (tabela nova + rotas CRUD).

**Verificação:** sem acesso a Postgres/chave de IA real neste ambiente, então
sem E2E ao vivo. Feito: `npx esbuild` em todo arquivo tocado, `npm run build`
do frontend (limpo), suíte `authUrls.test.js`+`sse.test.js` (7/7), e um teste
de fumaça server-side (`renderToStaticMarkup`) dos dois componentes novos com
dados realistas (chamadas de ferramenta consecutivas/erros/list_files/
write_file com JSON real do backend) confirmando que o agrupamento "2×", os
selos A/M, a categorização e a lista de tarefas recentes renderizam como
esperado — não só que compilam.

## ⏭️ Retomada REAL de tarefa interrompida — checkpoint persistente (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`)

**Pedido:** o app prometia "Reenviar para continuar de onde parei" quando a
tarefa batia no limite de ciclos (~90), mas ao reenviar a execução **começava do
zero** — todo o progresso, contexto operacional e estado se perdiam. O usuário
pediu uma retomada estrutural (não só aumentar o limite ou reenviar o texto),
preservando objetivo, plano, etapas/ferramentas já usadas, arquivos criados,
comandos executados, resultados, erros, ciclo em que parou, texto parcial,
decisões, modelo principal/reserva e o que falta — com checkpoint persistente e
cenários separados (limite / watchdog / desconexão / falha de modelo / reinício
do backend). É problema DIFERENTE do watchdog (PR #63): watchdog é o stream
travar; este é a retomada não existir de verdade.

**Causa raiz (confirmada no código):** o array `messages` do agente — que É o
estado operacional completo (objetivo = msg do usuário; plano/texto parcial =
conteúdo do assistente; etapas/ferramentas = `assistant.tool_calls`; resultados/
erros = mensagens `role:'tool'`; decisões = conteúdo) — vivia **só na RAM** e era
descartado quando o `runAgent` retornava. No limite de ciclos só o `finalText`
(texto visível parcial) era salvo. E o "Reenviar" (`retrySend`) chamava
`/truncate` com o id da mensagem do USUÁRIO, **apagando** a msg do usuário + a
resposta parcial, e reenviava o texto → run NOVO cujo contexto (via
`selectHistoryForContext`) não tinha nada do turno interrompido. Duas falhas
somadas: (A) estado nunca persistido; (B) "Reenviar" era restart destrutivo.

**Correção estrutural — o array `messages` VIRA o checkpoint, persistido no
Postgres:**
- **`backend/migrations/007_execution_checkpoints.sql`** — tabela
  `execution_checkpoints` (1 por conversa, PK `conversation_id`, ON DELETE
  CASCADE): `run_id`, `objective`, `reason`, `model`, `tried_models` (cadeia de
  failover), `step`, `messages` (JSONB — o estado), `usage`, `meta`. **Postgres →
  sobrevive a reinício do backend** (não é só RAM).
- **`backend/src/agent/checkpoint.js`** (novo): `saveCheckpoint`/`loadCheckpoint`/
  `hasCheckpoint`/`clearCheckpoint`. Partes PURAS (testáveis sem DB/LLM):
  `trimCheckpointMessages` (apara por tamanho preservando preâmbulo + cauda
  recente e NUNCA deixando `tool` órfã — pareamento tool_call/tool_result
  válido), `buildResumeMessages` (semeia o run de retomada: estado + nota de
  "continue, não repita"), `isResumableReason` (mesmo mecanismo central p/
  limite E watchdog), `leadingSystemCount`.
- **`backend/src/agent/loop.js`** — `runAgent` aceita `resume`:
  - restaura `chosenModel` e `triedModels` do checkpoint (o **modelo de reserva
    herda o contexto**: continua no modelo ativo e não retenta os que já
    falharam);
  - substitui o contexto recém-montado pelo array salvo + notas de continuidade
    (não regrava mensagem de usuário, não reanexa imagens);
  - **orçamento de ciclos NOVO** (a retomada avança de verdade em vez de morrer
    no limite de novo);
  - `usage` soma sobre o run anterior; `outputsBefore` vazio no resume (arquivos
    já prontos contam como entrega e não disparam falso "arquivo não gerado");
  - ao terminar interrompida por `step_limit`/`provider_failure`/`stopped` (com
    progresso), **salva o checkpoint**; ao concluir limpo, **limpa**. Emite
    evento `resumable` ao vivo. Mensagem de limite reescrita: "**Continuar**"
    (não mais "Reenviar").
- **`backend/src/routes/conversations.js`** — `POST /conversations/:id/resume`
  (SSE igual ao /chat, mesmo `openLiveStream`, **sem gravar msg de usuário**,
  carrega o checkpoint e passa `resume` ao runAgent → mesmo `conversationId`, sem
  execução nova). `GET /:id` devolve `resumable` e marca a última msg do
  assistente. 409 se já ativo / sem checkpoint; 429 respeita o teto multiconversa.
- **Frontend** (`useChat.js`, `App.jsx`): `resumeRun(convId)` faz stream do
  `/resume` reusando `consumeChatStream` (multiconversa-aware: mesma época/gate
  por conversa, sem duplicar). Botão **"Continuar de onde parei"** (verde,
  distinto do "Reenviar") aparece na msg quando `resumable` (evento ao vivo OU
  flag do GET após reload). `.resumeBtn` no styles.css.

**Cenários separados (como pedido):**
- **Limite de ciclos** → checkpoint `step_limit`, continuação real.
- **Watchdog/stream travado** → o stall exaurido vira `provider_failure` (retryável)
  → checkpoint, retomada a partir do conteúdo já recebido.
- **Frontend desconectado** → reconecta à execução existente (multiconversa,
  PR #65) — não cria tarefa nova.
- **Falha do modelo** → failover herda `messages`+`triedModels` do ponto de parada.
- **Reinício do servidor** → checkpoint no Postgres; `loadCheckpoint` numa
  requisição nova reidrata o estado.

**Anti-duplicidade:** resume checa `isConversationActive` (409), não grava msg de
usuário, usa o mesmo `conversationId`; no front, época por conversa descarta
consumidor duplo (herdado do PR #65).

**Testes:** `backend/src/agent/checkpoint.test.js` (7, PUROS — sem DB/LLM):
objetivo+ferramentas+resultados+texto parcial preservados; aparo mantém
pareamento e cauda recente sem tool órfã; toda `tool` tem seu `assistant` antes;
`buildResumeMessages` adiciona a orientação de continuar (e não a adiciona quando
parou após ferramenta); `isResumableReason` cobre requisito 8 (watchdog+limite no
mesmo mecanismo; falhas de qualidade fora). Suíte backend: **151 passam, 0
falham, 2 skips**. Frontend build OK + 7/7.

**Limitações que permanecem (honestidade):**
- O checkpoint guarda o estado do MODELO (array de mensagens), não um snapshot do
  filesystem do sandbox. Arquivos em `/workspace/outputs` persistem em disco por
  conversa, então continuam disponíveis; mas se o sandbox for reciclado, artefatos
  FORA de outputs (ex.: venv, estado intermediário) não voltam — o modelo relê/
  refaz o que precisar a partir dos resultados registrados.
- Interrupção EXATAMENTE no meio de uma ferramenta longa (ex.: um `bash` a meio
  de rodar): a ferramenta não é retomada no meio; o resume parte do último
  resultado COMPLETO registrado. Sem efeito colateral duplicado (a ferramenta
  incompleta não deixou resultado no array).
- Os testes puros provam o mecanismo (trim/seed/reason). A continuação
  ponta-a-ponta (ciclo 90 → 91 sem repetir, com LLM+Postgres reais) precisa ser
  exercitada em produção — este ambiente não tem provedor nem banco para o E2E.
- Só o agente de conversa única tem checkpoint. Multimodelo/Equipe ainda não
  (cada um teria seu próprio estado por participante) — fica como evolução.

## 🔀 Multiconversa — várias conversas processando ao mesmo tempo (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`)

**Pedido:** ter 3–5 conversas processando simultaneamente, com um indicador
girando na barra lateral mostrando quais estão ativas — e com MUITO cuidado:
trocar de conversa não pode parar, misturar nem confundir os andamentos.

**O que já existia:** o backend SEMPRE suportou execuções paralelas em
conversas diferentes (o controle pausar/parar e o liveStream são POR conversa;
`ConversationBusyError` só bloqueia a MESMA conversa). As travas eram todas do
frontend: um único estado global `busy/paused/statusText` no `useChat`, o
`blockConversationChange` do App impedia trocar de conversa durante um run, e
o consumo do SSE escrevia em `messages` sem checar qual conversa estava aberta.

**Frontend (`useChat.js` — o núcleo da mudança):**
- Estado de execução POR CONVERSA: `runs` (`convId → {busy, paused, status}`)
  + `runsRef` (fonte síncrona). `busy/paused/statusText` viraram PROJEÇÃO da
  conversa aberta — a API consumida pelo App não mudou (só ganhou
  `runs`/`anyBusy`). `busyRef` continua = conversa aberta (o `useTasks` usa).
- **ÉPOCAS de stream (anti-duplicação — o "não pode se misturar"):**
  `streamEpochsRef` conta uma época por conversa; todo consumidor (envio OU
  replay de reconexão) registra a época em que nasceu. Quem reconecta avança a
  época; o consumidor antigo detecta (`isLiveEpoch`) e se descarta cancelando o
  reader. Sem isso, voltar a uma conversa ativa criaria DOIS consumidores
  aplicando os mesmos eventos (texto dobrado).
- **Gates por conversa:** TODO update visual do stream (`update()`, `saved`)
  só aplica se `currentRef.current?.id === convId`. Status vai para o `runs` da
  conversa do stream, nunca para um global. Trocar de conversa no meio → os
  eventos da outra viram no-ops visuais (a tarefa segue no servidor).
- **1ª mensagem de conversa nova:** `currentRef` é sincronizado por efeito
  (roda depois do render); o sendMessage agora escreve `currentRef.current =
  conv` na hora (mesmo truque do openConversation) — sem isso os gates
  descartariam os primeiros eventos do stream.
- **Sair e voltar:** sair não interrompe (consumidor original segue lendo com
  updates em no-op e limpa o estado no `done`); voltar dispara o replay
  (`followActiveConversation`), que avança a época e reassume. Se o SSE cair
  com o usuário em OUTRA conversa, `watchDetachedRun` vigia por polling (5s,
  ~30 min) e apaga o "girando" quando o servidor terminar — a menos que alguém
  reconecte antes (época avança → vigia se retira).
- **Limpezas com dono único:** quem assume o acompanhamento (follow) é quem
  limpa (`endRun`); resultados `stale` NUNCA fazem cleanup (o novo consumidor é
  o dono). `loadFiles`/`setCurrent` pós-run só se a conversa ainda é a aberta.
- `App.jsx`: `blockConversationChange` virou no-op (trocar de conversa/cliente/
  nova conversa é livre); indicador `.spin.sm.convSpin` no item da barra
  lateral (`runs[c.id] ? runs[c.id].busy : c.active` — estado local vence, flag
  do servidor cobre reload/outro dispositivo); polling da lista a cada 10s
  ENQUANTO houver atividade (apaga/acende sozinho). CSS em styles.css.

**Backend (aditivo):**
- `GET /conversations` (todas as variantes) devolve `active` por linha
  (`isConversationActive`) — alimenta o indicador após reload/outro aparelho.
- `control.js`: `acquireConversationControl(conversationId, userId)` marca o
  dono; novo `countActiveRunsForUser(userId)`. `loop.js`/`multiModel.js`/
  `orchestrator.js` passam o userId (aditivo, sem mudança de comportamento).
- `POST /chat`: teto `MAX_ACTIVE_RUNS_PER_USER` (padrão 5, piso 1) → 429 com
  mensagem clara. Protege a VPS; tarefas de segundo plano não são bloqueadas
  pelo teto (só contam), e o 409 da MESMA conversa continua igual.
- `.env.example`/`README.md`: variável nova + linha na tabela de recursos.
  **Atenção:** conversas paralelas que EXECUTAM código disputam
  `MAX_SANDBOXES_PER_USER` (padrão 2) — subir os dois juntos se necessário.

**Validação:** backend **144 testes, 0 falhas** (2 novos em
`agent.control.test.js`: contagem por usuário e independência de stop/pause
entre conversas do mesmo dono). Frontend: build Vite OK + 7/7 (`dist/`
recompilado e commitado). NÃO houve teste de UI ao vivo multiconversa (sem
Docker/Postgres aqui) — validar em produção: enviar em 2–3 conversas, trocar
entre elas durante o processamento, conferir indicador girando, voltar e ver o
replay reconectar sem duplicar texto.

## ❓ Pergunta ao usuário encerra o turno — a IA não "responde a si mesma" (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`, follow-up do PR #63)

**Sintoma (print do usuário):** no Modo Desenvolvedor, o modelo terminou a
resposta com 3 perguntas ("Quais itens quer que eu ataque? Branch separado com
PR ou commit direto na main? Algo específico a incluir?") e, em vez de PARAR
para o usuário responder, a execução CONTINUOU — clonou o repositório e decidiu
tudo sozinha. O usuário não conseguia responder (o composer fica bloqueado
enquanto o run está ativo).

**Causa raiz:** quando o modelo para de chamar ferramentas para perguntar, o
`shouldRepairExecution` (repair.js) interpretava como "execução incompleta" e o
loop injetava `EXECUTION_COMPLETION_REPAIR_NOTE` com `tool_choice='required'` —
FORÇANDO o modelo a chamar ferramenta em vez de deixar a pergunta chegar ao
usuário. Os prompts (EXECUTION_CONTRACT_NOTE: "nada de ficar no plano") ainda
empurravam na mesma direção. Ou seja: o app tratava "perguntar" como falha.

**Correção:**
- `backend/src/agent/repair.js` — novo `endsAwaitingUserReply(text)`:
  detecta que a resposta TERMINA com "?" (após remover avisos padronizados do
  sistema e enfeites de markdown/aspas/parênteses do fechamento). Conservador:
  pergunta retórica no meio seguida de conclusão NÃO conta.
  `EXECUTION_CONTRACT_NOTE` ganhou a exceção explícita: faltou decisão do
  usuário → pergunte e PARE.
- `backend/src/agent/loop.js` — no ramo sem tool calls: se
  `endsAwaitingUserReply(content)` (e NÃO for `forceExecution` — tarefa de
  segundo plano não tem usuário presente para responder; lá o comportamento
  antigo continua), o turno completa naturalmente: sem reparo forçado, sem
  `MISSING_OUTPUT_NOTICE`/`EXECUTION_INCOMPLETE_NOTICE`, sem marcar
  `incomplete`. A pergunta é entregue e o composer libera. A checagem de
  `missingClaimedOutput` (texto afirma download que não existe) continua
  valendo MESMO com pergunta no final — mentir sobre arquivo é pior.
- `backend/src/agent/prompts.js` — QUALITY_BAR ganhou a regra: pergunta que
  depende de decisão da pessoa é o FIM da resposta; nunca continuar executando
  nem responder a própria pergunta no mesmo turno.

**Validação:** `repair.awaiting.test.js` (7 testes novos, incluindo o texto
REAL do bug com lista numerada de perguntas). Suíte backend completa: **142
passam, 0 falham, 2 skips pré-existentes**. Sem mudança de frontend (o
composer já libera quando o run termina — o problema era o run não terminar).

**Comportamento esperado após o deploy:** modelo pergunta → run termina →
usuário responde → a tarefa continua na mensagem seguinte com o contexto da
conversa. No modo `auto` o prompt já orienta a só perguntar diante de ação
destrutiva/fora de escopo — perguntas continuam raras lá.

## 🧊 Modelo "travando na execução" — watchdog contra stream parado (2026-07-21 — branch `claude/modelo-travando-execucao-uwatco`)

**Sintoma (recorrente, relatado com prints + .mht):** no meio de uma resposta
longa (Z.ai GLM 5.2, esforço Máx, ~42 etapas de ferramenta), o texto PARA no
meio de uma frase e a interface fica em "Raciocinando..." para sempre. O app
nunca entrega a resposta nem mostra erro — falha grave: "o básico é responder".

**Causa raiz (diferente das anteriores):** nenhuma das 3 vias de streaming do
backend (`loop.js`, `multiModel.js`, `orchestrator.js`) tinha proteção contra
um provedor que PARA de enviar dados SEM fechar a conexão (upstream congelado,
proxy que engoliu a resposta, rede móvel). O `for await (chunk of stream)`
fica pendurado indefinidamente: nenhum erro é lançado, então TODA a máquina de
recuperação que já existia (retry com STREAM_RESUME_NOTE, fallback de modelo,
PROVIDER_TIMEOUT_NOTICE) nunca é acionada. O heartbeat `: ping` de 15s mantém
o SSE "vivo", então o frontend também não percebe nada. NÃO confundir com os
bugs anteriores: limite de etapas (PR #58, outro sintoma — mensagem de limite)
e re-render travando a UI (PR #60, a resposta chegava mas a tela engasgava).

**Correção:**
- `backend/src/agent/streamGuard.js` — **novo, puro (não importa openai =
  testável em qualquer ambiente)**. `guardStreamStall(stream, {timeoutMs,
  onStall})`: repassa os chunks; se NENHUM chegar em `STREAM_STALL_TIMEOUT_MS`
  (padrão 180s, piso 30s — generoso porque modelos de raciocínio podem ficar
  minutos "pensando" sem emitir texto), chama `onStall()` (aborta a requisição
  com reason `'stall'`) e lança `StreamStalledError` (code `STREAM_STALLED`).
  O timer só corre ENQUANTO se espera o próximo chunk (pausa do usuário e
  processamento do corpo do loop não contam). No `finally`, fecha o iterator
  subjacente (break/stop não vaza conexão) e faz catch da promise pendente
  (sem unhandled rejection). Também exporta `PROVIDER_CONNECT_TIMEOUT_MS`
  (padrão 180s): passado como `timeout` nas chamadas de streaming `create()`
  — o padrão do SDK é 10 min até os headers, longo demais.
- `backend/src/agent/provider.js` — `isRetryableStreamError` reconhece
  `code==='STREAM_STALLED'` e as mensagens "stream stalled"/"request timed
  out". Assim o stall cai na recuperação NORMAL: retomar de onde parou (até
  STREAM_RECOVERY_LIMIT), depois modelo de reserva, depois aviso honesto — a
  resposta parcial é SEMPRE salva e entregue.
- `backend/src/agent/loop.js`, `multiModel.js` (participante + coordenador),
  `orchestrator.js` (coordenador) — os 4 `for await` de streaming embrulhados
  no guard, com `onStall: () => activeRequest.abort('stall')`; `timeout` de
  conexão nos `create()` de streaming. O abort com reason `'stall'` NÃO é
  confundido com pause/stop do usuário (`controlInterruptReason` devolve
  'abort' → caminho retryável).
- `frontend/src/hooks/useChat.js` — watchdog espelho no SSE: o servidor manda
  `: ping` a cada 15s; se NADA chegar por 60s (`SSE_STALL_MS`), a conexão
  morreu em silêncio → `reader.cancel()` + throw, e o fluxo cai na reconexão
  automática já existente (`reconnectLiveRun`/`followActiveConversation`), que
  remonta o balão pelo replay. Antes, um SSE morto sem FIN deixava a tela
  travada mesmo com o backend saudável.
- `.env.example` — documenta `STREAM_STALL_TIMEOUT_MS` e
  `PROVIDER_CONNECT_TIMEOUT_MS`.

**Validação:** `backend/src/agent/streamGuard.test.js` (6 testes: repassa
chunks, stall lança e chama onStall preservando o texto já recebido, timer não
corre durante o processamento do chunk, break fecha o stream, erro do provedor
propaga intacto, pisos de config). Suíte backend completa: **135 passam, 0
falham, 2 skips pré-existentes** (com `npm install --ignore-scripts`; sharp
segue bloqueado pelo proxy deste ambiente). Frontend: `node --test` 7/7 +
`npm run build` OK (dist/ recompilado e commitado — é versionado). NÃO deu para
reproduzir um stall real de provedor neste ambiente; validar em produção
deixando uma tarefa longa rodar (o pior caso agora é: 3 min de silêncio →
retomada automática; se o provedor seguir mudo → modelo de reserva → aviso
honesto com o parcial salvo, nunca mais "Raciocinando..." infinito).

## 📸 Miniatura real de página: navegador headless no backend (2026-07-21 — branch `claude/unified-ai-execution-session-25rm4h`, PR #60)

Pedido: "instale um navegador headless" para gerar a MINIATURA real da página
(o item que ficou de fora no PR #60 inicial, que só mostrava endereço + texto).
Agora, quando a IA abre uma página com `web_fetch`, o backend renderiza a página
num Chromium headless e salva um screenshot, exibido no painel de detalhe do
Ambiente de Trabalho.

**Arquivos:**
- `Dockerfile` (raiz) — instala `chromium` + `fonts-liberation` via apt e define
  `ENV CHROMIUM_PATH=/usr/bin/chromium`. **A imagem fica ~alguns 100 MB maior.**
- `backend/package.json` — adiciona `puppeteer-core` (usa o Chromium do sistema;
  NÃO baixa navegador). **⚠️ `package-lock.json` não foi regenerado** (sem rede
  neste ambiente); o Dockerfile usa `npm install` (não `npm ci`), então resolve
  na build. Rodar `npm install` na VPS/local atualiza o lock.
- `backend/src/agent/pageShot.js` — **novo**. Navegador compartilhado (singleton
  com auto-close após 1 min ocioso), `captureThumbnail(url, destPath)`. É
  **best-effort**: import dinâmico do puppeteer-core em try/catch, checa
  `CHROMIUM_PATH` existe; qualquer falha/timeout → retorna false e o `web_fetch`
  segue só com o texto. **SSRF:** interceptação de requisições aborta QUALQUER
  host bloqueado por `isBlockedHost` (mesma regra do web_fetch), inclusive em
  redirecionamentos/JS da página. Viewport 1024×640, JPEG q55, timeout 9s.
- `backend/src/tools.js` — no `runTool`, o `web_fetch` chama `captureThumbnail`
  após o fetch (URL final já validada) e grava em `<ws>/.thumbs/<id>.jpg`,
  devolvendo `thumb` (caminho relativo) no resultado. Import de `captureThumbnail`
  (import circular com pageShot.js → OK, uso só em runtime; testado isolado).
- `backend/src/agent/loop.js` — extrai `thumb` do resultado do web_fetch e manda
  num campo SEPARADO no evento `tool_result` (o `content` é cortado em 2000 chars
  e o caminho poderia se perder).
- `frontend/src/hooks/useChat.js` — guarda `ev.thumb` no bloco da ferramenta.
- `frontend/src/components/ExecutionSession.jsx` — `ResultView` do navegador
  mostra a miniatura clicável (abre em tamanho real) acima do endereço/texto.
- `frontend/src/styles.css` — `.esShot`.
- `.env.example` — documenta `CHROMIUM_PATH`, `WEB_FETCH_SCREENSHOTS` (0 desliga),
  `SCREENSHOT_TIMEOUT_MS`.
- `README.md` — nova linha na tabela de recursos (Ambiente de Trabalho da IA),
  nota de arquitetura sobre o Chromium headless e as 3 variáveis novas na tabela
  de variáveis.

**Decisões:**
- **puppeteer-core + Chromium do apt** (não playwright, não puppeteer completo):
  mais leve e é o caminho clássico p/ "screenshot com Chromium do sistema" em
  Docker. `--no-sandbox --disable-dev-shm-usage` (sem /dev/shm grande no
  container). Navegador reaproveitado entre capturas e fechado no ócio p/ poupar
  RAM da VPS.
- **Miniatura por página, não por pesquisa:** só o `web_fetch` (abrir página)
  gera screenshot; `web_search` (lista de links) não.
- **Custo:** cada `web_fetch` passa a renderizar a página (fetch de texto + render
  no browser). Timeout curto e best-effort limitam o impacto; `WEB_FETCH_SCREENSHOTS=0`
  desliga tudo se a VPS ficar apertada.

**Validação:** `node --check` nos 3 arquivos backend + repro isolado do import
circular e do guard SSRF (público passa, localhost bloqueia). Frontend: `build`
OK + `node --test` (7). **Não** dá p/ testar a captura real aqui (backend sem
deps — proxy bloqueia `npm install` de `openai`/`sharp` com 403). Quem valida de
fato é a build da VPS; conferir na tela após o deploy que a miniatura aparece.

## ⚡ Ambiente de Trabalho da IA: fluidez + prévia de arquivo/imagem/página (2026-07-21 — branch `claude/unified-ai-execution-session-25rm4h`, follow-up do PR #59)

Continuação do #59 (que já está na `main`). Dois pedidos: **(1)** a interface
estava "travando / demorando a atualizar" — não parecia orgânica; **(2)** faltava
a prévia do conteúdo do arquivo / miniatura da imagem / prévia da página no painel
de detalhe. Como o #59 já foi mesclado, este trabalho recomeçou do `origin/main`
no mesmo nome de branch (abre um PR novo).

**(1) Fluidez — o que travava e o que mudou:**
- **Causa raiz:** enquanto a IA responde, o app re-renderiza a cada token (delta)
  e a cada 1s (relógio de `useChat`). Sem memo, TODA mensagem — incluindo o
  `ReactMarkdown` com `rehype-highlight` (recolore blocos de código) de mensagens
  antigas — era re-parseada a cada tique. Era isso que engasgava, sobretudo no
  celular.
- **Correções (`frontend/src/App.jsx`):** novo componente `MessageText` embrulhado
  em `React.memo` (compara pelo texto) — o markdown só reprocessa o que mudou de
  fato. Toda renderização de markdown do chat passou a usá-lo.
- **`frontend/src/components/ExecutionSession.jsx`:** `ExecutionSession` agora é
  `React.memo` com comparador `sameSteps` (compara nº de etapas + status/ended/
  result de cada uma). Como `toolSteps` é recriado a cada render (`.filter`),
  comparar por identidade não bastava — por isso o comparador por conteúdo.
  O relógio virou estado interno (`now`) que só corre quando `live`, em vez de
  depender do `nowTick` do pai (prop `nowTick` removida). No overlay, os
  `useEffect` de auto-seguir/rolar passaram a depender de primitivos
  (`runningIdx`, `steps.length`, `follow`) e não da identidade do array — antes
  disparavam a cada render.
- **CSS (`frontend/src/styles.css`):** transições suaves no cartão/etapas, pulse
  discreto no cartão "ao vivo", fade/rise no overlay, com guarda
  `prefers-reduced-motion`.

**(2) Prévia rica no painel de detalhe:**
- **Backend (`backend/src/agent/loop.js`):** o `write_file` só devolvia `{ok,path,
  size}` (sem conteúdo). Agora o `tool_start` leva também `detail` = conteúdo
  escrito (até 4000 chars) — única mudança de backend, aditiva. `useChat.js`
  guarda `detail` no bloco da ferramenta.
- **Frontend (`ExecutionSession.jsx`, novo `ResultView`):** o resultado é
  parseado e formatado por categoria — **imagem** (`generate_image.saved`) vira
  miniatura clicável (usa `API` + `/download/`); **pesquisa** vira lista de
  resultados (título/resumo/link); **navegador** (`web_fetch`) mostra o endereço
  clicável + prévia do texto da página; **terminal** (`bash`/`run_python`) mostra
  a saída como console (erro se `exitCode≠0`); **leitura**/**lista** mostram
  conteúdo/arquivos; **gravação** mostra o conteúdo salvo + confirmação.
- **Miniatura real de página (screenshot) NÃO foi feita:** `web_fetch` retorna só
  texto; um thumbnail exigiria um navegador headless no backend. Em vez disso, a
  "prévia da página" é endereço + excerto do texto. Fica como possível evolução.

**Persistência:** os `blocks` (etapas) NÃO são salvos no banco — só existem ao
vivo e no replay do stream (reconexão). Ao recarregar do zero, a mensagem mostra
só o texto final (conversa limpa). Comportamento intencional, mantido.

**Validação:** `npm run build` (vite) OK; `node --test src/*.test.js` do frontend
passa (7). Backend: `node --check src/agent/loop.js` OK e o diff é aditivo; os
testes que importam `openai` não rodam NESTE ambiente (proxy bloqueia instalar
`openai`/`sharp` com 403) — quem valida de fato é o build da VPS. Detalhe visual
(pesquisa, terminal, código, navegador, cartões) conferido em preview antes do
commit.
## 🧑‍💻 Reformulação do Modo Desenvolvedor — ambiente dedicado, 6 modos e memória por projeto (2026-07-21 — branch `claude/developer-mode-redesign-b41nz8`)

**Motivação:** o Modo Desenvolvedor parecia amador — "só uma opção que
redirecionava o pedido para uma conversa comum", sem ambiente próprio. O pedido
era aproximá-lo de Codex/Claude Code (área independente, projetos, ferramentas,
memória e fluxo próprios), mantendo compatibilidade com os modelos do OpenRouter.

**O que mudou (backend):**
- `backend/src/agent/prompts.js` — `developerContextFor` passou de 3 para **6
  modos**: `ask` (Perguntar), `plan` (Planejar), `build` (Implementar), `fix`
  (Corrigir erro), `review` (Revisar) e `auto` (Agente autônomo). Exporta
  `DEV_MODES` e `DEV_WRITE_MODES`. Só `build/fix/auto` escrevem (retorna
  `canWrite`); `ask/plan/review` são leitura (`readOnlyProject`). Modos que
  executam agora exigem **plano antes de editar** (`PLAN_BEFORE`: entendimento,
  arquivos, mudanças, riscos, validação) e **resumo profissional ao final**
  (`FINAL_SUMMARY`: alterações, arquivos, testes/resultados, problemas,
  pendências, próximos passos). O modo `fix` orienta buscar a **causa raiz**.
- `backend/src/agent/loop.js` — o gating das ferramentas de escrita do GitHub
  (`github_push`/`github_create_pr`) deixou de olhar `mode !== 'build'` e passou
  a usar `!developerContext.canWrite` (cobre `fix`/`auto`). Regra do `write_file`
  segue por `readOnlyProject` (respeita a permissão da pasta do PC).
- `backend/src/agent/prompts.dev.test.js` — novo teste dos 6 modos, permissões e
  presença de plano/resumo. **Suíte backend: 122 passam, 0 falham, 2 skips
  pré-existentes.**

**O que mudou (frontend):**
- Novo hook `frontend/src/hooks/useDevProjects.js` — **projetos** persistidos no
  navegador (`fred_dev_projects_v1`): nome, descrição, tecnologias, vínculo
  (pasta do PC ou repositório GitHub), regras e **memória permanente**
  categorizada (`MEMORY_FIELDS`: arquitetura, decisões, padrões, problemas
  corrigidos, preferências, próximas etapas). `projectContextText()` compõe
  regras + memória e envia pela via `rules` (que já chega ao system prompt), então
  a IA "lembra" do projeto sem o usuário reexplicar. O contexto do projeto não se
  mistura com conversas comuns.
- Duas colunas recolhíveis no espaço "Desenvolvedor", ao redor do chat (sem
  reescrever o motor de chat): `components/DevProjectRail.jsx` (**Explorador** —
  projeto ativo, vínculo/permissão e arquivos da tarefa via
  `/api/conversations/:id/files`) e `components/DevActivityRail.jsx`
  (**Atividade** em tempo real reaproveitando o "Ambiente de Trabalho da IA" +
  editor da **memória do projeto**).
- `frontend/src/DeveloperPanel.jsx` redesenhado como **lançador**: seleção/criação
  de projeto, campos do projeto, vínculo (pasta/GitHub + branch), seletor visual
  dos 6 modos com selo leitura/escrita e o fluxo de cada modo. Exporta
  `DEV_MODE_ICON`.
- `frontend/src/constants.js` — `DEV_WORK_MODES` (espelha o backend).
- `frontend/src/App.jsx` — hook de projetos, render das colunas no workspace
  `developer`, barra superior ciente do projeto/modo, `startDeveloperTask` compõe
  regras+memória e mapeia o vínculo para `projectId`/`github`, e vincula a
  conversa ao projeto no 1º envio.
- `frontend/src/styles.css` — grid de 4 colunas do ambiente
  (`barra lateral · explorador · chat · atividade`), estilos das colunas,
  explorador, atividade, memória e cartões de modo; colunas somem em telas
  ≤1180px (a entrada continua pelo painel). Tudo por variáveis de tema.

**Verificação:** `npm run build` (frontend) OK; testes backend 122/122 e
frontend 7/7 verdes. **Não** houve teste de UI ao vivo (sem Docker/servidor
neste ambiente).

**Escopo consciente (para as próximas iterações):** editor de código e terminal
como painéis "de verdade" precisariam de endpoints novos para servir/gravar
arquivos do host (hoje a execução é num sandbox Docker por conversa) — por isso o
trabalho real da IA aparece no painel de Atividade e no "Ambiente de Trabalho",
não num editor que não gravaria nada. Memória por projeto é persistida no
cliente e injetada em toda tarefa; uma indexação semântica por projeto no backend
é o passo natural. Ainda em aberto: pontos de restauração/desfazer, permissões
por ação com toggles e repasse do contexto de desenvolvedor às tarefas em
segundo plano.
## 🧩 Sistema Multimodelo — 2+ IAs na mesma mensagem (2026-07-21 — branch `claude/multimodelo-system-h8t0tb`)

**Pedido:** usar dois ou mais modelos de IA simultaneamente na mesma conversa —
não só duplicar a pergunta, mas colaborar/comparar/revisar/sintetizar — com
função por modelo, controle de custos e presets de equipes (spec completa do
usuário em 16 seções).

**O que foi implementado (funcional de ponta a ponta):**
- **Motor novo** `backend/src/agent/multiModel.js` (`runMultiModel`): cada
  participante é uma chamada INDEPENDENTE ao provedor (modelo distinto), com
  streaming individual (eventos SSE `mm_start`/`mm_status`/`mm_delta`/
  `mm_reset`/`mm_round`/`mm_done`), status por modelo (aguardando → analisando →
  respondendo/revisando → concluído/interrompido/erro), tokens, custo e tempo.
  NÃO confundir com o Modo Equipe (`orchestrator.js` = vários ASSISTENTES no
  mesmo modelo) nem com fallback (disponibilidade) — são recursos separados.
- **4 modos:** `compare` (paralelo, lado a lado; a mensagem salva é a junção em
  seções), `council` (paralelo + coordenador consolida concordâncias/
  divergências/erros; síntese streamada como texto principal), `debate` (até 3
  rodadas: cada modelo lê os outros, critica e REESCREVE a própria resposta;
  coordenador fecha) e `pipeline` (sequencial: cada etapa recebe o que as
  anteriores produziram; no Modo Desenvolvedor a 1ª etapa com papel
  implementador/código executa DE VERDADE via `runAgent` com ferramentas, e as
  etapas seguintes revisam — a revisão vira um 2º balão salvo).
- **12 papéis prontos** (`MULTI_ROLES`): principal, revisor, pesquisador,
  código, arquiteto, implementador, segurança, testador, tributário, contábil,
  jurídico, livre — cada um com system prompt próprio; o usuário pode
  sobrescrever com prompt customizado por participante.
- **Custos:** estimativa ANTES do envio no frontend (`estimateMultiCost`, usa
  `price`/`priceOut` do catálogo — `priceOut` é campo NOVO em
  `modelCapabilities.js`), orçamento máximo em US$ com interrupção automática
  (`budgetUsd` → `budgetExceeded`), teto de tokens por modelo (`max_tokens`),
  teto de 6 modelos e 3 rodadas (env `MULTI_MAX_MODELS`/`MULTI_MAX_ROUNDS`),
  alerta $$$ para modelos caros. Custo REAL por modelo gravado no meta.
- **Contexto por política** (`context`): `recent` (padrão, ~8 msgs), `full`
  (~30 msgs), `summary` (usa `conversations.summary_long/short`; sem resumo cai
  para recent) e `none` — o orquestrador decide o que cada modelo recebe, nunca
  o histórico inteiro por padrão.
- **Cancelar UM modelo só:** `POST /conversations/:id/multimodel/cancel {slot}`
  (registro `slotRegistries` por conversa aborta só os AbortControllers daquele
  slot); pausar/continuar/parar geral continuam valendo para tudo (mesmo
  `control` de sempre).
- **Persistência:** coluna nova `messages.multi_meta` (migração
  `006_multimodel.sql`) guarda o JSON por modelo (status/texto/usage/custo/
  tempo) — o GET da conversa devolve como `m.multi` e a interface remonta os
  cartões ao reabrir. Se o JSON passar de 200k, regrava com textos encurtados
  (nunca `.slice()` cego que quebraria o JSON).
- **Presets ("equipes"):** tabela `model_teams` + rotas `GET/POST/DELETE
  /api/model-teams` (máx. 30 por usuário; config re-normalizada no POST).
- **Frontend:** `MultiModelPicker.jsx` (botão na topbar ao lado do
  ContextPicker: modo, modelos+funções, coordenador, rodadas, contexto,
  orçamento, estimativa, equipes salvas; estado em `localStorage
  fred_multimodel`; ligar multimodelo DESLIGA o Modo Equipe — o backend dá
  prioridade ao multimodelo) e `MultiModelBoard.jsx` (cartões por modelo nas
  mensagens com ações: copiar uma resposta, "continuar com este" (troca o
  modelo principal e desliga o multi), "pedir revisão" (pré-preenche o campo),
  "combinar respostas", parar um modelo). No render, modos `compare`/`pipeline`
  NÃO repetem o `content` (o quadro já mostra tudo); `council`/`debate` mostram
  quadro + síntese.
- **Validação:** schema zod `multiModel` no `chat` (validation.js) +
  normalização de verdade em `normalizeMultiModelConfig` (menos de 2 modelos
  válidos → null → fluxo normal de 1 modelo segue intacto).

**Testes/validação:** `backend/src/multiModel.test.js` (7 testes: normalização
e custo); 125 testes de backend passando; build do Vite OK. NÃO houve teste de
UI ao vivo (sem Docker/Postgres nesta sessão) — validar em produção o fluxo
completo com chave OpenRouter real.

**Fora do escopo desta entrega:** "escolher automaticamente o melhor modelo"
(seção 6 da spec) — exigiria um classificador/roteador próprio; o restante da
spec está coberto.

## 🔄 Catálogo de modelos por usuário — OpenRouter voltando a aparecer (2026-07-20 — branch `claude/openrouter-models-sync-wp1krw`)

**Sintoma relatado:** "modelos do OpenRouter que não aparecem no app" — dúvida se
era falta de sincronização.

**Causa-raiz (não era sincronização):** a rota `GET /api/models`
(`backend/src/routes/models.js`) buscava o catálogo SEMPRE com a `base_url` e a
chave do **servidor** (`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` do `.env`),
ignorando o provedor **BYOK de cada usuário**. Como a produção roda
`ALLOW_SHARED_KEY=false` (sem chave de servidor) e o default da base é o DeepSeek,
um usuário com chave própria do OpenRouter recebia um catálogo que NÃO era o dele
(no pior caso, pouquíssimos modelos). Havia ainda um **cache global único**
(`modelsCache`/`modelsCacheAt`) compartilhado entre todos os usuários,
independentemente do provedor de cada um.

**Correção:**
- `backend/src/routes/models.js`: a rota agora resolve
  `getUserProvider(req.userId)` e busca o catálogo na MESMA `base_url`/chave que o
  usuário usa para conversar (o mesmo provider do chat). O cache virou um `Map`
  por chave: `u:<userId>` para quem tem chave própria (o catálogo pode variar por
  conta) e `s:<base>` para quem usa a chave compartilhada do servidor. TTL de 10
  min mantido. Fetch cru preservado (não usa `client.models.list()`) para garantir
  que os campos extras do OpenRouter — `architecture`, `pricing`,
  `supported_parameters` — cheguem intactos ao `registerModelCatalog`
  (é deles que sai a detecção de ferramentas/visão/raciocínio).
- `backend/src/userProvider.js`: `getUserProvider` passou a expor `apiKey` (chave
  crua) no objeto de retorno — uso interno no servidor, para a rota autenticar a
  listagem no provedor do usuário. Aditivo; nenhum consumidor existente muda.

**Verificação:** endpoint real do OpenRouter retorna **339 modelos**; o backend
não descarta nenhum (só exige `id`) e `registerModelCatalog` produz os 339
perfis. `node --check` OK nos dois arquivos; nenhum teste dependia da rota antiga.
NÃO houve teste de UI ao vivo (sem Node/Docker no host desta sessão).

**Não era bug do app (para triagem futura):** cache de 10 min atrasa modelos
recém-adicionados; a aba "Recomendados" do seletor mostra só ~6 (catálogo inteiro
fica na aba "Catálogo"); o "modelo padrão do assistente" e o objetivo "Trabalho
geral" escondem de propósito os ~71 modelos SEM ferramentas (geradores de
imagem/áudio, safety); e a política de dados/provedores da própria conta OpenRouter
pode bloquear modelos na hora de usar ("No endpoints found").

## 🛠️ Modo desenvolvedor / tarefa longa parava no "limite de etapas" (2026-07-20 — branch `claude/dev-mode-long-tasks-issue-dkjnfp`)

**Sintoma:** toda tarefa longa (e todo uso do modo desenvolvedor) morria com
_"Atingi o limite de 60 etapas… dificuldade de extrair os dados… peça em CSV"_,
independente do esforço escolhido. Correções anteriores (aumentar o número) não
resolviam.

**Causa real (2 problemas somados):**
1. `loop.js` calculava `maxSteps = Number(process.env.AGENT_MAX_STEPS || eff.steps)`.
   Como o `.env` tinha `AGENT_MAX_STEPS=30` (vindo do `.env.example`), o **env
   sobrescrevia e cortava em silêncio** o esforço do menu — escolher "Máx" (=60 no
   código) virava 30, e mexer no número do código não tinha efeito. Esse era o "pode
   ser outro problema" que o usuário intuiu.
2. Cada etapa = um turno do modelo (≈uma ferramenta). 60 é pouco para programação
   (clonar → ler dezenas de arquivos → escrever migration/routers/componentes). Ao
   bater o limite, tudo era abortado com uma mensagem **errada** (falava de CSV numa
   tarefa de código) e sem dizer como retomar.

**Correção (`backend/src/agent/loop.js`, `.env.example`):**
- `AGENT_MAX_STEPS` vira **PISO, não teto**: `Math.max(eff.steps, envSteps)`. "Máx"
  vale ≥60 mesmo com env baixo. **NUNCA** voltar a `env || eff.steps`.
- Modo desenvolvedor: orçamento maior via `AGENT_DEV_MAX_STEPS` (padrão 200).
- Teto absoluto `AGENT_HARD_MAX_STEPS` (padrão 1,5× o base): tarefa que **ainda
  rende** (ferramenta ok há ≤2 etapas, rastreado por `lastProductiveStep`/`IDLE_STEP_GRACE`)
  passa do orçamento base até o teto em vez de morrer no meio; se estagnar, encerra.
  Travas de falha (5 seguidas), repetição e pesquisa web **inalteradas**.
- Mensagem de limite honesta e retomável (**Reenviar**), sem o texto de CSV.
- `.env.example`: `AGENT_MAX_STEPS=` em branco (esforço manda), `AGENT_DEV_MAX_STEPS=200`,
  `AGENT_HARD_MAX_STEPS=` documentados.

**Ação de deploy:** conferir o `.env` da VPS — se tiver `AGENT_MAX_STEPS=30`, deixar
em branco para o esforço do menu mandar (agora é inofensivo, mas confunde). Backend-only,
validado com `node --check`.

## 🖥️ Ambiente de Trabalho da IA: execução agrupada em uma sessão (2026-07-20 — branch `claude/unified-ai-execution-session-25rm4h`, PR #59)

Antes, cada chamada de ferramenta virava um cartão solto **"bash 0s"** no chat.
Numa tarefa real, dezenas empilhavam — poluíam a conversa, ocupavam a tela toda
(pior no celular) e não diziam o que a IA fazia (todos com o mesmo nome, sem
contexto). Agora **todas as ferramentas de uma resposta são agrupadas numa única
sessão de execução** (o *Ambiente de Trabalho da IA*).

**Como fica:**
- **Cartão compacto no chat** — enquanto trabalha: "IA trabalhando no projeto" +
  etapa atual + `N etapas · N arquivos · tempo` + botão **Abrir ambiente de
  trabalho**. Ao terminar: "Tarefa concluída" + resumo (`N arquivos · N comandos ·
  nenhum erro · tempo`) + botão **Ver detalhes**.
- **Janela expandida** (overlay em tela cheia) — barra de estatísticas; filtros
  por tipo (Terminal · Código · Arquivos · Pesquisa · Navegador); lista de etapas
  humanizadas com ícone por categoria e status (concluída/executando/erro); etapa
  em execução destacada e acompanhada ao vivo; painel de detalhe com a entrada
  (comando/arquivo/consulta/URL) e o resultado de cada ação. Fechar (X) minimiza
  de volta ao cartão.

**Arquivos:**
- `frontend/src/components/ExecutionSession.jsx` — **novo**. `ExecutionSession`
  (cartão compacto) + `WorkspaceOverlay` (janela ao vivo). Mapa `TOOL_META`
  traduz cada ferramenta (`bash`, `run_python`, `write_file`, `read_file`,
  `list_files`, `zip_outputs`, `web_search`, `web_fetch`, `generate_image`,
  `consultar_cnpj`) → categoria + rótulo humano; fallback genérico para nomes
  desconhecidos.
- `frontend/src/App.jsx` — no render das mensagens, os blocos `type:'tool'` são
  agrupados numa só `<ExecutionSession>` (posicionada no 1º bloco de ferramenta);
  o texto continua inline. Removido o `import { ToolStep }` (agora só o
  `ExecutionSession`). `live = busy && última mensagem` OU alguma etapa `running`.
- `frontend/src/styles.css` — bloco novo no fim (`.esCard*`, `.esOverlay`,
  `.esWindow`, `.esSteps`, `.esStep*`, `.esDetail*`, `.esFilters`, etc.), com
  media query `max-width:640px` (janela em tela cheia; lista vira faixa superior).

**Decisões:**
- **`ToolStep` (em `components.jsx`) foi mantido** como export, só deixou de ser
  usado — remover era risco desnecessário. Se ninguém mais consumir, pode sair
  depois.
- A janela **reconstrói** terminal/arquivos/pesquisa/navegador a partir dos
  eventos que o backend JÁ emite por ferramenta (`tool_start` com `preview` e
  `tool_result` com `content` até 2000 chars, ver `backend/src/agent/loop.js`).
  **Não** é streaming byte-a-byte de terminal real. Nenhuma mudança de backend
  foi necessária — só apresentação. Evolução futura: o backend mandar preview do
  conteúdo do arquivo editado / miniatura da página aberta para enriquecer o
  painel de detalhe.
- Mostra só ações **operacionais observáveis** — nunca o raciocínio interno do
  modelo, conforme pedido.

**Validação:** `npm run build` (vite) compila sem erros e `node --test src/*.test.js`
passa (7 testes). Layout dos três estados conferido em preview visual (dark) antes
do commit. O `dist/` é versionado neste repo, então foi recompilado e commitado
junto. Falta a conferência visual em produção após o deploy da VPS.

## 🏷️ Logos de provedor no seletor de modelos (2026-07-20) — NÃO VALIDADO LOCALMENTE

Cada modelo da lista mostra o logo oficial do provedor antes do nome, e o filtro
**Fornecedor** virou um dropdown próprio com os mesmos logos (o `<select>` nativo
não renderiza imagem).

**Arquivos:**
- `frontend/public/providers/*.png` — 18 logos (164 KB). A pasta `public/` não
  existia no projeto; foi criada agora. O `vite build` copia o conteúdo dela para
  o `dist/`, então os logos entram na imagem de produção (conferido no
  `frontend/Dockerfile`: `COPY . .` + `npm run build`, e `.dockerignore` não
  exclui `public/`).
- `frontend/src/components/ProviderIcon.jsx` — mapeia a família (prefixo do id
  do modelo) → arquivo local; sem logo conhecido, cai num monograma (a inicial).
- `frontend/src/components/FamilySelect.jsx` — dropdown de Fornecedor com logo.
- `frontend/src/styles.css` — bloco novo no fim (`.mpProvIcon`, `.mpProvMono`,
  `.mpFamSelect`, `.mpFamBtn`, `.mpFamPanel`, `.mpFamOpt`).
- `frontend/src/components.jsx` — 3 edições: os 2 imports, `<ProviderIcon>` como
  primeiro filho do `.mpItem` na `row`, e o `<select>` de Fornecedor → `<FamilySelect>`.

**Decisão: os logos são LOCAIS, não CDN.** O patch original puxava de
`https://unpkg.com/@lobehub/icons-static-png@latest/dark/<slug>.png`. Descartado:
tag `@latest` de CDN quebra sozinha sem aviso (mesma razão do item 11 da seção 6),
e asset de terceiro entrega o IP de cada visitante do app a quem hospeda a CDN —
o que num site público com login e LGPD é pior do que os 164 KB economizados. Os
PNGs saíram do protótipo `Seletor de Modelo (offline).html`; arte do conjunto
estático da LobeHub, variante *dark* (ícone claro) — por isso o ladrilho
`.mpProvIcon` é escuro fixo (`#161c2b`) em todos os temas, inclusive nos claros.

**⚠️ NÃO VALIDADO LOCALMENTE — a seção 7 exige `vite build` antes de commitar, e
não deu:** não há Node instalado no host (só dentro do container) e o Docker local
está desativado desde que o app foi para a VPS. A conferência foi ESTÁTICA: JSX
balanceado, variáveis CSS usadas existem (`--r-sm`, `--r-md`, `--panel`,
`--panel2`, `--line`, `--fs-xs`, `--accent`, `--muted`, `--text`) e o `.mpItem` já
é `flex-direction:row; align-items:center`, que é o que joga o ícone para a
esquerda. **Quem validou de fato foi o `npm run build` da VPS** no deploy — se
estiver lendo isto e o build passou, o código compila; resta o visual.

**Pontos observados na tela:**
1. **Risco de corte no dropdown de Fornecedor — RESOLVIDO (2026-07-20).** O
   `.mpFamPanel` deixou de ser `position:absolute` dentro do `.mpPanel`
   (`overflow:hidden`) e passou a `position:fixed` ancorado ao botão via
   `getBoundingClientRect()`, com estilo inline calculado em `FamilySelect.jsx`.
   Agora ele **escapa do clipping** do painel e **vira para cima** quando falta
   espaço embaixo (`maxHeight` ajustado ao espaço disponível), então a lista
   nunca é cortada na borda do painel nem sai da viewport. Fecha em
   scroll/resize (o menu fixo se soltaria do botão que rola junto); o
   `scroll` é capturado (`true`) para pegar também contêineres internos. O CSS
   mantém um fallback `absolute` caso o cálculo de posição não rode. Validado
   com `vite build` (passa).
2. **Microsoft (Phi) e Nous** não têm logo no conjunto — caem no monograma.

**Deploy é na VPS** (`fredericostudio.com.br`), não mais local: `bash atualizar.sh`
lá dentro, que faz `git pull` da `main` + rebuild. Instrução de `docker restart`
no frontend é resquício do setup antigo de desenvolvimento e NÃO se aplica —
em produção o frontend é bundle estático servido pelo Caddy (serviço `web`).

## 🔄 Processamento contínuo: sair/voltar sem perder o andamento (2026-07-20 — branch `claude/chat-async-continuous-processing-un1xho`, PR #54)

O chat agora é um **fluxo contínuo de verdade**: o processamento roda no servidor
independentemente da conexão do front. Se o usuário sai da página, minimiza no
celular, troca de aba ou perde a rede, a tarefa NÃO para — e ao voltar (mesmo
dispositivo/sessão) ele **reconecta ao andamento ao vivo**, com os botões de
pausar/parar funcionando, como se nunca tivesse saído. Se a tarefa terminou
enquanto ele estava fora, a resposta completa aparece na hora.

> **Nota de integração:** esta frente foi **rebaseada sobre o PR #53** (a
> modularização grande: `server.js` → `routes/*`, `App.jsx` → `hooks/*`). Por
> isso as mudanças vivem nos módulos novos, não no monólito antigo.

**O que já existia (não regredir):** o backend já mantinha o run vivo após a
desconexão — o `send()` do POST `/chat` vira no-op quando o cliente some
(`clientGone`), mas `runAgent` continua e salva o resultado; heartbeat `: ping`
a cada 15s; só cancela na desconexão se `CANCEL_ON_DISCONNECT=true`.

**O que faltava e foi adicionado — reconexão ao andamento AO VIVO:**
- `backend/src/liveStream.js` (NOVO): pub/sub + buffer de replay por conversa, em
  memória. `openLiveStream(id)` abre no início do run; `publish(event)` guarda no
  buffer (teto 5000 eventos / 3 MB) e faz fan-out; `subscribe(fn, fromSeq)`
  reproduz o que já passou e assina os próximos; `finish()` segura o buffer por
  90s (carência p/ reconexão tardia). Testes: `liveStream.test.js`.
- `backend/src/routes/conversations.js`: o `send()` do POST `/chat` também faz
  `live.publish(event)`; `finally` chama `live.finish()`. Nova rota SSE
  **GET `/conversations/:id/stream`** (replay + ao vivo, sem disparar run).
  GET `/conversations/:id` agora devolve **`active`** (`isConversationActive`).
- `frontend/src/hooks/useChat.js`: consumo do SSE virou `consumeChatStream`
  (reusado no envio E na reconexão). `reconnectLiveRun` **remonta o balão do
  zero** (replay completo) para não duplicar; `followActiveConversation` religa
  se cair e no fim recarrega a versão canônica do banco. Exposto via
  `followActiveRef` (ponte entre hooks).
- `frontend/src/hooks/useConversations.js`: `openConversation` reconecta quando
  `data.active` e **restaura o modelo salvo** da conversa (antes o seletor caía
  no padrão ao reabrir — bug relatado no teste do celular).
- `frontend/src/App.jsx`: cria o `followActiveRef` e o passa aos dois hooks.

**Desenho (por que assim):** buffer em memória por processo (um único backend).
Se um dia houver réplicas, trocar por pub/sub compartilhado (Redis). A remontagem
do balão é sempre do zero no replay — mais simples e à prova de duplicação; o
`done` no fim reconcilia com o banco.

## 🏗️ Prioridades técnicas: pgvector, hardening HTTP, zod, CI e quick wins (2026-07-20, PR #53 — MERGEADO)

Implementação dos itens de alta prioridade + quick wins da revisão técnica:

**1. Busca semântica com pgvector (escala).** A busca de memórias/chunks
carregava TODAS as linhas do usuário na RAM do Node e calculava cosseno em JS.
Agora `backend/src/memory/vectorStore.js` habilita a extensão `vector`, cria
colunas `embedding_vec vector(384)` + índices **HNSW** e a busca vira
`ORDER BY embedding_vec <=> $query LIMIT n` no banco (searchMemories,
searchChunks e findSimilar em `memoryService.js`). Desenho (não regredir):
- O BYTEA `embedding` continua sendo a FONTE DA VERDADE (reindex/fallback);
  `embedding_vec` é projeção para o índice, espelhada em cada gravação
  (`saveEmbeddingVec`) e preenchida em segundo plano no boot (`backfillVectors`).
- **Fallback automático:** sem a extensão (postgres puro) ou com embeddings
  degradados, tudo segue no caminho JS antigo — nada quebra.
- Compose (dev e prod) agora usa a imagem `pgvector/pgvector:pg16`. Volume
  antigo do `postgres:16-alpine`: rodar `REINDEX DATABASE studio;` uma vez após
  a troca (alpine→debian muda a libc/collation; comentário no próprio compose).

**2. Hardening HTTP (server.js).** `helmet` (CSP desligada — o backend só serve
JSON/SSE), CORS restrito (o fallback `*` foi REMOVIDO; sem `FRONTEND_URL` /
`BETTER_AUTH_URL` nenhuma origem externa é aceita — produção e dev são
mesma-origem via proxy), `trust proxy = 1`, rate limit geral
(`RATE_API_PER_MIN`, padrão 600/min/IP) e limiter apertado SÓ nos POSTs de
`/api/auth` (`RATE_AUTH_PER_15MIN`, padrão 50/15min — o GET de sessão roda a
cada carregamento e não pode ser freado).

**3. Validação estruturada com zod (`backend/src/validation.js`).** Middleware
`validate(schema)` + schemas "loose" (campos desconhecidos passam) aplicados a
13 rotas de escrita (chat, tasks, assistants, clients, templates, memories,
schedules, control...). Mensagens em pt-BR (`z.config(z.locales.pt())`) no
formato `{ error }` que o frontend já entende. Testes em `validation.test.js`.

**Quick wins:** CI no GitHub Actions (`.github/workflows/ci.yml` — testes do
backend com glob `src/**/*.test.js`, testes + build do frontend, install com
`--ignore-scripts`); `ErrorBoundary` no frontend (tela amigável + recarregar em
vez de tela branca); healthcheck do backend nos dois compose (via `node -e
fetch`, a imagem não tem curl); retenção da tabela `usage`/`usage_daily`
(`USAGE_RETENTION_DAYS`, padrão 365, varredura diária em `privacy.js`);
`TERMS_VERSION` agora tem fonte única em `backend/src/privacy.js`, exposta em
`/api/health` (`termsVersion`) e lida pelas páginas legais do frontend
(o valor em `LegalPages.jsx` virou só fallback offline).

Validado: 102 testes backend + 7 frontend verdes, build de produção ok, boot
completo contra Postgres 16 real com pgvector (migrations + índice + backfill +
SQLs de busca com vetores sintéticos), cadastro/login reais exercitando os
validadores e o 429 do limiter de auth.

**Modularização (itens 4 e 7 — feita em seguida, na mesma branch/PR #53):**
- `server.js`: **1713 → 189 linhas.** As ~50 rotas foram movidas VERBATIM para
  15 routers por domínio em `backend/src/routes/` (account, models, assistants,
  pcFolders, inbox, clients, templates, memories, provider, connectors,
  analytics, conversations, tasks, schedules, backup). `routes/helpers.js`
  concentra o compartilhado: `makeRouter()` (o mesmo shim async de sempre —
  todo router NOVO deve usá-lo, nunca `Router()` cru), multer/antivírus,
  `loadAssistant`, `ensureConversation`, limite diário. O server.js ficou só
  com middlewares (segurança/auth/seed), montagem dos routers e boot. Os
  timers das rotinas agendadas agora são armados no boot (`startSchedulers()`),
  DEPOIS das migrations.
- `agent.js`: **2027 → 40 linhas** — fachada que re-exporta os mesmos 33
  símbolos; nenhum importador mudou. Código dividido em 10 módulos em
  `backend/src/agent/`: loop (652), prompts (334), outputs (332),
  orchestrator (293), repair (105), control (102, ÚNICO dono do estado de
  pausar/continuar/parar), webResearch (93), provider (71), vision (60),
  persistence (57). Extração mecânica conferida por diff multiset (zero linha
  alterada/perdida).
- Prompts DOCPRO (10 versões, ~430 linhas) extraídos para
  `backend/prompts/docpro/*.txt`; o novo `backend/src/seed.js` carrega
  `atual.txt` e usa os antigos SÓ para migrar assistentes com prompt padrão
  antigo. Para editar o prompt do DocPro: mexa em `atual.txt` e renomeie o
  anterior para `vN.txt` (o teste do qaFixes valida o valor carregado).
- `App.jsx`: **1822 → 1057 linhas.** Custom hooks em `frontend/src/hooks/`
  (useChat 248, useConversations 112, useFileUploads 103, useAssistants 91,
  useTasks 62, useSpeech 35) e subcomponentes em `frontend/src/components/`
  (ContextPicker, ClientPicker, MemoryTrace). O App continua dono do JSX e do
  estado de UI; hooks recebem dependências por parâmetro.
- Validação da modularização: 102 testes backend + 7 frontend verdes, build
  ok, boot real contra Postgres com smoke test de TODAS as rotas dos 15
  routers, lint no-undef zerado e verificação VISUAL com Playwright (landing,
  login real, aceite LGPD, chat carregado, página /privacidade com a versão
  dos termos vinda de /api/health) — sem nenhum erro de JS de página.

**Rodada de code review (10 achados verificados) + correções, na mesma branch:**
- COOP do helmet desligado (`crossOriginOpenerPolicy: false`): o header zerava
  o `window.opener` do popup OAuth do GitHub e o postMessage
  'fred-github-connected' nunca chegava ao painel.
- Recall do pgvector: novo `knnCandidates()` em vectorStore.js (único dono do
  SQL KNN) roda em transação com `SET LOCAL hnsw.ef_search` alto e
  `hnsw.iterative_scan='relaxed_order'` quando o pgvector ≥ 0.8 suporta
  (detectado em runtime). Se o índice devolver menos que `limit` candidatos
  (usuário pequeno ou truncamento pós-filtro), cai na varredura JS completa; e
  linhas SEM vetor (período degradado/backfill pendente) são varridas como
  RESÍDUO em JS e somadas ao resultado — nada fica invisível.
- `reindexAll()` sem userId agora reindexa TODOS os usuários (antes, o
  `WHERE user_id=?` com undefined→null não casava nada e a troca de modelo de
  embeddings "concluía" sem regravar um vetor sequer).
- `toVectorLiteral` avisa (uma vez, no log) quando a dimensão do embedding ≠
  vector(384) — a troca de EMBEDDING_MODEL não desliga mais o índice em
  silêncio. Índices HNSW + backfill agora rodam em SEGUNDO PLANO no boot (base
  restaurada sem índice não trava mais o app.listen).
- Limites do zod ajustados: orchestrateIds 20→100 (o modo Equipe manda todos os
  assistentes por padrão) e memória 20k→100k com mensagem própria em pt-BR.
- Validações manuais mortas removidas dos 6 routers (o zod é o único dono de
  tipo/tamanho; checagens de NEGÓCIO como isConversationId ficam no handler).
- `updateMemory` só regrava embedding_vec quando o conteúdo mudou (editar
  pin/importância não toca mais no índice HNSW).
- Inbox: regex gulosa que mutilava nomes com "_" trocada por casamento de
  comprimento fixo (`\d+_\d+_[\w-]{6}_`), na listagem e na conversão.
- Frontend: useTermsVersion usa `${API}/api/health` (respeita VITE_API_URL);
  deleteAssistant ganhou o guard Array.isArray de loadAssistants; payload do
  chat unificado num literal só (team via spread condicional).

Pendências da revisão que ficaram para depois (médio prazo): TypeScript
gradual, logs estruturados (pino), testes E2E permanentes no CI (a verificação
Playwright foi manual, no sandbox da sessão) e o `importStatus` global único do
indexer (um import por vez para o app inteiro, herdado do design mono-usuário).

## 🛡️ Antivírus nos uploads (ClamAV) + selos de segurança + hardening (2026-07-20, PR #50 — MERGEADO)

Todo arquivo enviado pelos usuários agora passa pelo **ClamAV** antes de ser
salvo — anexos do chat (`/api/conversations/:id/upload`), caixa de entrada
(`/api/inbox/:client/upload`) e importação de memória (`/api/memories/import`).
Arquivo infectado é recusado com o nome da ameaça; quando a varredura acontece,
a resposta traz `scanned:true` e o frontend mostra "✓ Arquivos verificados pelo
antivírus" (App.jsx/InboxPanel.jsx).

**Divulgação da segurança (pedido do usuário):**
- Tela de login (`LoginScreen.jsx` + `auth.css`, classe `loginTrust`): faixa de
  selos abaixo do cartão — "Arquivos verificados por antivírus", "Conexão
  criptografada" e "Compromisso com a LGPD" (este linka para `/privacidade`,
  página criada pela frente LGPD).
- Landing (`Landing.jsx`, bloco TRUST): 6 cartões em grade 3×2 — dados
  isolados, chave própria (BYOK), credenciais protegidas, **arquivos
  verificados (ClamAV)**, **conexão segura (HTTPS)** e **LGPD**.
- Regra de honestidade: só anunciar o que está ativo. Desativou o ClamAV?
  Remova o selo do login e o cartão da landing.

O PR #50 foi mesclado na main em 2026-07-20, já com a resolução do conflito
contra a frente LGPD (#47–#49) — as duas conviveram no mesmo dia e mexeram em
`server.js`, `LoginScreen.jsx`, `Landing.jsx` e neste arquivo. Deploy na VPS:
`bash atualizar.sh`; primeiro boot do clamav baixa assinaturas (~5 min).

**Desenho (não regredir):**
- `backend/src/clamav.js` fala o protocolo **INSTREAM** do clamd direto por TCP
  (sem dependência nova). Config por env: `CLAMAV_HOST` (vazio = desligado),
  `CLAMAV_PORT` (3310), `CLAMAV_TIMEOUT_MS`, `CLAMAV_REQUIRED`.
- **Fail-open de propósito:** se o clamd estiver fora do ar (ex.: baixando
  assinaturas no primeiro boot, ~5 min), o upload passa SEM verificação e com
  `scanned:false` — o app nunca trava por causa do antivírus. Quem quiser
  fail-closed usa `CLAMAV_REQUIRED=true` (recusa com 503).
- Produção: serviço `clamav` no `docker-compose.prod.yml`, ligado por padrão
  (`CLAMAV_HOST=${CLAMAV_HOST-clamav}` — a sintaxe `-` sem `:` permite
  desativar com `CLAMAV_HOST=` vazio no `.env`). Volume `clamav_db` persiste as
  assinaturas. RAM: ~1–1,5 GB (docs recomendam VPS de 4 GB).
- Dev: mesmo serviço sob `profiles: ["antivirus"]` — só sobe com
  `docker compose --profile antivirus up` + `CLAMAV_HOST=clamav` no `.env`.
- Se desativar o antivírus, retirar o cartão "Arquivos verificados" de
  `frontend/src/Landing.jsx` (não anunciar o que não existe).
- Testes: `backend/src/clamav.test.js` (clamd falso em TCP; roda com
  `node --test src/clamav.test.js`). Teste manual: arquivo EICAR (VPS-DEPLOY.md
  Passo 8.4).
- `VPS-DEPLOY.md` ganhou o **Passo 8** (hardening): unattended-upgrades,
  fail2ban, SSH só com chave e o guia do antivírus.

## 🛡️ LGPD — consentimento, direitos do titular e retenção (2026-07-20, PRs #47–#49)

O app (já em produção) ganhou a camada de conformidade com a LGPD, pedida pelo
usuário a partir de um checklist que foi auditado contra o código real (muita
coisa JÁ existia: chaves cifradas AES-256-GCM, senha com hash do Better Auth,
hard delete de conversa com cascade, cadastro mínimo). Tudo MERGEADO na main:
PR #47 (camada completa), #48 e #49 (correções após teste real do usuário no
celular — ver bullets abaixo).

**O que foi adicionado:**
- **Documentos legais**: `frontend/src/LegalPages.jsx` → rotas públicas
  `/privacidade` e `/termos` (roteadas em `main.jsx`; funcionam no Vite e no
  Caddy via fallback de SPA). Links no rodapé da landing, no cadastro e no app.
  `TERMS_VERSION` ('2026-07-20') existe em DOIS lugares que precisam andar
  juntos: `LegalPages.jsx` e `backend/src/privacy.js` — mudar os textos de
  forma relevante = mudar a versão nos dois → todos reaceitam.
  ⚠️ O controlador está como "Frederico Assessoria Contábil" e o contato
  `contabil@fredericoassessoria.com.br` — o usuário deve conferir razão social.
- **Consentimento (art. 8º)**: checkbox opt-in no cadastro (LoginScreen, POST
  `/api/consent` logo após o signUp); login social/contas antigas caem no
  `ConsentGate` (modal bloqueante no App, via GET `/api/consent` →
  `needsConsent`). Registro em `user_consents` (migration `005_lgpd.sql`) com
  versão, IP, user-agent e data — histórico, não flag.
- **Direitos do titular (art. 18)**: `backend/src/privacy.js` + rotas em
  `server.js`: GET `/api/account/export` (JSON completo, SEM segredos nem
  embeddings), DELETE `/api/account/conversations` (apaga tudo; 409 se alguma
  conversa ainda responde), DELETE `/api/account` (hard delete total: destrói
  workspaces/containers/inbox em disco e `DELETE FROM "user"` — as FKs ON
  DELETE CASCADE levam o resto; exige `{confirm: email}` no corpo). UI:
  `PrivacyPanel.jsx` (menu Administração → "Privacidade e dados").
  Correção pós-teste (PR #48): o diálogo de excluir conta NÃO exibe o e-mail
  cadastrado — mostrá-lo anulava a confirmação por digitação (era copiar e
  colar); a pessoa precisa SABER o e-mail com que entra.
- **deleteConversationDeep** unificou a exclusão profunda (rota antiga de
  apagar conversa agora também remove TAREFAS não-running da conversa — antes
  uma tarefa na fila RECRIAVA a conversa apagada via ensureConversation).
  Correção pós-teste do usuário (PR #49): fatos extraídos com
  `review_auto_memory` ligado vivem em `memory_suggestions`, não em `memory` —
  a exclusão profunda agora limpa as DUAS tabelas, e "Apagar todo o histórico"
  passa uma vassoura final em tudo com `source_type='auto'` (pega órfãos de
  conversas apagadas antes da correção; memórias manuais/importadas ficam).
  Após atualizar, o usuário deve clicar "Apagar tudo" de novo para varrer os
  órfãos que sobraram do teste.
- **Retenção (minimização)**: `CONVERSATION_RETENTION_DAYS` (0 = desligado;
  varredura a cada 6 h em `sweepOldConversations`; documentado no .env.example
  e README).
- **Aviso no chat**: hint fixo no composer ("as mensagens vão ao provedor de
  IA — evite dados sensíveis") com link para /privacidade.
- **Logs**: indexer de memória não imprime mais o título da conversa.
- Cookies: só o essencial de sessão (sem analytics) → banner de cookies NÃO é
  necessário; a política explica isso.

## 🔌 Conector GitHub — primeiro conector do app (2026-07-19)

O app ganhou **Conectores** (Configurações → Conectores), começando pelo
GitHub: o usuário conecta a conta com um token (PAT) e a IA passa a clonar
repositórios, alterar o código e enviar de volta (push/Pull Request) — pelo
chat ou pelo modo desenvolvedor.

**Desenho de segurança (não regredir):**
- Token cifrado por usuário em `user_connectors` (migration `004_connectors.sql`),
  AES-256-GCM com a mesma `ENCRYPTION_KEY` do BYOK; o GET da API só devolve
  estado/conta, nunca o token.
- **O token NUNCA entra no sandbox.** Clone/fetch/pull/push rodam no BACKEND
  (`backend/src/connectors/github.js`, `runGit` com spawn) sobre o workspace da
  conversa (bind-mount do sandbox). A autenticação vai por `http.extraheader`
  POR INVOCAÇÃO — nunca na URL nem no `.git/config` (que o modelo enxerga).
  Toda saída de git passa por `scrubSecrets` antes de voltar ao modelo.
- O modelo edita arquivos e usa git LOCAL (status/diff/commit) pelo bash do
  sandbox; `git push` pelo bash falha de propósito (sem credencial lá).
- Após escrita do backend no repo, `chown -R 1000:1000` (regra da casa: o exec
  do sandbox roda como uid 1000).
- Nomes de repo/branch validados (`isValidRepoFullName`/`isValidBranchName`)
  contra injeção de flag/caminho; `git pull` só `--ff-only` (nunca cria merge).

**Peças:**
- Backend: `connectors/github.js` (ferramentas `github_list_repos`,
  `github_clone` → `/workspace/repo/<nome>`, `github_push`, `github_create_pr`;
  API REST com erros traduzidos), rotas `/api/connectors*` no `server.js`
  (PUT valida o token no GitHub antes de salvar), roteamento `github_*` no
  `runTool` (tools.js). `agent.js`: ferramentas só entram quando o usuário TEM
  conexão (`hasGithubConnection`); em plan/review as de escrita (push/PR) ficam
  de fora (`GITHUB_WRITE_TOOLS`); `developerContextFor` aceita
  `developer.github={repo,branch}` com nota que manda clonar primeiro e, no
  build, commitar/enviar ao final. Dockerfile do backend agora instala `git`.
- Frontend: `ConnectorsPanel.jsx` (conectar/testar/desconectar; exporta
  `GitHubIcon` SVG — lucide não tem mais ícones de marca), `DeveloperPanel.jsx`
  (repositórios GitHub no seletor de projeto com prefixo `gh:`, seletor de
  branch, aviso "conecte a sua conta"), `App.jsx` (botão Conectores no menu,
  `developer.github` no corpo do chat, repo na barra do modo desenvolvedor).
- Envs opcionais: `GITHUB_CLONE_TIMEOUT_MS` (300s), `GITHUB_GIT_TIMEOUT_MS` (120s).
- **Conexão em 1 clique (OAuth)** — pedido do usuário após o PR #45 ("não quero
  colar chave; quero clicar, logar no GitHub e conectar sozinho"): botão
  "Conectar com GitHub" → popup → autorização → conectado. Fluxo próprio (NÃO
  usa o Better Auth): `GET /api/connectors/github/start` (redireciona ao
  authorize com `state` anti-CSRF em memória, uso único, 10 min, amarrado ao
  userId logado) → `GET /api/connectors/github/callback` (troca o code pelo
  token `gho_...`, salva pelo MESMO `saveGithubConnection` cifrado e devolve
  uma página que faz `postMessage` + fecha o popup; o painel escuta e
  recarrega). Requer um **OAuth App dedicado** (o do login não serve — o GitHub
  só aceita um callback por app): `GITHUB_CONNECTOR_CLIENT_ID/SECRET` no `.env`,
  callback `<BETTER_AUTH_URL>/api/connectors/github/callback` (instruções no
  .env.example). Sem essas envs, o painel cai no modo token (em `<details>`
  "alternativa") e avisa o admin. `GET /api/connectors` devolve `oauth:true`
  quando configurado. Cookie de sessão viaja no redirect (SameSite=Lax +
  navegação top-level), então o callback sabe quem é o usuário.
- Testes: `connectors.github.test.js` (validações puras + scrub). Suíte 86/88
  (2 pulados sem Postgres); build Vite ok.
- Próximos conectores sugeridos: Google Drive, Notion — seguir o mesmo padrão
  (tabela `user_connectors`, provider novo, painel no mesmo drawer).

## 🧪 GIMP avaliado e REMOVIDO — inviável headless no sandbox (2026-07-19, PRs #37–#39)

Instalamos o GIMP a pedido e testamos a fundo (13 baterias ao vivo). Conclusão:
**não é usável para automação de imagem neste ambiente**, e foi removido.
- A **GIMP 3.0** (única no Debian atual) mudou muito a API de Script-Fu em
  relação à 2.10 documentada: procedures renomeadas/removidas
  (`gimp-image-get-active-drawable`, `file-png-save`, `plug-in-gauss`, até a
  introspecção `gimp-pdb-proc-exists`). Praticamente não há exemplos 3.0 online.
- **Python-Fu quebrado**: o módulo `gi` (PyGObject) não importa no ambiente de
  plug-ins do GIMP.
- O startup dava para resolver (pré-aquecer o `pluginrc` no build → ~4,5s com
  `xvfb-run`), mas **qualquer erro de script trava até o `TOOL_TIMEOUT_MS` de
  45s** do sandbox, tornando a descoberta da API impraticável.
- **Decisão:** removido do Dockerfile e do inventário (#39). Para imagem em
  lote, o caminho é **imagemagick / Pillow / OpenCV** (headless, rápidos,
  testados — o ImageMagick fez blur gaussiano perfeito no teste). NÃO reinstalar
  o GIMP sem uma necessidade que só ele atenda e um plano para o timeout de 45s.

## 🛡️ Correção do SSRF residual no `web_fetch` (2026-07-19, mesclado em 2026-07-21 — PR #40)

Fecha a **pendência §0** (SSRF residual, aberta desde a revisão de 2026-07-16).
Uma análise crítica do repositório levantou vários pontos de segurança; ao
conferir cada alegação contra o código, a maioria já estava mitigada (o
`isBlockedHost` já cobria faixas privadas IPv4/IPv6, e o `web_fetch` já revalida
cada redirect com `redirect: 'manual'`). Os formatos numéricos decimal/octal/hex
citados como vetores **já eram neutralizados** pelo parser WHATWG de URL (ele
normaliza `http://2130706433/` para `127.0.0.1` antes do filtro). Mas dois furos
reais foram encontrados e corrigidos em `backend/src/tools.js`:

1. **Bypass por IPv6 entre colchetes** (não visto pela análise): o hostname de
   uma URL IPv6 chega **com colchetes** (`[::1]`), e o filtro comparava com
   `::1` sem colchetes — então TODO literal IPv6 (loopback, ULA, link-local e a
   forma IPv4-mapeada `[::ffff:127.0.0.1]`, que o parser normaliza para
   `[::ffff:7f00:1]`) escapava e alcançava a rede interna. Correção: remover os
   colchetes antes de comparar (`stripIpv6Brackets`), tratar IPv4 mapeado nas
   formas pontilhada e hexadecimal (`mappedIpv4`), cobrir toda a faixa
   link-local `fe80::/10` (antes só `fe80` literal) e somar multicast/reservado
   (`224/4`, `240/4`) ao bloqueio IPv4 (`isBlockedIpv4`).
2. **DNS rebinding**: filtro por texto não basta — um domínio público pode
   resolver para IP interno. Novo `assertHostResolvesPublic` resolve o hostname
   via DNS e valida CADA IP retornado antes de conectar, a cada redirect. O
   `AbortSignal` é respeitado também durante a resolução (cancelamento
   continua funcionando). Resta uma janela TOCTOU mínima entre resolver e
   conectar — é a mitigação padrão; um pinning de IP na conexão fica como
   trabalho futuro, se necessário.

**Testes:** novo `backend/src/tools.ssrf.test.js` (8 casos: bypasses corrigidos
+ regressão de endereços públicos que devem seguir liberados). O teste de
cancelamento (`tools.pathResolution.test.js`) passou a usar IP literal, que pula
o DNS via `net.isIP` e exercita o repasse do sinal de forma determinística.
Suíte do backend: 88 passam, 0 falham (2 pulados exigem PostgreSQL).

**NÃO alterado de propósito:** a senha `studio` do Postgres nos `docker-compose*`
é fixa; trocá-la no repositório quebraria o deploy em produção em execução — é
mudança de operação (variável `POSTGRES_PASSWORD` + atualização do banco) a
cargo do operador.

## 🎨 Kits de design de documentos + endurecimento por QA ao vivo (2026-07-19, PRs #24–#35)

Frente para elevar a QUALIDADE e a CONFIABILIDADE dos documentos gerados
(Word/Excel/PDF), toda verificada AO VIVO na produção (login real, assistente
"Documentos profissionais", modelo real, arquivos baixados e inspeccionados
byte a byte).

### Três kits de design prontos no sandbox (mesma identidade visual)
Instalados na imagem do sandbox (`sandbox/Dockerfile` copia para
`site-packages`), evitam o modelo reinventar o estilo na mão:
- **`docpro.py`** → `from docpro import Relatorio` (Word): capa, títulos com barra
  lateral, tabelas sem bordas verticais com cabeçalho colorido + zebra, callouts,
  KPIs, rodapé "Página X de Y" e conversão a PDF.
- **`xlspro.py`** → `from xlspro import Planilha` (Excel): tabelas com cabeçalho
  `1A3C6E` + zebra, formatos R$/%/milhar, congelar cabeçalho, linha TOTAL,
  múltiplas abas e gráficos (barras/linhas/pizza).
- **`pdfpro.py`** → `from pdfpro import RelatorioPDF` (PDF, reportlab): capa em
  página própria, tabelas estilizadas, callouts e rodapé "Página X de Y".
- **`docpro.Sobrio`** → `from docpro import Sobrio` (Word SÓBRIO/registrável — ata,
  contrato, alteração contratual): estilo Normal que **já nasce JUSTIFICADO**
  (`jc=both`), Times New Roman 12, entrelinha 1,5, margens oficiais, ZERO cor,
  rodapé paginado. Métodos: `titulo`, `secao`, `paragrafo`, `item`, `fecho`,
  `assinaturas`, `salvar` (+PDF). A justificação é estrutural, não depende do
  modelo lembrar (#35).
- Paleta comum: `1A3C6E`/`2E75B6`/`262626`/`595959`/`F2F6FA`/`D9E2EC`.

### Prompt do assistente "Documentos profissionais" (DOCPRO_PROMPT, hoje v10)
Versão migra automática por usuário (`seedDocProAssistant`: LEGACY/V2…V9 → atual,
sem tocar em prompts personalizados). Evolução:
- **v6 (#28):** ensina os TRÊS kits com exemplos concretos (antes só Word) — o
  modelo importava xlspro/pdfpro mas escrevia tabela com openpyxl cru.
- **v7 (#29):** exige preencher TODAS as colunas, calcular colunas derivadas
  (Total = Qtd×Preço) e incluir linha de TOTAL geral; fórmulas apontando a célula
  real.
- **v8 (#30):** gráfico de pizza/participação em formato LONGO (categoria por
  linha), não coluna de totais por período.
- **v9 (#33):** ZERO PLACEHOLDER passa a proibir preenchimento geográfico
  genérico ("Cidade/Estado", "Rua Nova") — usar local concreto (ex.: Palmas/TO);
  primeira tentativa de justificar o documento sóbrio via instrução no prompt.
- **v10 (#35):** a regra de documento SÓBRIO passa a mandar usar
  `from docpro import Sobrio` (justificação estrutural, ver acima), em vez de
  instruir o modelo a alinhar cada parágrafo — o modelo ignorava a instrução.

### Validação (`validateOutputs`/`check_charts` em `agent.js`)
- **Gráfico com série de valores vazia (#29):** resolve as refs dentro de
  `<val>` e reprova (`ok:false`) quando o intervalo plotado não tem número —
  pega a coluna declarada no cabeçalho mas deixada vazia. Não gera falso
  positivo em categorias de texto.

### Kits à prova de crash (#31) — o bug mais grave desta frente
Uma linha com nº de valores ≠ cabeçalho estourava `IndexError` no kit e **matava
a tarefa inteira → zero arquivo entregue**. Corrigido nos três:
- `xlspro.tabela`: célula além do cabeçalho é escrita sem formato, sem crash.
- `docpro.tabela` / `pdfpro.tabela`: normalizam cada linha para a largura do
  cabeçalho (completam curtas, cortam extras) — python-docx e reportlab exigem
  tabela retangular.
- `xlspro.grafico_*`: erro claro quando o 2º arg não é o dict de `p.tabela()`.

### Gráficos excluem a linha TOTAL (#32)
`_grafico` incluía a linha "Total" como fatia/barra gigante (= soma das demais).
`tabela()` devolve `info["total"]` e `_grafico` exclui essa última linha.

### Provas ao vivo (produção, após cada deploy)
- **Excel pesado** (12 meses, 3 abas, DRE, 3 gráficos): 0 falhas; participação
  soma 100%; DRE com margem coerente; faturamento anual bate; pizza por produto;
  gráficos sem a linha Total.
- **Word longo:** 7 tabelas estilizadas, callouts info/alerta/crítico, rodapé
  paginado, sem placeholder.
- **PDF:** capa própria, tabela com TOTAL somado, callout, "Página X de Y".
- **Ata registrável (sóbria):** zero cor, estrutura jurídica completa, dados
  concretos (Palmas/TO) e — com o helper `Sobrio` (v10) — corpo JUSTIFICADO com
  garantia estrutural (Normal `jc=both`, verificado no docx gerado). Reforço só
  no prompt (v9) não bastava: o modelo ignorava a justificação; embutir no kit
  resolveu. Resíduo conhecido: o modelo às vezes ainda escreve um bairro genérico
  ("Bairro Novo") — é conteúdo, não formatação, e "Bairro Novo"/"Rua Nova" são
  nomes reais, então não dá para barrar na validação sem falso positivo.

### Também nesta frente (rounds anteriores da mesma branch)
- **#23:** geração de arquivo após pesquisa web (causa-raiz, todos os modelos):
  `tools=[]` removia o `run_python` depois de um web_search; passou a filtrar só
  as ferramentas web (`WEB_TOOL_NAMES`).
- **#24:** documentos com tabelas (regra forte) + resultado não se perde ao sair
  da página (backend continua e salva; frontend faz `recoverPendingReply`).
- **#25/#26/#27:** design profissional de Word e nascimento dos kits docpro,
  depois xlspro/pdfpro.

## 🛡️ Endurecimento de QA — geração de documentos, contexto longo e multi-modelo (2026-07-19)

Auditoria de caça a bugs (relatório em `docs/RELATORIO_BUGS_QA.md`) seguida da
correção de todos os achados. Suíte do backend verde (79 testes) + novos testes
em `backend/src/qaFixes.test.js` e `toolProtocol.test.js`. Destaques:

- **Validação de Excel que mentia (crítico):** `validateOutputs` lia a *string*
  da fórmula (openpyxl) e nunca via `#REF!`/`#DIV/0!`, dando "ok" falso. Agora
  recalcula com LibreOffice (recálculo-ao-abrir), faz lint das fórmulas e, sem
  recálculo disponível, rotula "verificação parcial" em vez de alegar sucesso.
  Passou a validar `.xlsm`, cobre `.docx` vazio e tem teto de células.
- **Contexto longo:** `estimateTokens` ficou ciente de alfabeto (não subestima
  mais 2–3× em japonês/árabe/cirílico); `trimForTokens` corta pelo custo real;
  modelos `:free` de janela grande não são mais rebaixados a 18k (`contextBuilder`).
- **Multi-modelo:** especialistas rodam em PARALELO (controle com `Set` de
  requisições ativas); parecer truncado é continuado e/ou marcado; briefing com
  limites maiores e corte visível; **failover automático de modelo**
  (`MODEL_FALLBACKS` + modelo-base) quando o provedor cai, sem perder o trabalho.
- **Robustez:** coletor de lixo de disco (`.tmp_*` órfãos + `OUTPUT_RETENTION_DAYS`),
  `guardCommand` mais robusto, detecção de arquivo novo por `mtime:size`, avisos
  do sistema fora dos arquivos materializados, aviso honesto sobre macros VBA.
- Novas envs (todas opcionais, padrões seguros): ver `.env.example` e README.

### Bugs de produção + validações extras (mesma frente, PR #22)

Testes **ao vivo na produção** (login real, modelos reais, arquivos baixados e
inspecionados) revelaram e corrigiram mais bugs de nível de app:

- **Vazamento do protocolo de ferramenta no chat** (consulta de CNPJ): o stream
  guard era desligado no modo SEM ferramentas (`enabled=false` repassava tudo),
  então `<tool_call>/<function=run_python>/`código python-docx vazavam. Agora o
  guard suprime o protocolo **sempre** (`toolProtocol.js`).
- **Loop de repetição** do modelo (eco do prompt): freio `looksDegenerate` corta
  a saída degenerada com aviso (`agent.js`).
- **Formatação estourando a tela no mobile:** `overflow-wrap`/`word-break` no
  conteúdo; `pre`/tabelas rolam na caixa (`frontend/src/styles.css`).
- **Modelo executava o código em vez de salvar:** ao pedir para GERAR/SALVAR um
  programa, o modelo rodava o script (só imprimia o help) e não gravava o `.py`;
  reforço no prompt e no reparo de execução para ESCREVER o arquivo em outputs.
- **Validação de gráficos do Excel:** `validateOutputs` lê os `xl/charts/*.xml`
  e marca o arquivo como não-ok quando um gráfico tem referência quebrada
  (intervalo invertido tipo `C2:B2`, aba inexistente, sem série/refs) — o
  recálculo de fórmulas não cobria gráficos.
- **`recalc_took`:** reconhece o recálculo mesmo quando TODAS as fórmulas viram
  erro (antes exigia valor numérico e descartava o pior caso, o all-error).

**Verificado em produção após deploy da branch:** ÷0 agora dá
`ok:false, "1 célula com erro de fórmula"` (antes "ok, 1 abas"); code-gen com
contexto de 25k reteve o requisito enterrado E salvou o `.py`; guard, repetição
e CSS sem incidentes na bateria Word/Excel/PDF/código. Estado dos achados e das
provas: `docs/RELATORIO_BUGS_QA.md`. **Gap aberto:** o app não confere o valor
numérico que o modelo afirma no texto vs. o da fórmula no arquivo.

## ✅ SaaS COMPLETO E EM PRODUÇÃO (2026-07-18)

As 5 fases da transformação em SaaS estão CONCLUÍDAS e o app está NO AR:

- **Fase 1** — PostgreSQL (migração do SQLite).
- **Fase 2** — Login por usuário (Better Auth: e-mail/senha + GitHub/Google).
- **Fase 3** — Isolamento por usuário (multi-tenant) + BYOK + limites (pastas do
  PC por usuário, `RATE_MSGS_PER_DAY`, `MAX_SANDBOXES_PER_USER`).
- **Fase 4** — Página de apresentação (landing) antes do login, com a seção
  "modelo de verdade" (acesso transparente ao modelo).
- **Fase 5** — Produção na VPS com Docker + Caddy (HTTPS automático).

**PRODUÇÃO AO VIVO:**
- URL: **https://fredericostudio.com.br** (domínio no Registro.br; registro **A**
  na raiz apontando para o IP da VPS).
- **www com certificado próprio**: `www.fredericostudio.com.br` tem bloco no
  Caddyfile (via `WWW_DOMAIN` no compose de produção) que emite o certificado e
  redireciona (308) para a raiz. O DNS do `www` já apontava para a VPS; para
  ativar, rodar `bash atualizar.sh` no servidor.
- Hospedagem: **Contabo** Cloud VPS (Ubuntu + Docker). Sobe via
  `docker-compose.prod.yml`: serviços `postgres` + `backend` + `web` (Caddy);
  o backend não é exposto (só pelo proxy).
- Modo: **PÚBLICO com BYOK** (`ALLOW_SHARED_KEY=false`) — cada usuário cadastra
  a própria chave em Configurações → Provedor de IA. Sem chave do servidor.
- Segredos (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`) vivem no `.env` **do servidor**
  (nunca no repo). Login social (GitHub/Google) **não** configurado em produção —
  só e-mail/senha (para ativar: preencher credenciais no `.env` + callback
  `https://fredericostudio.com.br/api/auth/callback/{provider}`).
- **Botões sociais agora são automáticos**: o backend só registra os provedores
  com credenciais no `.env` e publica a lista em `/api/health` →
  `socialProviders`; a tela de login só mostra os botões que funcionam. Antes,
  clicar em Google/GitHub sem credenciais dava 500 silencioso e o spinner
  travava o formulário inteiro (parecia que até o cadastro estava quebrado —
  o `signIn.social` da Better Auth devolve `{ error }` em vez de lançar, e o
  retorno não era tratado).

**Operação (no servidor, pasta do projeto):**
- Atualizar: `git pull && docker compose -f docker-compose.prod.yml up -d --build`.
- Backup: `docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U studio studio > backup.sql` + `tar czf workspaces.tgz workspaces`. Guia: `VPS-DEPLOY.md`.

**Melhorias recentes de qualidade (já na main):** ferramenta `consultar_cnpj`
(#7), busca gratuita mais robusta com fallback DuckDuckGo (#8), e revisão do
system prompt — pesquisa humanizada, persona com voz/público, deduplicação e
tom mais humano em todas as camadas mantendo os guarda-corpos (#9–#11).
- **Deploy/operação** (#14, #17): `docker-compose.prod.yml` e `VPS-DEPLOY.md`
  atualizados para login multiusuário + Postgres; `atualizar.sh` (na VPS:
  `git pull` + rebuild + limpeza + status), preservando dados.
- **Câmera no chat** (#18): `CameraCapture.jsx` — foto pela webcam (getUserMedia)
  no desktop e câmera traseira no celular, com "enviar da galeria" de reserva e
  compressão canvas→JPEG. A foto entra pelo mesmo pipeline de anexo
  (`uploadSelectedFiles`); `sendMessage` usa pedido padrão quando só há anexo.
  `uploadsNote` (agent.js) instrui OCR automático de imagem + tratar foto
  borrada com gentileza.
- **Visão multimodal real** (#19): em `agent.js`, quando o modelo TEM visão
  (`capabilities.vision`), as imagens dos uploads vão como `image_url` (base64,
  máx. 4 / 8 MB) na última mensagem do usuário; modelos sem visão seguem no OCR.
  Fallback: `isUnsupportedVisionError` → remove imagens e refaz (OCR).
  `modelCapabilities.js`: detecção de ferramentas aceita tools/tool_choice/
  functions; `FALLBACK_MODELS` atualizada. As capacidades por modelo continuam
  detectadas automaticamente do OpenRouter (não há lista manual).

**Pendências/ideias futuras:**
- Se for divulgar amplamente (indexado), adicionar **confirmação de e-mail** e/ou
  **aprovação de conta** — hoje qualquer um se cadastra (recomendado divulgar
  "por link"). O sandbox executa código com internet: manter a VPS dedicada.
- Migration 004: `user_id` NOT NULL após confirmar todos os inserts com dono.

---

## 0.-1 FASE 3 — CONCLUÍDA — Isolamento por usuário (2026-07-18)

**Parte 1 (fundação)** — commit `8022cec`: migration 003 adiciona `user_id`
(NULLABLE) às 11 tabelas de topo + índices; cria `user_settings` (BYOK) e
`usage_daily`; `crypto.js` (AES-256-GCM: encryptSecret/decryptSecret/maskSecret).

**Parte 2a (isolamento central) — CONCLUÍDA E TESTADA:** cada usuário só vê/mexe
nos PRÓPRIOS dados. Feita com 2 subagentes sob contrato: `server.js` (todas as
rotas escopadas por `req.userId`; posse verificada em `WHERE id=? AND user_id=?`
→ 404; seeds de assistentes/templates/docpro agora POR USUÁRIO via
`ensureUserSeeded` + middleware; `ensureConversation` retorna null p/ id de outro
dono → 404) e `agent.js`/memória (assinaturas com `userId` primeiro:
`saveMessage(userId,...)`, `persistAssistantReply(userId,...)`,
`runAgent/runOrchestrator({userId,...})`, memoryService `fn(userId,...)`; queries
de memory/chunks escopadas por `user_id` ALÉM do `scope`). `migrate.js` ganhou
advisory lock (serializa migração entre processos). **Testado:** teste A-contra-B
por HTTP (16/16: B recebe 404 em tudo de A; cada um vê o próprio; seed por
usuário) + suíte 42/42.

**Parte 2b (BYOK) — CONCLUÍDA E TESTADA** — commits `1747da7` (backend) e
`86cf216` (frontend): cada usuário usa a PRÓPRIA chave de API. `userProvider.js`
(`getUserProvider(userId)` → chave do usuário decriptada de `user_settings`, ou
`SERVER_KEY` se `ALLOW_SHARED_KEY!==false`); `agent.js` usa `provider.client`;
sem chave → orienta ir em "Provedor de IA". Rotas `GET/PUT /api/provider` e
`POST /api/provider/test` (GET só devolve a chave mascarada). Tela
`ProviderPanel.jsx` no frontend. Armazenamento criptografado verificado.

**Parte 2c (limites + isolamento do sandbox) — CONCLUÍDA E TESTADA** (2026-07-18):
- **⚠️ CORRIGIDO o vazamento das PASTAS DO PC:** `sandbox.js` deixou de usar um
  cache GLOBAL. Agora `loadPcFolders()` agrupa por usuário (`pcFoldersByUser`) e
  `pcFolderMounts(userId)` monta SÓ as pastas daquele usuário; sem `userId`,
  nenhuma pasta (default seguro). O `userId` viaja em `sandboxOptions` de
  `runAgent`→`runTool`→`execInSandbox`→`getContainer`→`createContainer`.
  `tools.js` resolve caminhos `/mnt/pc/...` pelas pastas do usuário atual.
  **Testado:** dois usuários A/B com pastas próprias — cada um só vê a sua, e sem
  userId retorna zero.
- **Limite diário de mensagens:** `RATE_MSGS_PER_DAY` (env; 0 = sem limite,
  padrão). `usage_daily` conta por usuário/dia (UPSERT atômico
  `ON CONFLICT ... RETURNING`, sem perda em concorrência — testado). Aplicado no
  `POST /api/conversations/:id/chat` e no `POST /api/tasks` (429 ao estourar).
- **Limite de sandboxes por usuário:** `MAX_SANDBOXES_PER_USER` (padrão 2). Ao
  abrir o (N+1)-ésimo, o mais antigo do mesmo usuário é encerrado (LRU). O
  `session` do sandbox agora guarda `userId`.
- **Correção de isolamento:** `POST /api/tasks` passou a verificar a posse da
  conversa (404 se for de outro usuário) — antes só criava sem checar o retorno.

**FALTA na Fase 3 (itens menores, isolamento já se sustenta):**
- **Workspaces por CAMINHO de usuário** (`workspaces/<userId>/<conv>`): hoje o
  workspace é por convId. O isolamento se sustenta (convId é PK único, posse
  verificada antes; as pastas do PC agora são por usuário), então é só
  organização de diretórios — cosmético. Se for feito, precisa migrar os
  workspaces existentes.
- `maybeReindexOnModelChange` chama `reindexAll()` sem userId → hoje é no-op
  (reindex por troca de modelo virou por-usuário; decidir como disparar).
- Migration 004 futura: tornar `user_id` NOT NULL depois de confirmado que todo
  INSERT passa o dono. Preferências de memória seguem GLOBAIS (aceitável por ora).

## 0.0 ATUALIZACOES MAIS RECENTES (2026-07-17)

Leia primeiro o estado de transformacao SaaS na secao seguinte.

- **Acesso movel por Tailscale corrigido:** o print mostrava o Chrome do celular
  em `localhost:5173`; nesse aparelho, localhost aponta para o proprio celular e
  a conexao e recusada. O Tailscale Serve estava ativo e o defeito adicional era
  `BETTER_AUTH_URL=http://localhost:5173`, que gerava callback OAuth para o PC.
  A instalacao local agora usa a URL HTTPS do Serve como base canonica. O login
  social envia um callback final absoluto para a mesma origem em que foi iniciado,
  evitando voltar acidentalmente para localhost. README e `.env.example`
  documentam a configuracao e os callbacks de GitHub/Google. Validacao: pagina
  abriu pela URL HTTPS do Tailscale, callback do GitHub passou a usar o host
  `.ts.net`, 7 testes de frontend passaram, build Vite concluiu e `/api/health`
  respondeu normalmente.
- **Correcao critica de chamadas de ferramentas e downloads:** o PDF
  `Frederico AI Studio.pdf` mostrou o Nemotron devolvendo uma chamada
  `run_python` inteira como texto (`<tool_call>...codigo...</tool_call>`). O
  frontend exibiu esse protocolo como resposta, a ferramenta nunca foi
  executada e nenhum DOCX foi criado. A causa nao era apenas visual: alguns
  provedores/modelos emitem uma imitacao textual quando deveriam preencher
  `delta.tool_calls`.
- **Adaptador defensivo no streaming:** `backend/src/toolProtocol.js` agora
  reconhece o formato textual XML/JSON, inclusive quando o marcador chega
  dividido entre varios fragmentos. O protocolo e ocultado antes de chegar a
  tela, nomes de ferramentas sao conferidos contra a lista realmente oferecida
  e chamadas validas sao convertidas em chamadas estruturadas. Formatos
  incompletos ou ferramentas desconhecidas nao sao executados; ha uma tentativa
  forcada pelo protocolo nativo e depois uma falha curta com a acao Reenviar.
- **Entrega de arquivo virou criterio de sucesso:** pedidos de DOCX, XLSX, PDF
  ou outro arquivo ficam como execucao incompleta quando nenhum arquivo real
  aparece em `/workspace/outputs`, mesmo que o modelo nao tenha escrito um
  caminho. Arquivo existente gera cartao de download; resposta vazia com
  arquivo recebe uma conclusao curta. O frontend recebe `execution_failed`,
  marca a resposta e, ao usar Reenviar, remove do banco a tentativa quebrada,
  seus arquivos e o contexto de memoria derivado antes de repetir o pedido.
- **Prompts revisados:** todos os assistentes recebem um contrato central de
  execucao e experiencia: ferramenta so pelo protocolo nativo, nada de codigo,
  XML, argumentos ou promessas repetidas no chat, conclusao pelo resultado e
  falha em linguagem comum. O inventario enorme do sandbox so entra em consultas
  sobre ambiente ou no modo desenvolvedor. O assistente `Documentos
  profissionais` ganhou prompt versionado `2026-07-17-v2`, orientado a entregar,
  validar e anexar o arquivo; prompts personalizados pelo usuario sao
  preservados.
- **Memoria e historico protegidos:** respostas antigas com protocolo textual
  sao saneadas ao carregar a conversa, montar contexto, indexar memoria e
  exportar PDF/DOCX. Isso evita que o erro reapareca por contaminacao do
  historico. As mensagens originais continuam no banco ate o usuario reenviar
  ou editar, evitando apagar dados sem consentimento.
- **OpenRouter:** chamadas com ferramentas exigem provedores que aceitem os
  parametros solicitados (`require_parameters`). A ordenacao fixa por
  `throughput`, que podia preferir um endpoint menos confiavel para ferramentas,
  foi removida. `OPENROUTER_PROVIDER_SORT` continua disponivel como escolha
  explicita.
- **Validacao desta correcao:** 51 testes do backend e 4 testes do parser SSE
  passaram nos containers reais (55 no total), alem do build Vite de producao.
  O prompt v2 foi confirmado no PostgreSQL, `/api/health` ficou saudavel e o
  frontend respondeu HTTP 200. O teste visual automatizado chegou a tela de
  login; o fluxo autenticado nao foi executado com uma conta artificial.
- **Controles de execucao e pesquisa web na main:** o PR #4 integrou o commit
  `d242c23`. Pausar, continuar e parar agora controlam a execucao real; parar
  tambem cancela ferramentas em andamento, e a pesquisa web filtra URLs
  repetidas e tem limites por etapa e por tarefa para evitar loops.
- **README atualizado na main:** a pagina principal agora descreve PostgreSQL,
  Better Auth, sandbox com rede habilitada, configuracao atual, seguranca e o
  limite conhecido de multi-tenancy. Foram removidas as afirmacoes antigas sobre
  SQLite, ausencia de login e sandbox sem rede.
- **Validacao das correcoes de execucao:** 42 testes passaram; 1 teste de
  persistencia de DOCX foi pulado sem PostgreSQL de teste. O frontend compilou
  dentro do container e backend (`/api/health`) e frontend (HTTP 200) foram
  verificados apos o deploy.

### Regra obrigatoria de handoff e GitHub

Para TODA modificacao futura de codigo, comportamento, configuracao ou
documentacao relevante:

1. Atualizar este `CONTINUIDADE.md` no mesmo conjunto de mudancas.
2. Revisar o diff e validar o que foi alterado.
3. Criar um commit descritivo em portugues, apenas com os arquivos da tarefa.
4. Enviar o commit ao GitHub na mesma sessao (`git push`).

Nao incluir automaticamente `frontend/dist/`, lockfiles alterados por ambiente,
notas soltas ou arquivos de outra frente de trabalho. Eles so entram mediante
revisao explicita.

> Documento de handoff para continuar o desenvolvimento em uma nova sessão.
> Última atualização: 2026-07-17. Leia isto ANTES de qualquer mudança.
>
> **2026-07-17 — Faxina de documentação:** removidas menções a recursos que
> NÃO existem mais no app — o **Calendário fiscal** (obrigações de Tocantins:
> GIAM/ICMS, SPED Fiscal) e os apps embutidos de viés fiscal (NF-e, conciliação,
> comparador de regimes). Eles foram retirados do código no commit `bbd2d19`
> ("torna o app um estúdio geral"); só sobravam nestas anotações e nos
> comentários do `sandbox/Dockerfile` (também neutralizados agora). O app é um
> **estúdio geral**, sem viés contábil/fiscal.

## 0. ESTADO ATUAL — Transformação em SaaS multi-tenant (2026-07-17)

> **LEIA PRIMEIRO.** O app está sendo transformado de single-user (sem login) em
> **SaaS multi-tenant**, seguindo o plano em `PROMPTSAAS.md` (5 fases). Abaixo, o
> ponto exato em que paramos.

**Fases (do `PROMPTSAAS.md`):**
1. ✅ **PostgreSQL** — CONCLUÍDA e testada (rodando na máquina do usuário).
2. ✅ **Better Auth (login e-mail/senha + GitHub + Google)** — CONCLUÍDA e testada
   pelo usuário (login pelo GitHub funcionando, IA respondendo).
3. ⏳ **Isolamento por usuário (multi-tenancy) + BYOK** — PRÓXIMA. Não iniciada.
4. ⏳ **Landing page** — não iniciada.
5. ⏳ **Produção (VPS + domínio)** — não iniciada.

**O que a Fase 1 fez (commit `15e6ebd`):** trocou SQLite (better-sqlite3, síncrono)
por **PostgreSQL** (`pg`, assíncrono). `backend/src/db.js` virou uma casca de
compatibilidade sobre o `pg` (mantém `db.prepare(sql).get/all/run`, mas agora
tudo é `await`; traduz `?`→`$n`; transação real via AsyncLocalStorage). Schema em
`backend/migrations/*.sql` + runner `backend/src/migrate.js` (roda no boot).
Decisões: datas e JSON ficam como **TEXT** (preserva o comportamento antigo);
embeddings viram **BYTEA**; `rowid`→coluna `seq BIGSERIAL` nas mensagens;
`MAX(a,b)`→`GREATEST`; `COUNT/SUM` viram string no pg (usar `Number()`); GROUP BY
estrito. Compose ganhou serviço `postgres:16-alpine`. **`getSettings()` e
`pcFolderMounts()` continuam SÍNCRONOS via cache em memória** (carregado no boot),
para não quebrar em cascata. Shim no `server.js` encaminha rejeições de handlers
async ao middleware de erro (Express 4 não faz isso — sem ele, um erro de query
derrubava o processo). `/api/backup` agora usa `pg_dump`.

**O que a Fase 2 fez (commits `8a3f20a`, `cd9516a`, `92601d1`):** login com
**Better Auth** (v1.6.x) usando o mesmo Postgres. Backend: `backend/src/auth.js`
(instância `betterAuth` + middleware `requireAuth` que põe `req.userId`);
`migrations/002_better_auth.sql` (tabelas `user/session/account/verification`,
schema gerado pela CLI oficial — nomes camelCase entre aspas); no `server.js` o
handler `/api/auth/*` é montado ANTES do `express.json`, e todas as rotas `/api`
exigem login (exceto `/api/health` e `/api/auth/*`). Removidos a senha única
antiga (APP_PASSWORD) e a rota `/api/login`. Frontend: `authClient.js`,
`AuthGate.jsx` (portão que mostra login ou app), `LoginScreen.jsx` (e-mail/senha
+ GitHub/Google, ícones de marca em SVG inline), `auth.css`; o `App.jsx` recebe
`user` por prop e ganhou botão "Sair". Como o app usa `fetch` relativo, o cookie
de sessão vai automaticamente em toda chamada (inclusive SSE).

**Variáveis novas no `.env`** (ver `.env.example`): `DATABASE_URL`, `DATA_DIR`,
`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `GITHUB_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`. O usuário criou os OAuth Apps (GitHub/Google) com
callbacks `http://localhost:5173/api/auth/callback/{github,google}` (dev). Os
segredos (BETTER_AUTH_SECRET, ENCRYPTION_KEY) vieram de `openssl rand -hex 32`.
**`ENCRYPTION_KEY` ainda NÃO é usada** — ela é para o BYOK da Fase 3 (criptografar
a chave de API de cada usuário com AES-256-GCM).

**Pendências conhecidas / próximos passos:**
- **Fase 3** é a próxima: coluna `user_id` em toda entidade de topo (conversas,
  assistentes, memórias, chunks, análises, configurações, tasks, schedules,
  pc_folders, clients, templates, inbox), posse verificada na query
  (`WHERE ... AND user_id=$userId`, 0 linhas → 404), workspaces por usuário
  (`WORKSPACE_ROOT/<userId>/<conversationId>` + bind com `HOST_WORKSPACE_ROOT`),
  chave do Map de sandboxes vira `${userId}:${conversationId}`, memória escopada
  ao usuário, e **BYOK** (`user_settings` com a chave criptografada por
  `ENCRYPTION_KEY`; `agent.js` usa a chave do usuário logado). Script opcional
  `import-sqlite.mjs` para migrar os dados antigos do dono.
- **Login no celular (Tailscale):** hoje os callbacks OAuth são só `localhost`.
  Para o celular, adicionar a URL do Tailscale/domínio nos apps do GitHub/Google
  e ajustar `BETTER_AUTH_URL`/`FRONTEND_URL`.
- **Dado antigo:** ao subir a versão nova, o banco Postgres começa VAZIO (os
  dados do SQLite antigo não migram sozinhos — é o esperado no multi-tenant).

**Validação feita:** Fase 1 testada contra um Postgres real (migrations, transação
commit/rollback, BYTEA, ON CONFLICT, ordenação/truncamento por `seq`, rotas da
API) + suíte 36/36. Fase 2 testada via API server-side da Better Auth (cadastro,
login, senha errada rejeitada) e **confirmada pelo usuário no navegador** (login
GitHub + IA respondendo). Os testes de banco pulam sozinhos se não houver Postgres.

**Ambiente Windows do usuário:** roda por `docker compose up --build` (o
`iniciar.bat` teve os finais de linha corrigidos para CRLF via `.gitattributes`
no commit `617d369`). Mudou o `.env`? Precisa recriar o container do backend
(`docker compose up` de novo). Trocou de branch e o site mostra versão antiga?
`docker compose down` + `up --build` (o container do frontend não recria sozinho).

---

## 0. PONTO ATUAL (2026-07-16) — protótipo v2, ícones/cor, faxina de CSS

Sessão focada em aplicar o **protótipo aprovado no claude.ai/design**
(`Frederico AI Studio v2.dc.html`) no app real, com validação ao vivo por
estilo computado (o screenshot do painel não funciona nesta sessão).

- **Camada `v2.css`** (novo arquivo, importado POR ÚLTIMO em `main.jsx`): refino
  visual sobre as classes do `styles.css` + componentes novos. Vence empates por
  ordem de carga. Cabeçalho do arquivo documenta a arquitetura. **Regra das 7
  paletas:** cores saem de `var(--accent/--muted/--line)` ou `color-mix` — nunca
  hex fixo, senão Claro/Sépia herdam azul.
- **Protótipo v2 aplicado:** breadcrumb `cliente › conversa` na topbar; rodapé da
  sidebar com status do servidor (verde/âmbar, derivado de `unprotected`); **chips
  do composer** (Pesquisa web, Esforço, Ditar, Executar em 2º plano) — o menu ⚙
  (`.cmpMenu`) foi **eliminado** por ser redundante com os chips; separador de data
  + cabeçalho do assistente nas mensagens; marca com ladrilho "F"; botão enviar
  `ArrowUp`; seletor de cliente custom `ClientPicker` (no lugar do `<select>`).
- **Ícones Lucide + cor por assistente:** o campo `emoji` (banco/API) agora guarda
  o **nome de um ícone Lucide** (`ASSISTANT_ICONS` em `constants.js`). COMPAT: se o
  valor não for um nome de ícone conhecido (`isAssistantIcon`), renderiza como
  TEXTO — assistentes antigos com emoji continuam funcionando, sem migração de
  banco. Nova coluna `assistants.color` (ALTER TABLE em try/catch, `db.js`);
  `server.js` INSERT/UPDATE incluem `color`; GET usa `SELECT *` (flui sozinho).
- **`QUALITY_BAR`** (backend `agent.js`): padrão de qualidade em PT-BR (raciocínio,
  honestidade sobre incerteza, anti-fabricação de fontes, tratar conteúdo externo
  como dado não-confiável). Injetado nos 3 caminhos de resposta ao usuário
  (resposta única + coordenador de equipe direto + síntese). Enxugado p/ não
  duplicar `SANDBOX_RULES` nem a regra de idioma.
- **Faxina de CSS (SUPERSEDE o aviso de §0/2026-07-14 sobre `.cmpMenu` e
  `.composer button`):** o `styles.css` tinha ~4 gerações sobrepostas do composer;
  a antiga (fonte de 3 bugs) foi removida e consolidada numa geração única. 16
  classes órfãs removidas. **ARMADILHA (custou 3 regressões):** remover a geração
  antiga derruba props load-bearing que a nova não tem (`display:flex`, `flex:1`,
  `font:inherit`, `color`, e o `outline:none` que suprimia a regra global de
  foco). Ao consolidar CSS: verificar o RENDER (geometria/fonte/cor), não uma
  lista de props; e migrar TODA prop que só a regra antiga tinha.
- **Armadilhas de deploy confirmadas:** HMR do Vite está morto (inotify não passa
  no bind mount do Windows) → editar `frontend/src` exige `docker restart
  frederico-ia-studio-frontend-1`. Backend NÃO tem bind mount do código → editar
  `backend/src` exige `docker compose build backend`. Os dois falham em silêncio.

### Trabalho de OUTRAS sessões incluído no commit e revisado em 2026-07-16

O commit `49b9ac6` empacotou muita coisa que já estava na árvore sem commit.
Foi revisado por leitura de diff (3 frentes) + suíte de testes (40/40 passam:
36 backend `node --test` + 4 frontend `sse.test.js`) + build/boot. Resumo:

- **Controle de concorrência por conversa** (`agent.js`): `acquireConversationControl`
  / `releaseConversationControl` (idempotente) / `isConversationActive`. Impede 2
  respostas simultâneas na mesma conversa; `DELETE`, `POST /tasks` e `/chat` retornam
  **409** se a conversa está ativa (o DELETE protege a FK de mensagens/arquivos).
- **Modo Equipe com Executor** (`agent.js runOrchestrator`): quando a tarefa exige
  ferramentas, um assistente "executor" roda o `runAgent` de verdade usando os
  pareceres da equipe como briefing (antes a equipe só gerava texto).
- **Capacidades de modelo** (`modelCapabilities.js`): `buildModelCallPlan` bloqueia
  modelo sem `text`/sem `tools` quando a tarefa exige (mensagem amigável), degrada
  tools/reasoning não suportados, e faz fallback p/ texto quando o provedor responde
  "no endpoints support tool use".
- **Modo desenvolvedor** (`DeveloperPanel.jsx` + `App.jsx`): plan/build/review sobre
  uma pasta de PC montada, com Missão (`brief`) e Regras (`rules`); injeta
  `developer:{mode,projectId,rules}` no body do chat.
- **Rotinas com timezone** (`scheduling.js`): `scheduleDue` usa `APP_TIMEZONE` (não
  UTC), com clamp de dia mensal. **Classificação de tarefas** (`taskOutcome.js`):
  `done`/`error`/`canceled` em vez de sempre "concluída".
- **Turnos de baixo sinal** (`memory/retrievalPolicy.js`): saudações/confirmações
  curtas não disparam recuperação de memória nem ferramentas.
- **`tools.js` endurecido** (MELHORA a segurança): `web_fetch` valida host a cada
  redirect + limite de tamanho; `write_file` recusa gravar fora do workspace;
  caminhos de pasta de PC confinados por `resolveMountedPcPath`.
- **Resiliência de streaming** (`agent.js`): retry em 408/429/5xx + timeouts, com
  retomada. **Reparo de entrega**: materializa `.md/.txt` prometido mas não criado.
- **`sse.js` (frontend)**: parser de SSE sem estado, tolerante a proxy sem separador
  final e a evento malformado (relevante pro duplo proxy do Tailscale).

## 0.1 PONTO 2026-07-14 — o que foi feito depois da v. de memória

Branch `claude/new-session-ohbtj0`, PR #1. Tudo validado (esbuild/node --check)
e enviado. Desde a versão de memória, foi adicionado/corrigido:

- **Reforma visual (ChatGPT/Claude/Jan.ai):** abre em tela de boas-vindas
  (conversa "rascunho" — registro só no 1º envio via `ensureConversation`,
  single-flight); barra lateral **recolhível** (`sideHidden`); busca de
  conversas (procura em TODOS os clientes via `?all=1`); tela de boas-vindas
  com cards; campo de mensagem arredondado.
- **Layout da barra lateral:** conversas + ferramentas num único scroll
  (`.sideScroll`) — histórico com espaço garantido, nada cortado.
- **Caixa de mensagem:** todos os botões agrupados num **menu único**
  (`.cmpMenu`, ícone SlidersHorizontal): Anexar, Pesquisa web, Esforço,
  Ditar, Segundo plano. Só menu + textarea + enviar visíveis. CUIDADO: a regra
  base `.composer button{height:48px;width:52px}` sobrescreve botões novos —
  use seletores mais específicos (`.composer .cmpMenuBtn`, `.cmpMenuPanel .cmpItem`).
- **Seletor de modelos:** filtros (família via `<select>`, lançamentos/NOVO,
  grátis, contexto, capacidades), favoritos (localStorage), ordenar por
  novos/baratos. `/api/models` expõe created, context, price, vision, free.
- **7 temas** (claro/escuro + slate/indigo/emerald/amber/sepia) via classes
  `.t-<id>` + `theme` state; botão Tema abre seletor.
- **Esforço da IA** (baixo/medio/alto/extra/max): reasoning effort (OpenRouter)
  + maxSteps + nudge. Enviado no body do chat; aliases p/ nomes antigos.
- **Correção de bugs (revisão com 4 agentes):** symlink escape (safeJoin +
  realInside), BLOCKED_PATHS/isDangerousHostPath, SSRF no web_fetch,
  execInSandbox (error handler + demux + cap), getContainer single-flight,
  vazamento de memória entre clientes (findSimilar por escopo + 'passage'),
  guardas Array.isArray no front, etc.
- **Economia de tokens** (`economy_mode`, LIGADO por padrão): contexto ~8k,
  histórico 20, extração de memória só a cada 4 msgs.
- **Recursos novos:** Ferramentas/apps embutidos (EMBEDDED_APPS: documento
  profissional, planilha a partir de dados, OCR de imagens/PDF, dashboard de
  dados, proposta/contrato — todos GENÉRICOS, sem viés fiscal), assistente
  "Documentos profissionais" (seed único via settings.seeded_docpro, Word Design
  em python-docx), Rotinas agendadas (tabela `schedules` + agendador 1x/min),
  Caixa de entrada de documentos por cliente (data/inbox).
- **Heartbeat SSE** (": ping" a cada 15s) contra "Upstream idle timeout".
- **Acesso no celular:** app agora usa **mesma origem** (API relativa "" +
  Vite `server.proxy` /api → `backend:3001`; `host:true`, `allowedHosts:true`;
  compose usa `VITE_PROXY_TARGET`). Habilita Tailscale/HTTPS numa porta só.

- **Reforma do seletor de modelos + ícones** (commit `20e298d`, 2026-07-14):
  ModelPicker agora é guiado pela **finalidade** do trabalho (Trabalho geral,
  Documentos e planilhas, Economia, Analisar imagens, Criar imagens, Criar
  vídeo) em vez de taxonomia de famílias na 1ª tela; guarda modelos recentes
  (localStorage `fred_recent_models`); filtros avançados recolhíveis. Emojis
  trocados por ícones `lucide-react` (mapa `QUICK_ACTION_ICON` no App.jsx,
  rótulos `FAMILY_META` sem emoji). Removido código morto de "novos modelos"
  (`isNewModel`/`daysAgo`/`Date.now`). Validado com `vite build` (produção OK).

**✅ CONCLUÍDO — Acesso pelo celular via Tailscale Serve + HTTPS** (2026-07-14,
testado e confirmado pelo usuário no celular Motorola Edge 60 Pro):
- `tailscale serve` ativo: `https://frederico.tail609192.ts.net/` → proxy
  `http://127.0.0.1:5173`, modo **"tailnet only"** (só aparelhos da tailnet do
  usuário; nada exposto à internet pública). Cadeado HTTPS válido no celular.
- Cadeia completa verificada: HTTPS Tailscale → Vite (5173, proxy `/api`) →
  backend (3001). SSE do chat passa pelos 2 proxies (X-Accel-Buffering:no,
  Cache-Control:no-transform, heartbeat 15s).
- **Sem senha** (`auth:false`) — aceitável SÓ por ser tailnet-only. Para liberar
  a terceiros, ativar `APP_PASSWORD`.
- Próximo passo opcional (não feito): fazer `tailscale serve` + Docker subirem
  sozinhos com o Windows. NÃO testado de ponta a ponta em Docker por sessão
  anterior sem Docker; ESTA sessão rodou com Docker Desktop ativo e tudo no ar.
- **Armadilha resolvida:** `git config core.autocrlf` deve ficar **true** (repo
  usa LF, working tree Windows usa CRLF). Com `false`, `git add` inflava o diff
  de ~570 p/ ~2600 linhas de ruído CRLF. Não setar autocrlf=false neste repo.

## 1. O que é o projeto

**Frederico AI Studio**: aplicativo web de chat agêntico em PT-BR, conectado a
APIs compatíveis com OpenAI (o usuário usa **OpenRouter**), com **um sandbox
Docker por conversa** que executa Python/bash e gera **arquivos reais**
(xlsx, docx, pdf, imagens, zip) baixáveis no chat. Roda via `docker compose`.

- **Repositório**: `fredabsd-svg/Frederico-IA-Studio` (GitHub)
- **Branch de trabalho**: `claude/new-session-ohbtj0` — TODO push vai para ela
- **PR #1 aberto** contra `main` (main é um commit vazio criado só como base)
- Último commit: `20e298d` — reforma do seletor de modelos + ícones (2026-07-14).
  Acesso pelo celular via Tailscale/HTTPS funcionando (ver §0).

## 2. Sobre o usuário (Frederico) — como trabalhar com ele

- **Contador de formação** (mencionou CRC TO-006157/O-8), mas o app é um
  **estúdio geral** (sem viés contábil/fiscal): usa para documentos, planilhas,
  análise de dados, propostas e relatórios em geral.
- **Leigo em programação**: explicar passo a passo, sem jargão, em PT-BR.
- Ambiente: **Windows**, Docker Desktop, pasta do projeto clonada via git em
  `C:\Users\conta\Downloads\Frederico-IA-Studio\Frederico-IA\Frederico-IA-Studio`.
- Atualiza com: `git pull` + duplo clique em **`iniciar.bat`** (reconstrói) +
  Ctrl+Shift+R no navegador. **Sempre terminar respostas com essas instruções**
  quando houver mudança de código (dizer se backend mudou → rebuild).
- `.env` dele: chave do **OpenRouter** (`DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1`,
  `DEEPSEEK_MODEL=deepseek/deepseek-chat`). Usa DeepSeek V3 e GPT-4o.
- Manda **prints** quando algo dá errado; responder com diagnóstico + correção.
- Plano futuro dele: servidor caseiro com **notebook Linux + Tailscale**
  (guia pronto em `NOTEBOOK-SERVIDOR.md`; alternativa VPS em `VPS-DEPLOY.md`).

## 3. Stack e estrutura

- **Backend** (`backend/src/`, Node 20 ESM): Express, dockerode, better-sqlite3,
  multer, nanoid, openai SDK, @xenova/transformers (embeddings locais).
  - `server.js` — todas as rotas HTTP + SSE + auth + fila de tarefas
  - `agent.js` — loop agêntico (streaming token a token), orquestrador (modo
    Equipe), regras do sandbox, freio de loop de erros, validador de arquivos
  - `tools.js` — ferramentas: run_python, bash, write/read/list, zip_outputs,
    web_search/web_fetch (backend), generate_image (via IMAGE_MODEL)
  - `sandbox.js` — ciclo de vida dos containers (1 por conversa)
  - `auth.js` — login por senha (APP_PASSWORD; desligado sem ela)
  - `memory/` — **sistema de memória de longo prazo** (ver §5)
- **Frontend** (`frontend/src/`, React 19 + Vite 8, versões FIXADAS):
  `App.jsx` (principal), `MemoryPanel.jsx` (Cérebro), `components.jsx`
  (ToolStep/Slider/Modal/ModelPicker/Collapsible), `constants.js`, `styles.css`
- **Sandbox** (`sandbox/Dockerfile`): python:3.12-slim + pandas, openpyxl,
  xlsxwriter, python-docx, reportlab, weasyprint(+libs pango), matplotlib,
  PyMuPDF, ocrmypdf, ghostscript, camelot, pdf2image, pytesseract(por),
  **ffmpeg** (edição de vídeo/áudio). Sem rede, uid 1000, limites.
- **Deploy**: `docker-compose.yml` (dev: 5173/3001) e `docker-compose.prod.yml`
  (Caddy com HTTPS automático + frontend buildado + backend sem porta pública).
- Utilitários Windows: `iniciar.bat` (limpa + sobe + abre navegador), `parar.bat`.

## 4. Funcionalidades já entregues (todas funcionando)

Assistentes personalizados (Studio com templates e sliders) · Biblioteca de
templates de pedido (+ salvar mensagem como template) · Clientes/Projetos
(conversas e memória isoladas por cliente) · Modo Equipe (orquestrador
multi-assistente) · **Memória de longo prazo** (§5) · Fila de tarefas em 2º
plano (sobrevive a reinício) · Pesquisa na internet (botão globo; Google via
GOOGLE_API_KEY/CSE_ID ou DuckDuckGo) · Ditado por voz (Web Speech pt-BR) ·
Geração/edição de imagens (generate_image, IMAGE_MODEL padrão
google/gemini-2.5-flash-image, prévia no chat) · Edição de vídeo (ffmpeg) ·
Validador automático de xlsx/pdf/docx gerados (selo no cartão) · Exportar
conversa em PDF/Word · Backup .tar.gz de um botão · Análises (tokens por
assistente/modelo/conversa) · Pausar/Continuar/Parar · Streaming ao vivo +
chips de ferramenta expansíveis (mostram código executado e resultado) ·
Editar mensagem estilo ChatGPT (trunca conversa) · Copiar mensagem ·
Mensagens longas recolhíveis · Seletor de modelos com busca e categorias
(⭐ melhores p/ planilhas; 🆓 free separados) · Erros da API traduzidos
(429/401/402...) · Login por senha p/ produção · Arquivos como cartões no
chat · Upload como chips · Tela responsiva (gaveta mobile) · Tema claro/escuro.

## 5. Sistema de memória (recém-entregue — usuário AINDA NÃO TESTOU)

- **Módulos** em `backend/src/memory/`: `embeddings.js` (locais,
  Xenova/multilingual-e5-small ~112MB baixado 1x p/ ./data/models; fallback
  automático para busca por palavras), `memoryService.js` (CRUD tipado:
  perfil/preferencia/projeto/fato/manual + ranking sim+recência+importância+
  fixada + dedupe + settings + guard de segredos looksSensitive em add E
  update), `indexer.js` (após cada resposta: chunk com embedding + escopo do
  cliente; LLM barato [EXTRACT_MODEL] gera resumo/tags e extrai fatos;
  importação de exports do Claude/ChatGPT/json genérico/txt/md/html),
  `contextBuilder.js` (monta contexto por prioridade respeitando
  context_target_tokens, padrão 60k, configurável até 1M+).
- **Rotas**: `/api/memories` (GET busca/POST/PUT/DELETE, /export, /import,
  /reindex), `/api/memory-config`; legadas `/api/memory` mantidas.
- **UI**: painel "Cérebro do Assistente" (MemoryPanel.jsx).
- **Decisões da revisão adversarial** (5 fixes aplicados): chunks têm coluna
  `scope` (isolamento por cliente); apagar/truncar conversa apaga chunks e
  resumos; remover cliente move chunks p/ global; fallback do EXTRACT_MODEL
  depende da base URL; MemoryPanel valida res.ok.
- **Testes**: suíte E2E de 37 casos passou (script no scratchpad da sessão
  antiga — recriar se precisar; testa modo degradado, não o modelo real).

## 6. Decisões/armadilhas técnicas que NÃO podem regredir

1. Binds do sandbox usam `HOST_WORKSPACE_ROOT` (caminho do HOST, não do container).
2. Todo write no workspace: `chownSync(1000,1000)` (exec roda como uid 1000).
3. Timeout mata o container; próximo exec recria sozinho; reaper de 30min.
4. Backend em node:20-**slim** (alpine quebra better-sqlite3).
5. Desconexão SSE: usar `res.on('close')` com `writableEnded` — `req.on('close')`
   dispara imediatamente e matava toda resposta no 1º token (bug histórico grave).
6. Streaming: reenviar ao histórico só {role, content, tool_calls}; emitir
   fallback via delta se o modelo não gerar texto (senão balão vazio).
7. SANDBOX_RULES no prompt: cada run_python é processo novo (sem estado);
   narrar antes de cada ferramenta; ffmpeg disponível; generate_image p/ imagens.
8. Freio: 5 falhas consecutivas de ferramenta → interrompe com o último erro.
9. Orçamento de etapas do agente (`loop.js`): `AGENT_MAX_STEPS` é **PISO, não
   teto** — `Math.max(eff.steps, envSteps)`, nunca reduz o esforço escolhido
   ("Máx" vale ≥60 mesmo com env baixo). NUNCA voltar a `env || eff.steps` (o env
   sobrescrevia e cortava "Máx" para 30 em silêncio — causa real de "modo
   desenvolvedor/tarefa longa bate no limite" mesmo depois de "aumentar o número").
   Modo desenvolvedor: `AGENT_DEV_MAX_STEPS` (padrão 200). Teto absoluto:
   `AGENT_HARD_MAX_STEPS` (padrão 1,5x o base) — tarefa AINDA produtiva (ferramenta
   ok há ≤2 etapas, `lastProductiveStep`) passa do base até o teto em vez de morrer
   no meio. Mensagem de limite honesta e retomável (sem o papo antigo de CSV).
   `AGENT_HISTORY_LIMIT=60` (env).
10. Validação de caminhos com `insideBase()` (startsWith + separador) — nunca
    voltar ao startsWith puro (path traversal).
11. Frontend: dependências com versões fixadas (nunca "latest").
12. Nome de arquivo de upload: converter latin1→utf8 (acentos).
13. Container names sem `container_name` fixo no compose (evita conflito).
14. Nenhum asset de CDN no frontend — logos e imagens ficam em `frontend/public/`
    e entram no bundle pelo `vite build`. URL de CDN com `@latest` quebra sozinha
    sem aviso (mesma razão do item 11), e asset de terceiro entrega o IP de cada
    visitante a quem hospeda a CDN — inaceitável num site público com LGPD.

## 7. Regras de trabalho (processo)

- Commits em português, descritivos; atualizar este arquivo e enviar o commit ao
  GitHub na branch de trabalho atual, na mesma sessão.
- Validar antes de commitar: `node --check` em todo backend + bundle do
  frontend com esbuild (`npx esbuild frontend/src/App.jsx --jsx=automatic
  --bundle --external:react ...`) + `py_compile` em scripts Python embutidos.
- Nunca expor chaves/tokens; nunca salvar dados sensíveis; avisos de
  segurança/LGPD mantidos no README.
- Não quebrar funcionalidades existentes; migrações de banco sempre
  não-destrutivas (ALTER TABLE em try/catch).
- Respostas ao usuário: PT-BR, passo a passo, com seção "Atualize aí" no final.

## 8. Pendências / próximos passos sugeridos

0. ✅ **[RESOLVIDO em 2026-07-19] SSRF residual no `web_fetch`** (`tools.js`,
   `isBlockedHost`): o bloqueio filtrava por **texto do hostname** e deixava passar
   IPv6 entre colchetes (`http://[::1]/`) e o IPv4-mapeado; o **DNS rebinding**
   também não era coberto. Corrigido: colchetes desembrulhados, IPv4-mapeado
   tratado, faixa link-local completa, e resolução de DNS com validação de cada
   IP antes do fetch (`assertHostResolvesPublic`). Ver a entrada de log no topo
   deste arquivo. Os formatos decimal/hex/octal já eram neutralizados pelo parser
   de URL. **Ainda pendente nesta linha:** `ENVIRONMENT_QUERY_RE` (`agent.js`) é
   amplo demais e dispara um `bash` de auditoria no sandbox em mensagens comuns —
   estreitar.
1. **Usuário testar a memória** (git pull + iniciar.bat; 1ª conversa baixa o
   modelo de embeddings ~112MB) — perguntar "quem sou eu?" após algumas conversas.
2. Testar **importação** do export do Claude (conversations.json).
3. Futuro: consolidação/decaimento de memórias; indexação retroativa das
   conversas antigas da instalação; geração de vídeo (fal.ai/Replicate);
   multiusuário (contas separadas); montar o notebook-servidor com Tailscale.

## 9. Estado do git

- **Atualizado 2026-07-20:** a `main` está em produção com a frente LGPD
  completa mergeada (PRs #47, #48 e #49 — ver a primeira seção deste arquivo).
  O fluxo de trabalho recente: branch `claude/*` por frente de trabalho →
  PR → merge na main na mesma sessão. Validação usada nos PRs LGPD:
  `node --check` no backend, testes com `node --test` (backend 29 pass /
  frontend 7 pass) e `vite build` limpo. Obs.: no ambiente de dev remoto o
  `npm ci` do backend precisa de `--ignore-scripts` (o binário do sharp não
  baixa atrás do proxy — não afeta o Docker do usuário).
- **Deixados de fora de propósito** (não commitar sem intenção clara):
  - `frontend/dist/` — saída de build (não versionar).
  - `frontend/package-lock.json` (M): só teve remoção de binários de plataforma
    pelo `npm install` do container Linux; `package.json` não mudou.
  - Notas soltas no root: `CONTINUIDADE-MEU.md`, `CRITICA-DESIGN.md`,
    `monitor_rotinas_dominio.py`, `guia_rotinas_automaticas_dominio.md`.
- `backend/node_modules` local desta sessão de dev tinha transformers sem o
  binário sharp (limitação do ambiente de dev, NÃO afeta o Docker do usuário).
