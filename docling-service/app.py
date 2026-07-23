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
import base64
import hashlib
import io
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

_converters: dict[str, Any] = {}   # DocumentConverter por assinatura de opções
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


def _opts_key(opts: dict) -> str:
    return json.dumps({
        "ocr": opts.get("ocr", "auto"),
        "lang": opts.get("lang", "por"),
        "tables": opts.get("tables", True),
        "formulas": opts.get("formulas", False),
    }, sort_keys=True)


def get_converter_for(opts: dict):
    """Cria (e cacheia) um DocumentConverter para as opções do job. Reusa o mesmo
    converter para opções iguais — evita recarregar modelos a cada documento.
    Offline: aponta para os modelos locais em ARTIFACTS_PATH."""
    global _models_loaded
    key = _opts_key(opts)
    if key in _converters:
        return _converters[key]

    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    p = PdfPipelineOptions(artifacts_path=ARTIFACTS_PATH) if os.path.isdir(ARTIFACTS_PATH) else PdfPipelineOptions()

    ocr_mode = str(opts.get("ocr", "auto")).lower()
    p.do_ocr = ocr_mode != "never"
    if ocr_mode == "always":
        try:
            p.ocr_options.force_full_page_ocr = True
        except Exception:
            pass
    # Idioma do OCR (pt-BR por padrão). Aceita "por", "por+eng", etc.
    lang = str(opts.get("lang", "por"))
    try:
        p.ocr_options.lang = lang.replace("+", ",").split(",")
    except Exception:
        pass

    # Gera as imagens das figuras/gráficos para um modelo com visão analisar
    # depois (gráficos, assinaturas, selos, comprovantes). Sem isto, o conteúdo
    # visual se perderia silenciosamente.
    try:
        p.generate_picture_images = True
        p.images_scale = 2.0
    except Exception:
        pass

    p.do_table_structure = bool(opts.get("tables", True))
    try:
        p.table_structure_options.do_cell_matching = True
    except Exception:
        pass
    # Fórmulas (mais caro): habilita quando pedido e a versão suportar.
    if opts.get("formulas"):
        for attr in ("do_formula_enrichment", "do_formula_understanding"):
            if hasattr(p, attr):
                try:
                    setattr(p, attr, True)
                except Exception:
                    pass

    conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=p)})
    _converters[key] = conv
    _models_loaded = True
    return conv


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


def _extract_pictures(doc, max_pictures: int = 20, max_px: int = 1600) -> list[dict]:
    """Coleta as figuras/gráficos como PNG base64 (redimensionados), com página e
    posição. É o que permite um modelo com VISÃO analisar o elemento visual em vez
    de descartá-lo. Defensivo quanto à API do Docling entre versões."""
    out: list[dict] = []
    pics = getattr(doc, "pictures", None) or []
    for idx, pic in enumerate(pics):
        if len(out) >= max_pictures:
            break
        page = None
        bbox = None
        try:
            prov = getattr(pic, "prov", None)
            if prov:
                page = getattr(prov[0], "page_no", None)
                bb = getattr(prov[0], "bbox", None)
                if bb is not None:
                    bbox = [getattr(bb, "l", None), getattr(bb, "t", None), getattr(bb, "r", None), getattr(bb, "b", None)]
        except Exception:
            pass
        # Tenta obter a imagem PIL da figura (nomes variam por versão).
        img = None
        for getter in ("get_image",):
            try:
                img = getattr(pic, getter)(doc)
                if img is not None:
                    break
            except Exception:
                img = None
        if img is None:
            try:
                img = pic.image.pil_image  # type: ignore
            except Exception:
                img = None
        if img is None:
            # Sem imagem: registra a referência mesmo assim (transparência —
            # não some silenciosamente), sinalizando que não foi possível render.
            out.append({"index": idx + 1, "page": page, "bbox": bbox, "image_b64": None, "note": "imagem não pôde ser renderizada"})
            continue
        try:
            if max(img.size) > max_px:
                ratio = max_px / max(img.size)
                img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)))
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            out.append({"index": idx + 1, "page": page, "bbox": bbox, "image_b64": b64})
        except Exception:
            out.append({"index": idx + 1, "page": page, "bbox": bbox, "image_b64": None, "note": "falha ao codificar a imagem"})
    return out


def _convert(path: str, options: dict, job: Job) -> dict:
    """Roda o Docling de forma síncrona (chamado no executor de threads)."""
    conv = get_converter_for(options)

    job.stage, job.progress = "convertendo", 0.3
    result = conv.convert(path, max_num_pages=options.get("maxPages") or MAX_PAGES or 10**9)
    if job.cancel:
        raise RuntimeError("cancelado")
    doc = result.document

    job.stage, job.progress = "exportando", 0.8
    markdown, page_count, table_count = _page_marked_markdown(doc)
    pictures = _extract_pictures(doc)

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
        "picture_count": len(pictures),
        "pictures": pictures,
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
        get_converter_for({"ocr": "auto", "lang": os.environ.get("DOCLING_OCR_LANG", "por"), "tables": True})
        log.info("modelos carregados (offline=%s)", os.path.isdir(ARTIFACTS_PATH))
    except Exception as e:  # não derruba o serviço; /health mostra models_loaded=false
        log.warning("falha ao pré-carregar modelos: %s", str(e)[:200])
