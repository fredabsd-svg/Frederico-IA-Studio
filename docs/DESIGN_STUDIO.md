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

## Refinar sem escrever um pedido inteiro

Além do chat, duas formas de mexer no design apontando em vez de descrevendo.

### Edição inline — "muda só este elemento"

Ligue **Editar elemento** na barra da prévia e clique no que quer mudar. O
elemento fica marcado, uma etiqueta aparece acima do compositor (`<h1> Bem-vindo`)
e o pedido que você escrever vale só para ele.

O que isso muda no prompt: além do artefato inteiro, o modelo recebe um bloco
`ALVO` com a tag, as classes, o caminho e o **trecho de HTML** do elemento, e a
instrução de deixar o resto idêntico. É o que separa "deixe maior" de "deixe o
título da capa maior".

**Como o clique atravessa o sandbox.** A prévia roda em origem opaca — de fora,
`iframe.contentDocument` é `null` e nenhum `querySelector` alcança o documento.
Isso não é um detalhe a contornar: é a razão de o modo ser seguro. Então o
backend injeta na prévia (e **só** nela) um script-ponte,
`src/design/bridge.js`, que realça o elemento sob o cursor e, no clique, manda
o descritor para fora por `postMessage`. Do lado da interface, a mensagem é
aceita comparando `event.source` com o `contentWindow` do nosso iframe — a
origem não serve de prova aqui, porque numa origem opaca ela chega como `null`.

Em **apresentações** o alvo é o **número do slide**, não a marcação: o modelo
edita o JSON, e o HTML do deck é montado por nós. Mandar essa marcação o faria
devolver HTML onde ele deve devolver JSON, e o artefato inteiro seria recusado.

### Controles de ajuste — cor, tipografia e espaçamento sem chamar a IA

A aba **Ajustes** mostra sliders e seletores de cor que mudam a prévia **na
hora**, sem gerar versão e sem gastar uma chamada ao modelo.

Isso só funciona por causa de um **contrato**: o system prompt exige que toda
saída HTML declare um bloco `:root` com variáveis de nome fixo e as use no resto
do CSS.

```css
:root {
  --fred-cor-primaria: #1f3b8a;
  --fred-cor-secundaria: #e8523f;
  --fred-cor-texto: #12151c;
  --fred-cor-fundo: #ffffff;
  --fred-fonte-base: 16px;
  --fred-espaco: 1rem;
  --fred-raio: 12px;
}
```

Sem esse contrato não haveria como fazer um slider de "cor primária": num HTML
arbitrário a cor está espalhada em vinte declarações, escritas de jeitos
diferentes (`#1f3b8a`, `rgb(31,59,138)`, `bg-blue-900` do Tailwind). Reescrever
isso por regex seria adivinhação — ora acertaria, ora pintaria o texto de fundo.
Com as variáveis, o ajuste é uma sobreposição de `:root` de três linhas.

Consequências que valem conhecer:

- **A lista de controles é derivada do artefato**, não fixa. `detectTokens` lê o
  HTML servido e a interface desenha um controle por variável encontrada. Um
  design que declare só as duas cores mostra dois controles.
- **Um artefato que não segue o contrato mostra zero controles** — e a tela
  explica isso, em vez de oferecer sliders inertes. É o caso de projetos criados
  antes desta versão. Peça no chat "use variáveis CSS `--fred-*`" e a próxima
  versão traz os controles.
- **Apresentações também ganham os controles de cor**, porque o deck é montado
  por `render.js` e declara as mesmas variáveis. `--fred-fonte-base` fica de
  fora ali: o deck escala a tipografia em `cqw` (proporcional ao slide), e um
  tamanho em px não teria efeito — controle que não faz nada é pior que controle
  nenhum.
- **O ajuste é camada, não reescrita.** O artefato guardado não muda; a
  sobreposição é aplicada ao renderizar e ao exportar. Isso é o que permite
  mexer nos sliders e depois pedir uma edição no chat sem que uma coisa apague a
  outra: o modelo edita a base, o ajuste continua por cima.
- **O que você vê é o que você baixa**: a exportação leva os ajustes. O que ela
  **não** leva é a ponte de edição — o arquivo baixado é o design, não o editor.
- **Ajustar não cria versão.** Um arrasto de slider não é uma decisão de design
  que mereça entrar no histórico; uma versão por movimento encheria a lista de
  ruído e comeria a janela de poda.

Enquanto o controle está sendo arrastado, o CSS é aplicado direto no iframe por
`postMessage` (efeito instantâneo, nada vai ao servidor). Ao soltar, o valor é
gravado — e o servidor revalida tudo: cor só em hex, medida dentro da faixa,
chave fora do catálogo descartada.

## O modelo de IA é do projeto

O seletor de modelo fica **na barra do editor**, junto do título — e não no chat
principal. O motivo é físico: o Modo Design ocupa a tela inteira, então o seletor
do chat fica atrás dele. Trocar de modelo não pode exigir fechar a tela.

A escolha é **gravada no projeto** (`design_projects.model_ref`). Isso importa
mais do que parece: sem a coluna, cada geração usava o modelo selecionado no chat
naquele instante, e como o app não guarda essa seleção entre recarregamentos, um
projeto criado com um modelo bom era refinado meses depois pelo primeiro modelo
da lista. A proposta saía diferente sem ninguém ter pedido.

A precedência tem um lugar só, dos dois lados (`modelForProject` no backend,
`effectiveModel` no frontend):

| Situação | Modelo usado |
| --- | --- |
| Projeto com `model_ref` | o do projeto — sempre |
| Projeto com `model_ref` nulo (criado antes desta versão) | o selecionado no chat, como antes |
| Seletor deixado em branco | solta a fixação e volta ao caso acima |

A referência gravada é a **completa** (`<provedor>::<modelo>`), não o id cru: um
id sem prefixo faz `getUserProvider` cair no provedor mais antigo do usuário.

Se o modelo fixado apontar para um provedor que não existe mais (chave removida,
catálogo trocado), a geração falha com a mensagem do provedor e **o projeto
continua de pé** — basta escolher outro modelo no seletor e pedir de novo.

> Detalhe de implementação que vale lembrar: `Esc` com o seletor aberto fecha só
> a lista, não o Modo Design. A checagem acontece na fase de **captura** do
> evento, porque o React trata `keydown` como discreto e descarrega o estado na
> hora — quando o ouvinte do modo roda, o painel do seletor já saiu do DOM.

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

### 4. A ponte de edição é o único código nosso dentro da prévia

`src/design/bridge.js` é injetado **só na prévia** — nunca na exportação — e é
constante: nada vindo do usuário ou do modelo é interpolado nele, porque um
trecho montado por template viraria injeção de script dentro da própria prévia.

O que ele envia para fora é um descritor de elemento (tag, classes, caminho,
texto e um trecho do `outerHTML`), e esse descritor passa por `sanitizeTarget`
antes de virar prompt: ele nasce num contexto que executa código gerado por IA,
então campos fora da lista somem e todo texto é limitado.

O sentido inverso (interface → prévia) carrega apenas o modo de seleção e o CSS
de ajuste. Os dois lados usam `postMessage(..., '*')` porque numa origem opaca
não existe origem específica para mirar; a checagem que vale é a da **janela**
(`event.source === iframe.contentWindow`), feita na interface.

### 5. O conteúdo é conferido contra o tipo antes de renderizar

`contentMatchesType` roda antes de cada prévia e cada exportação. Conteúdo e
`output_type` são colunas independentes: uma migração futura, um restore de
backup ou um bug de escrita podem descasar as duas, e renderizar JSON como se
fosse HTML dentro do iframe é caro demais para se confiar em "não deve
acontecer".

### 6. Cor e fonte da marca são validadas

`primary_color`/`secondary_color` só aceitam hex; nomes de fonte recusam aspas e
`;`. Os dois valores são interpolados dentro de CSS no deck gerado — sem
validação, seriam injeção de estilo (e, via `url()`, de conteúdo) no documento.

O mesmo vale para os **ajustes finos**: `sanitizeAdjustments` só deixa passar
chaves do catálogo fechado em `design/tokens.js`, cor em hexadecimal e medida
dentro da faixa do próprio token. Um valor como `#fff;background-image:url(...)`
é descartado inteiro, não "limpo".

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

**`model_ref` guarda o modelo de IA do projeto** (nulo = segue o modelo do app).

**`adjustments` é uma coluna do projeto**, não uma versão. Guarda um JSON
pequeno com as variáveis que o usuário mexeu (`{"corPrimaria":"#0a7d55"}`). É por
projeto, e não por versão, porque é assim que o usuário pensa nele — "a cor da
minha proposta", não "a cor da versão 4".

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
| `PUT` | `/design/projects/:id/adjustments` | grava os ajustes finos (não chama a IA, não cria versão) |
| `PATCH` | `/design/projects/:id` | renomeia, troca a marca e **fixa/solta o modelo** (`model`; string vazia solta) |
| `POST` | `/design/projects/:id/preview-token` | invalida a URL da prévia e emite outra |
| `GET` | `/design/projects/:id/export?format=&versionId=` | baixa o artefato |
| `GET`/`POST` | `/design/systems` | lista / cria uma marca |
| `PUT`/`DELETE` | `/design/systems/:id` | edita / apaga |

Notas:

- `format` fora da lista do tipo cai no padrão do tipo, em vez de errar.
- `versionId` permite exportar uma versão antiga **sem** reverter o projeto.
- `POST /generate` aceita um `target` opcional — o elemento clicado na prévia
  (edição inline). Ele é normalizado por `sanitizeTarget` antes de virar prompt.
- `GET /design/projects/:id` devolve `tokens`: as variáveis de ajuste que **este**
  artefato declara, com o valor padrão de cada uma. É a lista que vira controles.
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
- **Os controles de ajuste dependem do contrato das variáveis `--fred-*`.** Um
  artefato gerado antes desta versão, ou por um modelo que ignorou a regra, não
  mostra controle nenhum — a tela explica e sugere pedir uma versão nova. Não há
  conversão automática de um CSS "solto" para variáveis: isso seria adivinhação
  (ver §Controles de ajuste).
- **A edição inline aponta, não move.** Ela diz ao modelo QUAL elemento mudar; a
  mudança em si continua sendo uma geração, com o custo e o tempo de uma. Não há
  arrastar, redimensionar nem editar texto direto na prévia.
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
| `backend/src/design/tokens.js` | catálogo das variáveis de ajuste, detecção e sobreposição de CSS — **puro** |
| `backend/src/design/bridge.js` | script-ponte injetado na prévia (seleção + ajuste ao vivo) |
| `backend/src/design/store.js` | banco (projetos, versões, chat, marcas) |
| `backend/src/design/generate.js` | chamada ao provedor de IA |
| `backend/src/design/pdf.js` | impressão em PDF (Chromium + guarda de SSRF) |
| `backend/src/design/pptx.js` | exportação `.pptx` |
| `backend/src/routes/design.js` | as rotas |
| `frontend/src/components/Design*.jsx` | as telas (incluindo `DesignAdjustments.jsx`) |
| `frontend/src/design/designCore.js` | lógica pura da interface |
| `frontend/src/hooks/useDesign.js` | estado e chamadas de API |

**Testes:** `design/core.test.js` (extração, validação e prompt do alvo),
`design/render.test.js` (escape e deck), `design/tokens.test.js` (detecção,
validação e sobreposição de CSS), `design/bridge.test.js` (contrato da ponte),
`design/pptx.test.js` (arquivo abrível), `design/store.test.js` (versionamento e
isolamento, exige Postgres), `routes/design.http.test.js` (rotas ponta a ponta
com provedor falso, exige Postgres) e `e2e/tests/design.spec.js` (navegador
real — é lá que a travessia do sandbox pelo `postMessage` é provada).
