# docling-service — imagem dedicada (pesada: torch CPU + modelos do Docling).
# Mantida separada do sandbox por-conversa e do backend justamente para NÃO
# inchar essas imagens. Os modelos são PRÉ-BAIXADOS no build e ficam na imagem
# (ou num volume) para o container rodar OFFLINE em produção.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=0 \
    DOCLING_ARTIFACTS_PATH=/models

# OCR (tesseract + português), poppler (render de PDF) e libs de runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-por poppler-utils \
      libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Torch CPU-only (evita puxar pacotes CUDA gigantes).
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# 2) Docling + API.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 3) Pré-baixa os modelos do Docling para /models (rede disponível só no BUILD).
#    Em runtime o container pode rodar sem rede, lendo daqui.
RUN python -c "from docling.utils.model_downloader import download_models; download_models(output_dir='/models')" \
    || echo "AVISO: prefetch de modelos falhou no build — rode o download no primeiro boot com rede."

COPY app.py .

# Usuário sem privilégios.
RUN useradd -m -u 1000 docling && chown -R docling:docling /app /models
USER docling

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

# 1 worker do uvicorn: a concorrência real é controlada DENTRO do app
# (semáforo + thread pool), para não multiplicar o uso de memória dos modelos.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
