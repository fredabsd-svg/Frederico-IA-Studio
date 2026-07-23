# Docling — camada central de compreensão documental

Integra o [Docling](https://github.com/docling-project/docling) como a camada que
**processa PDFs e documentos uma única vez** (layout, ordem de leitura, tabelas,
OCR quando necessário), guarda o **JSON completo** como fonte da verdade e envia
à IA um **Markdown otimizado com referência de página** — em vez de mandar o
arquivo cru e deixar cada modelo re-extrair.

> **Estado:** Fase 1 (fundação), atrás da flag `DOCLING_ENABLED` (padrão
> **desligado**). Com a flag desligada, o app se comporta exatamente como antes.

## Por que

Antes, PDFs não eram extraídos no servidor: um aviso em texto instruía o próprio
modelo a extrair via ferramentas no sandbox. Isso gerava consumo de tokens,
perda de estrutura, leitura ruim de tabelas, resultados diferentes por modelo e
reprocessamento a cada pergunta/modelo. A camada Docling resolve isso com um
**artefato cacheado por hash**, reutilizado por chat, assistentes, modo dev e
multi-modelo.

## Arquitetura

```
Upload → hash(sha256) → [cache?] → docling-service (dedicado, offline, rede interna)
  → JSON completo (fonte da verdade)         ← auditoria/rastreabilidade
  → Markdown otimizado + chunks (com página) ← enviado à IA
  → seleção de trechos relevantes            → modelo(s)
```

- **docling-service/** — serviço FastAPI **dedicado e permanente** (modelos
  carregados uma vez). Escuta **apenas na rede interna do Docker** (sem `ports`),
  com **token interno** (`X-Internal-Token`), **fila de concorrência**
  (semáforo + thread pool), **cache por hash+config**, **timeout**,
  **cancelamento**, **progresso por estágio**, `/health`, **limites** de
  tamanho/páginas/memória/CPU, **logs sem conteúdo** e **limpeza de temporários**.
  Roda **offline**: os modelos (`ds4sd/docling-models`) são pré-baixados no build
  para um volume (`docling_models`).
- **backend/src/docling/** — a orquestração em Node (testável e única para todos
  os modelos):
  - `hash.js` — sha256 do conteúdo (identidade/cache/dedup).
  - `config.js` — flag, opções e `configVersion` (invalida o cache).
  - `runner.js` — cliente HTTP do serviço (enfileira → acompanha → cancela).
  - `markdown.js` — otimização (remove cabeçalho/rodapé repetido, páginas
    duplicadas, ruído) **sem descartar conteúdo útil**.
  - `chunker.js` — chunking **semântico** por seções, tabela inteira preservada,
    com página/seção/tipo/referência e limite de tokens.
  - `tokens.js` — estimativa de tokens e cálculo de economia.
  - `service.js` — `processFile()` idempotente por (user, hash, config): cache →
    serviço → otimização → chunks → persistência + métricas.
  - `context.js` — monta o conteúdo (Markdown/chunks relevantes com página) que é
    injetado no modelo; **null** quando desligado/sem documento (→ fluxo atual).
- **Banco:** `files` ganhou `hash`/`mime`; `document_processings` guarda o cache
  (status, engine, OCR, páginas, tabelas, caminhos de JSON/MD/chunks, métricas).
- **Pontos de integração** (mínimo impacto):
  - upload (`routes/conversations.js`): calcula hash+mime e dispara o
    processamento em segundo plano.
  - agente (`agent/loop.js`): injeta o conteúdo pré-extraído quando houver;
    senão, mantém o comportamento atual (fallback, sem regressão).
  - rotas (`routes/docling.js`): status, resultados, Markdown/JSON/chunks,
    reprocessar.
  - UI (`DoclingPanel` + `useDocling`): andamento e estatísticas no drawer de
    arquivos.

## Como ligar

1. Gere um token interno: `openssl rand -hex 32` → `DOCLING_INTERNAL_TOKEN`.
2. No `.env`: `DOCLING_ENABLED=true` e o token acima.
3. O `docling-service` fica atrás do **profile `docling`** do compose (para não
   forçar o build pesado — torch + modelos — em quem não usa). Suba com o profile:
   `docker compose --profile docling up -d --build`
   (o build baixa os modelos — precisa de rede **no build**; em runtime roda
   offline). Em produção: `docker compose -f docker-compose.prod.yml --profile docling up -d --build`.
4. Verifique a saúde: o backend expõe `GET /api/docling/status` (mostra
   `health.models_loaded`).

> Com `DOCLING_ENABLED=false` (padrão) ou sem subir o profile `docling`, o app
> funciona normalmente pelo método atual — a integração fica inerte.

## Multi-modelo

Como a extração vira artefato cacheado, **todos os modelos recebem a mesma
extração** (mesmo Markdown, mesmas tabelas, mesmas referências de página) — nada
de re-extrair por modelo. Um segundo modelo revisor recebe os trechos usados + a
resposta do primeiro + as referências de página.

## Segurança e LGPD

Processamento na própria infraestrutura (serviço interno, sem porta pública, sem
rede em runtime). O JSON completo e os artefatos ficam no volume do backend
(`DOCLING_CACHE_ROOT`), isolados por usuário no caminho. Logs do serviço não
registram conteúdo. Excluir a conversa remove os arquivos originais; a limpeza
dos artefatos derivados por retenção entra numa fase seguinte.

## Fase 2 — tabelas (concluída)

- **Validação de coerência** de cada tabela (`tables.js`): confere nº de colunas
  consistente, cabeçalho presente/preenchido, existência de linhas e colunas
  vazias. Os alertas entram nas métricas (`stats.tablesWithWarnings`,
  `stats.tableDetails`) e no status (`done_warnings`).
- **Exportação CSV** por tabela: `GET /api/docling/documents/:id/tables/:index/csv`
  (com BOM para o Excel abrir acentos). Lista em
  `GET /api/docling/documents/:id/tables`.
- **Cautela ao modelo**: no contexto injetado, uma tabela com estrutura suspeita
  recebe um aviso pedindo conferência na página, em vez de afirmar valores.
- **UI**: o painel mostra "N tabelas (M alerta)", lista as tabelas com
  linhas×colunas e link de download CSV.
- Testes: `backend/src/docling/tables.test.js`.

## Fase 3 — seleção por embeddings (concluída)

Para documentos grandes (que não cabem inteiros no orçamento), a escolha dos
trechos deixa de ser só por palavras e passa a usar **similaridade semântica**,
reusando a infra de embeddings do app (`memory/embeddings.js`, a mesma da
memória/RAG):

- No **processamento**, os vetores de cada chunk são pré-computados e salvos
  (`embeddings.json`) — assim não se reembeda a cada pergunta e **todos os
  modelos reusam a mesma seleção**.
- Na **pergunta**, o vetor da questão é gerado uma vez e os chunks são ranqueados
  por cosseno (`semantic.js` → `rankBySimilarity`), preenchendo até o orçamento.
- **Fallback** automático para a seleção por palavras quando os embeddings estão
  indisponíveis (modo degradado) — sem quebrar nada.
- A UI marca "semântica" quando ela está ativa para o documento.
- Testes: `backend/src/docling/semantic.test.js`.

## Fase 4 — painel administrativo (concluída)

Configuração do Docling pela interface (somente admin), sem reiniciar o
container:

- **`adminConfig.js`**: overrides globais (uma linha JSON em `settings`) com
  precedência sobre o ambiente — `ocr` (auto/always/never), `lang`, `tables`,
  `formulas`, `maxPages`, `maxChunkTokens`. Sanitizados e mesclados em
  `resolvedOptions()`.
- **Rotas**: `GET /docling/status` agora traz `isAdmin`, as opções vigentes e a
  saúde do serviço; `PUT /docling/config` (admin) grava os overrides. Mudar
  qualquer opção altera o `configVersion` → o cache é invalidado e os documentos
  reprocessados sob demanda.
- **Serviço (`app.py`)**: passa a honrar as opções por job (OCR on/off/força,
  idioma, tabelas, fórmulas) com um cache de converters por conjunto de opções.
- **UI**: seção "Configurações (admin)" no painel + indicador de saúde do serviço.
- Testes: `backend/src/docling/adminConfig.test.js`.

## Fase 5 — elementos visuais (concluída)

Gráficos, assinaturas, selos e comprovantes não se perdem mais na conversão para
texto (seção "Imagens, gráficos e elementos visuais"):

- **`app.py`**: liga `generate_picture_images` e extrai cada figura como PNG
  (redimensionado), com página e posição — `_extract_pictures`. Figuras que não
  puderam ser renderizadas são registradas mesmo assim (nunca somem em silêncio).
- **`service.js`**: persiste as imagens (`pictures/<n>.png`) + metadados
  (`pictures.json`); stats ganham `pictureCount` e `picturesUnrendered`.
- **`vision.js`**: `visualElementsNote` (nota transparente adaptada à visão do
  modelo) e `doclingImageParts` (partes image_url das figuras).
- **`loop.js`**: com modelo COM visão, anexa as figuras junto com as imagens dos
  uploads; SEM visão, injeta um aviso para o modelo **não fingir** que
  interpretou o elemento (e sugerir um modelo com visão).
- **Rotas**: `GET /docling/documents/:id/pictures` e `.../pictures/:index` (PNG).
- **UI**: selo "N visuais", botão "Visuais" com miniaturas por página.
- Testes: `backend/src/docling/vision.test.js`.

## Fase 6 — retenção e exclusão (LGPD) (concluída)

Os artefatos derivados (JSON/Markdown/chunks/embeddings/figuras) ficam num cache
no disco do backend, fora do workspace da conversa. Antes, apagar a
conversa/arquivo não os removia. Agora:

- **`retention.js`**: `purgeIfOrphan` (apaga os derivados quando o usuário não
  tem mais nenhum arquivo com aquele hash), `purgeByHash`, `purgeProcessing`,
  `sweepExpiredArtifacts` (varredura por tempo) e `isExpired` (pura, testável).
- **Exclusão de arquivo** (`routes/conversations.js`) e **de conversa**
  (`privacy.js`) passam a limpar os derivados órfãos na hora.
- **Rota** `DELETE /docling/documents/:id`: o usuário apaga os dados extraídos de
  um documento (o arquivo original é mantido; reprocessar recria).
- **Varredura periódica** no boot (`server.js`): `DOCLING_RETENTION_DAYS` (0 =
  desligado) apaga derivados mais antigos que N dias — nunca o original.
- **UI**: botão "Apagar dados" por documento no painel.
- Testes: `backend/src/docling/retention.test.js`.

## Fase 7 — taxonomia de falhas (concluída)

Em vez de um "falhou" genérico, cada erro é classificado e explicado (seção
"Tratamento de falhas"):

- **`failures.js`** (puro): `classifyFailure(mensagem)` → `{ kind, label,
  suggestion, canRetry }`. Tipos: `protegido` (senha), `formato_nao_suportado`,
  `corrompido`, `timeout`, `ocr_falhou`, `tabela_falhou`,
  `servico_indisponivel`, `cancelado`, `desconhecido`.
- **`service.js`**: ao falhar, grava `stats.failure` com o motivo.
- **`app.py`**: detecta PDF protegido por senha ANTES de converter, devolvendo um
  erro claro (`password/encrypted`).
- **UI**: o estado "falhou" mostra o rótulo, a sugestão do que fazer e o botão de
  tentar de novo apenas quando fizer sentido (`canRetry`).
- Testes: `backend/src/docling/failures.test.js`.

## O que falta (refinamentos menores)

- OCR por página (parcialmente digitalizado) e reprocesso com outro mecanismo.
- Células mescladas em tabelas complexas.
- Classificação do tipo de elemento visual (gráfico × assinatura × selo).

## Matriz de testes (critério de aceite)

Validar no ambiente com `DOCLING_ENABLED=true`, comparando conteúdo extraído vs.
original, nº de páginas, tabelas, referências de página, tokens antes/depois,
tempo e memória:

- PDF simples com texto · PDF digitalizado (OCR) · várias colunas · tabelas
  extensas · balanço patrimonial · DRE · relatório fiscal · Receita Federal ·
  PGFN · extrato bancário · documento com gráficos · orientações diferentes ·
  parcialmente ilegível · protegido por senha · centenas de páginas · páginas
  duplicadas.

Os módulos puros (hash, otimização de Markdown, chunking, seleção de trechos,
tokens, `configVersion`) têm testes automatizados em
`backend/src/docling/docling.test.js`.
