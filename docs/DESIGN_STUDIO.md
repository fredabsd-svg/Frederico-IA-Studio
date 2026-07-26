# Modo Design

Espaço próprio do Studio onde o usuário descreve o que precisa — um site, uma
apresentação ou um documento visual — e recebe um **rascunho renderizado ao
vivo**, que refina conversando e depois exporta.

A diferença para pedir HTML no chat principal é o ciclo: aqui o resultado
aparece renderizado, cada pedido de mudança vira uma **versão** navegável, e o
artefato é exportável no formato do seu tipo. O chat principal continua sendo o
lugar de análise, execução de código e geração de documentos a partir de dados;
o Modo Design é o lugar de **fazer algo parecer bom**.

---

## Como funciona

```
pedido em texto ──► LLM (system prompt por tipo de saída)
                     │
                     ▼
              extractArtifact  ── recusa ─► mensagem no chat do projeto
                     │ aceita               (a versão boa continua valendo)
                     ▼
             design_versions (v1, v2, v3…)
                     │
     ┌───────────────┼────────────────┐
     ▼               ▼                ▼
  prévia         histórico        exportação
 (iframe        (voltar para     (.html / .pdf /
  isolado)       uma versão)       .pptx)
```

Três tipos de saída, cada um com regras próprias no system prompt
(`backend/src/design/core.js`):

| Tipo | O que o modelo devolve | O que é guardado | Exporta |
| --- | --- | --- | --- |
| `web` | documento HTML completo, responsivo, autocontido | o HTML | `.html` |
| `slides` | `{"slides":[{layout,title,body,notes}…]}` | o JSON normalizado | `.html`, `.pdf`, `.pptx` |
| `document` | HTML paginado em A4, para impressão | o HTML | `.html`, `.pdf` |

**Por que `slides` guarda JSON e não HTML.** O mesmo JSON vira prévia, PDF e
`.pptx`. Um arquivo do PowerPoint é feito de caixas de texto posicionadas; se o
modelo devolvesse HTML de slides, produzir o `.pptx` exigiria adivinhar as
caixas de volta a partir de marcação arbitrária. Com a estrutura em mãos,
`render.js` monta o deck HTML e `pptx.js` monta o arquivo do PowerPoint — cada
um a partir da mesma fonte.

O `.pptx` é uma tradução **aproximada**: preserva conteúdo, hierarquia, paleta e
notas do apresentador, mas não sombras, gradientes e fontes do CSS. Para
fidelidade visual, o PDF é o formato certo.

---

## Segurança

O HTML de um projeto de design é **código gerado por IA a partir de um pedido em
linguagem natural**. Ele não é confiável, e roda em duas máquinas: o navegador
do usuário (na prévia) e o navegador do servidor (na exportação em PDF).

### 1. A prévia roda em origem opaca

Duas barreiras, uma de cada lado:

- **No documento** — a resposta traz
  `Content-Security-Policy: sandbox allow-scripts; frame-ancestors …`. Sem
  `allow-same-origin`, o navegador coloca o documento numa **origem opaca**: ele
  não enxerga cookie de sessão, `localStorage`, `IndexedDB` nem o DOM do app —
  mesmo servido do mesmo domínio, e mesmo se alguém abrir a URL da prévia
  diretamente.
- **No `<iframe>`** — `sandbox="allow-scripts"`, sem `allow-same-origin`.

As duas dizem a mesma coisa de propósito: esquecer uma não abre o buraco
sozinha. A regressão é guardada em dois níveis — `routes/design.http.test.js`
confere o cabeçalho, e `e2e/tests/design.spec.js` confere o atributo no
navegador de verdade.

> **Nunca** acrescente `allow-same-origin` ao lado de `allow-scripts`. Juntos,
> os dois anulam o sandbox: o código gerado passa a compartilhar a origem do app.

### 2. A URL da prévia é uma capacidade

`GET /api/design/preview/:token` é a **única rota de API sem sessão** (a exceção
está registrada em `server.js`, em `isPublicApiPath`). O token tem 32 caracteres
aleatórios (~190 bits) e é o que dá acesso ao artefato.

Isso é intencional, e a razão é a próxima camada: com `DESIGN_PREVIEW_ORIGIN`
apontando um segundo domínio para o mesmo backend, a requisição da prévia sai
para **outra origem** e o navegador não tem motivo para mandar o cookie de
sessão junto com o artefato não confiável. Uma rota autenticada não poderia
fazer isso.

Consequência a conhecer: **quem tiver a URL vê a prévia**, sem login. O token só
é entregue ao dono, mas se ele vazar (um print, um link colado), a saída é
`POST /api/design/projects/:id/preview-token`, que emite outro e mata o
anterior.

### 3. A exportação em PDF usa a mesma guarda de rede do `web_fetch`

`design/pdf.js` reaproveita `getBrowser`/`guardRoute` de `agent/pageShot.js` em
vez de abrir o próprio navegador. O motivo é direto: o HTML impresso roda no
navegador **do backend**, e uma página com
`<img src="http://169.254.169.254/…">` usaria esse navegador para alcançar a
rede interna (SSRF). A guarda do `pageShot` já resolve isso — inclusive a
armadilha de o `page.route()` do Playwright não ser chamado no destino de um
redirecionamento (ver `docs/SECURITY.md` e o cabeçalho de `pageShot.js`).
Duplicar o código seria duplicar a defesa e, mais cedo ou mais tarde, deixar a
cópia para trás.

### 4. O conteúdo é conferido contra o tipo antes de renderizar

`contentMatchesType` roda antes de cada prévia e cada exportação. Conteúdo e
`output_type` são colunas independentes: uma migração futura, um restore de
backup ou um bug de escrita podem descasar as duas, e renderizar JSON como se
fosse HTML dentro do iframe é caro demais para se confiar em "não deve
acontecer".

### 5. Cor e fonte da marca são validadas

`primary_color`/`secondary_color` só aceitam hex; nomes de fonte recusam aspas e
`;`. Os dois valores são interpolados dentro de CSS no deck gerado — sem
validação, seriam injeção de estilo (e, via `url()`, de conteúdo) no documento.

---

## Modelo de dados

`backend/migrations/022_design_studio.sql`:

- **`design_projects`** — título, `output_type`, marca opcional,
  `preview_token` (único) e `current_version_id`.
- **`design_versions`** — `version_number` crescente por projeto, conteúdo e o
  pedido que a gerou.
- **`design_messages`** — o chat do projeto, com `version_id` na fala do
  assistente que produziu uma versão.
- **`design_systems`** — a marca do usuário (cores, fontes, observações).

Duas decisões que valem registro:

**Ids `TEXT` (nanoid) e datas `TEXT` ISO-8601.** A proposta original usava
`INTEGER AUTOINCREMENT`/`DATETIME`, herança de SQLite. Aqui o banco é PostgreSQL
e todas as tabelas de domínio já usam `id TEXT PRIMARY KEY` + `created_at TEXT`.

**`current_version_id` é um ponteiro, não "a última versão".** É o que faz
*reverter* ser mover o ponteiro em vez de apagar o que veio depois: dá para
voltar para a v5, olhar, e seguir dali — a v6 e a v7 continuam no histórico.

**Poda.** Cada mensagem no chat cria uma versão, e um HTML tem dezenas de KB;
sem teto, um projeto muito conversado cresceria sem limite. `DESIGN_MAX_VERSIONS`
(padrão 30) mantém as N mais recentes, e a versão em exibição nunca é removida.

---

## API

Todas sob `/api`, autenticadas e escopadas ao usuário — **exceto** a prévia por
token.

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/design/projects` | lista os projetos |
| `POST` | `/design/projects` | cria (com `prompt`, já gera a v1 na mesma requisição) |
| `GET` | `/design/projects/:id` | projeto + versão atual + histórico + chat |
| `PATCH` | `/design/projects/:id` | renomeia / troca a marca |
| `DELETE` | `/design/projects/:id` | apaga (leva versões e chat junto) |
| `POST` | `/design/projects/:id/generate` | novo pedido → nova versão |
| `GET` | `/design/projects/:id/versions` | histórico |
| `POST` | `/design/projects/:id/revert` | volta para uma versão |
| `GET` | `/design/projects/:id/messages` | chat do projeto |
| `GET` | `/design/projects/:id/preview` | HTML da versão atual (pela sessão) |
| `GET` | `/design/preview/:token` | **sem sessão** — é o que o `<iframe>` carrega |
| `POST` | `/design/projects/:id/preview-token` | invalida a URL da prévia e emite outra |
| `GET` | `/design/projects/:id/export?format=&versionId=` | baixa o artefato |
| `GET`/`POST` | `/design/systems` | lista / cria uma marca |
| `PUT`/`DELETE` | `/design/systems/:id` | edita / apaga |

Notas:

- `format` fora da lista do tipo cai no padrão do tipo, em vez de errar.
- `versionId` permite exportar uma versão antiga **sem** reverter o projeto.
- Toda geração passa por `enforceDailyLimit` (o mesmo teto diário do chat) e
  registra consumo em `usage` com `kind='design'`.

---

## Configuração

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `DESIGN_PREVIEW_ORIGIN` | Origem alternativa da prévia (ex.: `https://preview.seu-dominio`). Aponte-a para o mesmo backend. | vazio (mesma origem) |
| `DESIGN_MAX_VERSIONS` | Versões guardadas por projeto | `30` |
| `DESIGN_MAX_TOKENS` | Teto de saída por geração | `8000` |
| `DESIGN_GENERATE_TIMEOUT_MS` | Tempo máximo de uma geração | `180000` |
| `DESIGN_TEMPERATURE` | Temperatura das chamadas de design | `0.6` |
| `DESIGN_PDF_TIMEOUT_MS` | Tempo máximo da impressão em PDF | `25000` |

O PDF exige o Chromium do sistema (`CHROMIUM_PATH`, já presente na imagem
Docker). Sem ele, a rota responde 503 com a explicação — o resto do modo segue
funcionando.

---

## Erros que o modo trata (e por quê)

| Situação | O que acontece |
| --- | --- |
| O modelo responde texto em vez de HTML | Nada é gravado; o erro entra no chat do projeto e a versão anterior continua na tela |
| A resposta vem cortada (`finish_reason: length`) | Recusada. Um HTML pela metade "parece" válido e viraria uma versão quebrada |
| A resposta vem com conversa em volta ou cerca de código | O documento é recortado de dentro dela — sem cortar cercas que façam parte do conteúdo |
| O JSON de slides vem fora do formato | Recusado com a mensagem do campo que faltou |
| O artefato atual passou de 120 mil caracteres | A edição por conversa é recusada com uma saída sugerida, em vez de mandar HTML truncado ao modelo |
| Projeto sem nenhuma versão | A prévia mostra um aviso, não uma tela em branco |

---

## Limites conhecidos

- **Sem imagens.** O modelo devolve texto; o layout `image-full` entrega um
  painel na cor da marca, não uma foto. Integrar com a geração de imagens já
  existente no app é um passo natural, mas não está feito.
- **Edição inline e controles de ajuste** (clicar num elemento da prévia e
  pedir uma mudança só dele; sliders de cor e espaçamento sem chamar a IA) são
  a v2 do plano e não estão implementados.
- **Compartilhamento público** não tem tela: o token da prévia funciona como um
  link somente-leitura, mas o modo não o apresenta como recurso de
  compartilhamento nem oferece expiração.
- **`document` não reaproveita o pipeline de Word/PDF do agente.** Aquele
  caminho roda Python numa sandbox Docker presa a uma **conversa**; um projeto
  de design não é uma conversa e não tem workspace. Em vez de esticar aquele
  pipeline, o `document` gera HTML paginado e imprime com o Chromium — o mesmo
  navegador que a imagem já traz. Quem precisa de `.docx` editável continua
  usando o chat principal.
- **A prévia não é atualizada por streaming.** A geração é uma chamada única e
  o resultado aparece quando termina (20–60 s é o normal).

---

## Onde está o quê

| Arquivo | Papel |
| --- | --- |
| `backend/src/design/core.js` | prompts, extração do artefato, validações — **puro** |
| `backend/src/design/render.js` | deck HTML dos slides — **puro** |
| `backend/src/design/store.js` | banco (projetos, versões, chat, marcas) |
| `backend/src/design/generate.js` | chamada ao provedor de IA |
| `backend/src/design/pdf.js` | impressão em PDF (Chromium + guarda de SSRF) |
| `backend/src/design/pptx.js` | exportação `.pptx` |
| `backend/src/routes/design.js` | as rotas |
| `frontend/src/components/Design*.jsx` | as telas |
| `frontend/src/design/designCore.js` | lógica pura da interface |
| `frontend/src/hooks/useDesign.js` | estado e chamadas de API |

**Testes:** `design/core.test.js` (extração e validação), `design/render.test.js`
(escape e deck), `design/pptx.test.js` (arquivo abrível), `design/store.test.js`
(versionamento e isolamento, exige Postgres), `routes/design.http.test.js`
(rotas ponta a ponta com provedor falso, exige Postgres) e
`e2e/tests/design.spec.js` (navegador real).
