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
npm test                 # TODOS os arquivos src/**/*.test.js (inclusive src/hooks/)
npm run check            # lint + test + build

# sandbox (Python)
python -m pip install openpyxl==3.1.5
python -m unittest discover -s sandbox -p '*_test.py' -v
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
| `backend-unit` | Suíte do backend **sem** banco, em Node 20 e Node 22 |
| `backend-integration` | Postgres real: migrações do zero + idempotência + tabelas + cascade; suíte completa **sem skips**; boot real do backend + `/api/health`; portão de autenticação (9 rotas → 401) |
| `frontend` | Todos os 7 arquivos de teste + build + catraca de bundle (≤ 1.000 KB) |
| `compose` | `docker compose config` dos dois arquivos (a partir do `.env.example`) + build da imagem do backend |
| `contagem` | Executa tudo e publica a contagem no resumo |

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

Scripts de apoio: `backend/scripts/check-migrations.mjs`, `backend/scripts/count-tests.mjs`,
`backend/scripts/lint.mjs`, `frontend/scripts/lint.mjs`.

---

## 6. Lacunas de teste conhecidas

Reconhecidas, priorizadas e **não** cobertas até aqui — ver `docs/AUDITORIA_2026-07.md`:

| ID | Lacuna |
| --- | --- |
| F-12 | SSE integrado: duas conversas simultâneas, troca rápida, reconexão com `fromSeq` |
| F-13 | Provedor HTTP simulado completo (streaming, tool calls, erros, timeout) |
| F-14 | Retomada após **interrupção real do processo** (matar o Node no meio) |
| F-15 | Pipeline multimodelo retomável após reinício |
| F-16 | Suíte de relevância de memória com casos **negativos** |
| F-17 | Bateria adversarial de injeção de prompt |
| F-18 | Corpus documental do Docling (escaneado, DRE, PGFN, células mescladas…) |
| F-19 | Git local para clone/commit/push do modo desenvolvedor |
| F-20 | E2E de navegador (Playwright já está disponível na imagem do sandbox) |
| F-23 | Validação de artefato: XLSX com `#REF!`, DOCX vazio, PDF com página em branco |
