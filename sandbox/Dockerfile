FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git unzip zip poppler-utils tesseract-ocr tesseract-ocr-por \
    libmagic1 fonts-dejavu fonts-liberation \
    # Dependências de runtime do WeasyPrint (Pango/Cairo/GDK-Pixbuf).
    # Sem elas, "import weasyprint" falha com erro de biblioteca compartilhada.
    libpango-1.0-0 libpangocairo-1.0-0 libpangoft2-1.0-0 \
    libcairo2 libgdk-pixbuf-2.0-0 libffi8 shared-mime-info && \
    rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
    pandas openpyxl xlsxwriter python-docx reportlab matplotlib pillow \
    pypdf PyPDF2 pdfplumber beautifulsoup4 lxml numpy tabulate \
    pytesseract python-pptx weasyprint
RUN useradd -m -u 1000 sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
