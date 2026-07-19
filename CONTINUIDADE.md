# CONTINUIDADE — Estado do projeto Frederico AI Studio

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
- Hospedagem: **Contabo** Cloud VPS (Ubuntu + Docker). Sobe via
  `docker-compose.prod.yml`: serviços `postgres` + `backend` + `web` (Caddy);
  o backend não é exposto (só pelo proxy).
- Modo: **PÚBLICO com BYOK** (`ALLOW_SHARED_KEY=false`) — cada usuário cadastra
  a própria chave em Configurações → Provedor de IA. Sem chave do servidor.
- Segredos (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`) vivem no `.env` **do servidor**
  (nunca no repo). Login social (GitHub/Google) **não** configurado em produção —
  só e-mail/senha (para ativar: preencher credenciais no `.env` + callback
  `https://fredericostudio.com.br/api/auth/callback/{provider}`).

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
- `www.fredericostudio.com.br` (registro A do `www` + host no Caddyfile), se quiser.

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
9. `AGENT_MAX_STEPS=30`, `AGENT_HISTORY_LIMIT=60` (env).
10. Validação de caminhos com `insideBase()` (startsWith + separador) — nunca
    voltar ao startsWith puro (path traversal).
11. Frontend: dependências com versões fixadas (nunca "latest").
12. Nome de arquivo de upload: converter latin1→utf8 (acentos).
13. Container names sem `container_name` fixo no compose (evita conflito).

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

0. **[Segurança, revisão 2026-07-16] SSRF residual no `web_fetch`** (`tools.js`,
   `isBlockedHost`): o bloqueio filtra por **texto do hostname**, então deixa passar
   IPv6 entre colchetes (`http://[::1]/`), IP em decimal/hex/octal (`http://2130706433/`
   = 127.0.0.1) e **DNS rebinding** (domínio público que resolve p/ IP interno). Como
   o backend tem rede, isso alcança serviços internos. NÃO é regressão (pré-existente;
   a validação de redirect até melhorou). Corrigir validando o **IP resolvido**
   (desembrulhar colchetes IPv6, cobrir IPv4-mapeado, formatos numéricos) antes do
   fetch. Também: `ENVIRONMENT_QUERY_RE` (`agent.js`) é amplo demais e dispara um
   `bash` de auditoria no sandbox em mensagens comuns — estreitar.
1. **Usuário testar a memória** (git pull + iniciar.bat; 1ª conversa baixa o
   modelo de embeddings ~112MB) — perguntar "quem sou eu?" após algumas conversas.
2. Testar **importação** do export do Claude (conversations.json).
3. Futuro: consolidação/decaimento de memórias; indexação retroativa das
   conversas antigas da instalação; geração de vídeo (fal.ai/Replicate);
   multiusuário (contas separadas); montar o notebook-servidor com Tailscale.

## 9. Estado do git

- Último commit enviado ao GitHub era `0962d18` (2026-07-14). Desde então, a
  árvore acumulou trabalho de VÁRIAS sessões sem commit (protótipo v2, modo
  desenvolvedor, orquestrador c/ executor, catálogo de modelos, agendamento,
  política de memória, testes, etc.). O **commit de 2026-07-16** empacota TODO
  esse estado funcional de uma vez (backend/src + frontend/src + sandbox +
  este CONTINUIDADE.md). Estado validado antes de commitar: `docker compose
  build` do backend sobe limpo (health 200) e `vite build` do frontend passa.
- **Deixados de fora de propósito** (não commitar sem intenção clara):
  - `frontend/dist/` — saída de build (não versionar).
  - `frontend/package-lock.json` (M): só teve remoção de binários de plataforma
    pelo `npm install` do container Linux; `package.json` não mudou.
  - Notas soltas no root: `CONTINUIDADE-MEU.md`, `CRITICA-DESIGN.md`,
    `monitor_rotinas_dominio.py`, `guia_rotinas_automaticas_dominio.md`.
- `backend/node_modules` local desta sessão de dev tinha transformers sem o
  binário sharp (limitação do ambiente de dev, NÃO afeta o Docker do usuário).
