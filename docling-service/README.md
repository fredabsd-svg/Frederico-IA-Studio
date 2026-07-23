# docling-service

Serviço dedicado e permanente de compreensão documental (Docling). Fica sempre
no ar com os modelos carregados, escuta **apenas na rede interna do Docker**
(sem porta pública) e processa documentos sob demanda para o backend.

## API (interna — exige `X-Internal-Token`)

- `GET  /health` → `{ status, models_loaded, artifacts_path_present, queue }`
- `POST /jobs` (multipart: `file`, `hash`, `options` JSON) → `{ job_id, status, result?, cached? }`
- `GET  /jobs/{id}` → `{ status, stage, progress, result?, error? }`
- `DELETE /jobs/{id}` → cancela (best-effort)

Estados: `queued → processing → done | done_warnings | partial | failed | canceled`.

O resultado (`result`) contém: `status`, `markdown` (com marcas
`<!-- page: N -->`), `docling_json` (completo), `page_count`, `table_count`,
`ocr_used`, `warnings`, `timing_ms`.

## Variáveis de ambiente

| Var | Padrão | Descrição |
| --- | --- | --- |
| `DOCLING_INTERNAL_TOKEN` | — | Token compartilhado com o backend (obrigatório em produção). |
| `DOCLING_ARTIFACTS_PATH` | `/models` | Modelos pré-baixados (volume persistente). |
| `DOCLING_CONCURRENCY` | `2` | Jobs simultâneos (fila). |
| `DOCLING_MAX_FILE_MB` | `50` | Tamanho máximo do arquivo. |
| `DOCLING_MAX_PAGES` | `600` | Páginas máximas por documento. |
| `DOCLING_JOB_TTL_SEC` | `1800` | TTL dos jobs em memória. |

## Build e execução

O build baixa os modelos do Docling para `/models` (precisa de rede **no
build**); em runtime o container roda **offline**. É gerenciado pelo
`docker-compose` na raiz (serviço `docling-service`). Para ligar a integração,
defina `DOCLING_ENABLED=true` e `DOCLING_INTERNAL_TOKEN` no `.env` do projeto.

> Os nomes exatos da API do Docling podem variar por versão; `app.py` usa acessos
> defensivos. Ao fixar a versão do `docling` no `requirements.txt`, rode a matriz
> de testes de `docs/DOCLING.md`.
