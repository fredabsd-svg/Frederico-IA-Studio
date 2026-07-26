# Testes

> Atualizado em **2026-07-25**.
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

# sandbox (Python)
python -m pip install openpyxl==3.1.5
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
| `artifacts` | Testes Python do gerador de Excel (openpyxl real) |
| `docker-guard` | Política do guarda + proxy real contra um daemon Docker falso, em Node 20 e 22 |
| `backend-unit` | Suíte do backend **sem** banco, em Node 20 e Node 22 |
| `backend-integration` | Postgres real: migrações do zero + idempotência + tabelas + cascade; suíte completa **sem skips**; boot real do backend + `/api/health`; portão de autenticação (9 rotas → 401) |
| `frontend` | Todos os 7 arquivos de teste + build + catraca de bundle (≤ 1.000 KB) |
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
| `e2e/tests/layout.spec.js` | **Nada pode cobrir o botão de enviar**: sobreposição zero em oito larguras (1920 → 390px), compositor alto não empurra o personagem de volta, **clique real** no botão no desktop e no celular, e um guarda contra o exagero (o personagem tem de continuar visível na janela). Nasceu de um defeito real que a suíte encontrou — o avatar do copiloto cobria o botão em 1280px e em todas as larguras abaixo |

Scripts de apoio: `backend/scripts/run-tests.mjs` e `frontend/scripts/run-tests.mjs`
(descoberta de testes independente da versão do Node), `backend/scripts/check-migrations.mjs`,
`backend/scripts/count-tests.mjs`, `backend/scripts/lint.mjs`, `frontend/scripts/lint.mjs`.

---

## 6. Lacunas de teste conhecidas

Reconhecidas, priorizadas e **não** cobertas até aqui — ver `docs/AUDITORIA_2026-07.md`:

| ID | Lacuna | Situação |
| --- | --- | --- |
| F-12 | SSE integrado: duas conversas simultâneas, troca rápida, reconexão | **Coberta em parte** por `e2e/tests/multiconversa.spec.js`: duas conversas, troca no meio do streaming sem mistura, e reconexão depois de recarregar a página. **Falta** o caso específico de `fromSeq` (reconectar o `/stream` sem duplicar eventos) exercitado de forma isolada |
| F-13 | Provedor HTTP simulado completo (streaming, tool calls, erros, timeout) | **Coberta em parte** por `e2e/fixtures/provedorFalso.mjs`: streaming com ritmo controlado, catálogo e erro 401. **Falta** tool calls e timeout |
| F-14 | Retomada após **interrupção real do processo** (matar o Node no meio) | Aberta |
| F-15 | Pipeline multimodelo retomável após reinício | Aberta |
| F-16 | Suíte de relevância de memória com casos **negativos** | Aberta |
| F-18 | Corpus documental do Docling (escaneado, DRE, PGFN, células mescladas…) | Aberta |
| F-19 | Git local para clone/commit/push do modo desenvolvedor | Aberta |
| F-20 | E2E de navegador | **Fechada** — `e2e/`, Chromium real contra o build de produção, no CI |
| F-23 | Validação de artefato: XLSX com `#REF!`, DOCX vazio, PDF com página em branco | Aberta |
