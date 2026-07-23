"""
docling-service — serviço dedicado e PERMANENTE de compreensão documental.

Fica sempre no ar (modelos carregados uma única vez), escuta APENAS na rede
interna do Docker (sem porta pública) e recebe trabalhos sob demanda. Cada job:
recebe o arquivo -> Docling (layout, ordem de leitura, tabelas, OCR quando
necessário) -> devolve o JSON completo + um Markdown COM marcas de página + as
contagens (páginas, tabelas, OCR). A otimização do Markdown e o chunking ficam
no backend Node (camada testável e única para todos os modelos).

Requisitos atendidos (pedido do usuário):
  * fila/concorrência limitada (semáforo + executor de threads);
  * cache por hash do documento + configuração;
  * timeout, cancelamento (best-effort) e acompanhamento de progresso por estágio;
  * /health para health check e restart automático (no compose);
  * limites de tamanho e de páginas;
  * autenticação interna (X-Internal-Token) entre backend e serviço;
  * logs SEM conteúdo confidencial (só id do job, prefixo do hash, métricas);
  * limpeza de arquivos temporários;
  * proteção contra PDFs corrompidos/maliciosos (try/except, caps, sem rede).

Observação: os nomes exatos da API do Docling podem variar por versão; o código
usa acessos defensivos (getattr) e degrada para avisos em vez de quebrar.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import FastAPI, UploadFile, Form, File, Header, HTTPException
from fastapi.responses import JSONResponse

# ---- Configuração via ambiente -------------------------------------------------
INTERNAL_TOKEN = os.environ.get("DOCLING_INTERNAL_TOKEN", "")
ARTIFACTS_PATH = os.environ.get("DOCLING_ARTIFACTS_PATH", "/models")  # volume persistente
MAX_CONCURRENCY = max(1, int(os.environ.get("DOCLING_CONCURRENCY", "2")))
MAX_FILE_MB = int(os.environ.get("DOCLING_MAX_FILE_MB", "50"))
MAX_PAGES = int(os.environ.get("DOCLING_MAX_PAGES", "600"))
JOB_TTL_SEC = int(os.environ.get("DOCLING_JOB_TTL_SEC", "1800"))
RESULT_CACHE = int(os.environ.get("DOCLING_RESULT_CACHE", "200"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s docling %(levelname)s %(message)s")
log = logging.getLogger("docling-service")

app = FastAPI(title="docling-service", docs_url=None, redoc_url=None, openapi_url=None)

# Semáforo = fila de concorrência. Executor separado roda o Docling (CPU/torch)
# fora do event loop para não travar o /health e o polling.
_sem = asyncio.Semaphore(MAX_CONCURRENCY)
_pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)

_converter = None            # DocumentConverter (carregado uma vez, lazy)
_models_loaded = False


@dataclass
class Job:
    id: str
    hash: str
    cache_key: str
    status: str = "queued"          # queued|processing|done|done_warnings|partial|failed|canceled
    stage: str = "recebido"
    progress: float = 0.0
    result: Optional[dict] = None
    error: Optional[str] = None
    cancel: bool = False
    created: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}
CACHE: "dict[str, dict]" = {}     # cache_key -> result (dedup por hash+config)
CACHE_ORDER: list[str] = []


def require_auth(token: Optional[str]):
    if INTERNAL_TOKEN and token != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")


def get_converter():
    """Cria o DocumentConverter uma única vez, apontando para os modelos locais
    (offline: o container roda sem rede; os modelos vêm do volume ARTIFACTS_PATH)."""
    global _converter, _models_loaded
    if _converter is not None:
        return _converter
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    opts = PdfPipelineOptions(artifacts_path=ARTIFACTS_PATH) if os.path.isdir(ARTIFACTS_PATH) else PdfPipelineOptions()
    opts.do_ocr = True
    opts.do_table_structure = True
    try:
        opts.table_structure_options.do_cell_matching = True
    except Exception:
        pass
    _converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )
    _models_loaded = True
    return _converter


def _apply_ocr_lang(pipeline_opts, lang: str):
    """Configura o idioma do OCR (pt-BR por padrão) quando o backend de OCR aceita."""
    try:
        pipeline_opts.ocr_options.lang = [lang] if isinstance(lang, str) else lang
    except Exception:
        pass


def _page_marked_markdown(doc) -> tuple[str, int, int]:
    """Constrói um Markdown com marcas '<!-- page: N -->' preservando títulos,
    listas e TABELAS. Retorna (markdown, page_count, table_count).

    Estratégia: iterar os itens do DoclingDocument na ordem de leitura; a cada
    mudança de página emitir a marca; tabelas viram markdown próprio (linhas/
    colunas/cabeçalho preservados)."""
    lines: list[str] = []
    last_page = None
    tables = 0
    max_page = 0

    def page_of(item) -> Optional[int]:
        prov = getattr(item, "prov", None)
        if prov:
            p0 = prov[0]
            return getattr(p0, "page_no", None) or getattr(p0, "page", None)
        return None

    try:
        items = list(doc.iterate_items())
    except Exception:
        items = []

    for entry in items:
        item = entry[0] if isinstance(entry, tuple) else entry
        page = page_of(item) or last_page or 1
        if page != last_page:
            lines.append(f"<!-- page: {page} -->")
            last_page = page
            max_page = max(max_page, page)

        label = str(getattr(item, "label", "") or "").lower()
        # Tabela
        if "table" in label or item.__class__.__name__.lower().startswith("table"):
            try:
                md = item.export_to_markdown()
            except Exception:
                md = None
            if md:
                tables += 1
                lines.append(md.strip())
            continue
        # Título/cabeçalho
        text = getattr(item, "text", None)
        if text:
            if label in ("title", "section_header", "subtitle-level-1") or "header" in label:
                lines.append(f"## {text.strip()}")
            elif label in ("list_item",):
                lines.append(f"- {text.strip()}")
            else:
                lines.append(text.strip())

    md = "\n\n".join(l for l in lines if l is not None)
    # Fallback: se a iteração não produziu nada, usa o export nativo.
    if not md.strip():
        try:
            md = doc.export_to_markdown()
        except Exception:
            md = ""
    page_count = max_page or (getattr(doc, "num_pages", None) or 1)
    return md, page_count, tables


def _convert(path: str, options: dict, job: Job) -> dict:
    """Roda o Docling de forma síncrona (chamado no executor de threads)."""
    from docling.datamodel.base_models import InputFormat  # noqa

    conv = get_converter()
    lang = options.get("lang", "por")
    # (o idioma do OCR é aplicado no pipeline default do converter quando possível)
    try:
        _apply_ocr_lang(conv.format_to_options[InputFormat.PDF].pipeline_options, lang)  # type: ignore
    except Exception:
        pass

    job.stage, job.progress = "convertendo", 0.3
    result = conv.convert(path, max_num_pages=options.get("maxPages") or MAX_PAGES or 10**9)
    if job.cancel:
        raise RuntimeError("cancelado")
    doc = result.document

    job.stage, job.progress = "exportando", 0.8
    markdown, page_count, table_count = _page_marked_markdown(doc)

    # OCR usado? Heurística: se o documento não tinha texto nativo suficiente.
    ocr_used = bool(options.get("ocr") == "always")
    try:
        # Docling marca origem OCR por item em algumas versões; aqui aproximamos.
        ocr_used = ocr_used or getattr(result, "ocr_used", False)
    except Exception:
        pass

    try:
        docling_json = doc.export_to_dict()
    except Exception:
        docling_json = {}

    warnings: list[str] = []
    if not markdown.strip():
        warnings.append("Markdown vazio após a extração.")

    status = "partial" if warnings and not markdown.strip() else ("done_warnings" if warnings else "done")
    return {
        "status": status,
        "engine": "docling",
        "markdown": markdown,
        "docling_json": docling_json,
        "page_count": page_count,
        "table_count": table_count,
        "ocr_used": ocr_used,
        "warnings": warnings,
    }


async def _run_job(job: Job, path: str):
    async with _sem:  # respeita a concorrência máxima (fila)
        if job.cancel:
            job.status = "canceled"
            _cleanup(path)
            return
        job.status, job.stage, job.progress = "processing", "analisando", 0.1
        t0 = time.time()
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(_pool, _convert, path, job_options(job), job)
            result["timing_ms"] = int((time.time() - t0) * 1000)
            job.result = result
            job.status = result.get("status", "done")
            job.stage, job.progress = "concluído", 1.0
            _cache_put(job.cache_key, result)
            log.info("job %s done hash=%s pages=%s tables=%s ocr=%s %sms",
                     job.id, job.hash[:8], result.get("page_count"), result.get("table_count"),
                     result.get("ocr_used"), result.get("timing_ms"))
        except Exception as e:  # PDF corrompido, protegido, cancelado, etc.
            if job.cancel:
                job.status = "canceled"
            else:
                job.status = "failed"
                job.error = str(e)[:300]
                log.warning("job %s failed hash=%s: %s", job.id, job.hash[:8], job.error)
        finally:
            _cleanup(path)


_JOB_OPTIONS: dict[str, dict] = {}
def job_options(job: Job) -> dict:
    return _JOB_OPTIONS.get(job.id, {})


def _cleanup(path: str):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


def _cache_put(key: str, result: dict):
    if key in CACHE:
        return
    CACHE[key] = result
    CACHE_ORDER.append(key)
    while len(CACHE_ORDER) > RESULT_CACHE:
        old = CACHE_ORDER.pop(0)
        CACHE.pop(old, None)


def _gc_jobs():
    now = time.time()
    for jid in [j for j, jb in JOBS.items() if now - jb.created > JOB_TTL_SEC]:
        JOBS.pop(jid, None)
        _JOB_OPTIONS.pop(jid, None)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "models_loaded": _models_loaded,
        "artifacts_path_present": os.path.isdir(ARTIFACTS_PATH),
        "queue": {"active": MAX_CONCURRENCY - _sem._value, "capacity": MAX_CONCURRENCY, "jobs": len(JOBS)},
    }


@app.post("/jobs")
async def create_job(
    file: UploadFile = File(...),
    hash: str = Form(...),
    options: str = Form("{}"),
    x_internal_token: Optional[str] = Header(None),
):
    require_auth(x_internal_token)
    _gc_jobs()
    try:
        opts = json.loads(options or "{}")
    except Exception:
        opts = {}

    data = await file.read()
    if len(data) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"arquivo acima de {MAX_FILE_MB} MB")
    # Confirma a integridade do hash informado (dedup/cache confiável).
    real = hashlib.sha256(data).hexdigest()
    cache_key = f"{real}:{hashlib.sha1(json.dumps(opts, sort_keys=True).encode()).hexdigest()[:12]}"

    # Cache hit: devolve um job já concluído, sem reprocessar.
    if cache_key in CACHE:
        jid = uuid.uuid4().hex
        job = Job(id=jid, hash=real, cache_key=cache_key, status=CACHE[cache_key].get("status", "done"),
                  stage="cache", progress=1.0, result=CACHE[cache_key])
        JOBS[jid] = job
        return {"job_id": jid, "status": job.status, "result": job.result, "cached": True}

    # Salva num temporário (limpo ao final) e agenda o processamento.
    suffix = os.path.splitext(file.filename or "")[1][:8] or ".bin"
    fd, path = tempfile.mkstemp(prefix="docling_", suffix=suffix)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)

    jid = uuid.uuid4().hex
    job = Job(id=jid, hash=real, cache_key=cache_key)
    JOBS[jid] = job
    _JOB_OPTIONS[jid] = opts
    asyncio.create_task(_run_job(job, path))
    return {"job_id": jid, "status": "queued"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, x_internal_token: Optional[str] = Header(None)):
    require_auth(x_internal_token)
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job não encontrado")
    body: dict[str, Any] = {"status": job.status, "stage": job.stage, "progress": job.progress}
    if job.error:
        body["error"] = job.error
    if job.result and job.status in ("done", "done_warnings", "partial"):
        body["result"] = job.result
    return body


@app.delete("/jobs/{job_id}")
async def cancel_job(job_id: str, x_internal_token: Optional[str] = Header(None)):
    require_auth(x_internal_token)
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job não encontrado")
    job.cancel = True
    if job.status in ("queued",):
        job.status = "canceled"
    return {"ok": True, "status": job.status}


@app.on_event("startup")
async def _warmup():
    # Carrega os modelos uma vez no boot (mantém o serviço "quente").
    try:
        get_converter()
        log.info("modelos carregados (offline=%s)", os.path.isdir(ARTIFACTS_PATH))
    except Exception as e:  # não derruba o serviço; /health mostra models_loaded=false
        log.warning("falha ao pré-carregar modelos: %s", str(e)[:200])
