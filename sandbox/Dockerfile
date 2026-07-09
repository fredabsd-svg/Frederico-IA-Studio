FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git unzip zip poppler-utils tesseract-ocr tesseract-ocr-por \
    libmagic1 fonts-dejavu fonts-liberation \
    # Ghostscript: exigido pelo ocrmypdf e pelo camelot (leitura de PDF)
    ghostscript \
    # ffmpeg: edição de vídeo e áudio (cortar, juntar, converter, extrair)
    ffmpeg \
    # LibreOffice headless (soffice): conversões de documentos —
    # .xls antigo -> .xlsx, docx/xlsx/pptx -> PDF com layout fiel, .doc, .odt
    libreoffice-calc libreoffice-writer libreoffice-impress \
    # Fontes metricamente compatíveis com Calibri/Cambria (fidelidade no PDF)
    fonts-crosextra-carlito fonts-crosextra-caladea \
    # Ferramentas de shell para dados/documentos: JSON (jq), XML (xmlstarlet),
    # estrutura de PDF (qpdf) e manipulação de imagens (imagemagick)
    jq xmlstarlet qpdf imagemagick \
    # Node.js (scripts JS) e Java JRE (validadores SPED/eSocial, ferramentas
    # fiscais brasileiras baseadas em Java). Ambos rodam offline.
    nodejs npm default-jre-headless \
    # Dependências de runtime do WeasyPrint (Pango/Cairo/GDK-Pixbuf).
    # Sem elas, "import weasyprint" falha com erro de biblioteca compartilhada.
    libpango-1.0-0 libpangocairo-1.0-0 libpangoft2-1.0-0 \
    libcairo2 libgdk-pixbuf-2.0-0 libffi8 shared-mime-info && \
    rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
    pandas openpyxl xlsxwriter python-docx reportlab matplotlib pillow \
    pypdf PyPDF2 pdfplumber beautifulsoup4 lxml numpy tabulate \
    pytesseract python-pptx weasyprint \
    # Formatos de planilha legados/alternativos: .xls (xlrd), .xlsb, .ods
    xlrd pyxlsb odfpy \
    # Kit reforçado de leitura de PDF:
    # PyMuPDF (fitz): extração robusta de texto/layout, o melhor para PDFs difíceis
    # pdf2image: converte páginas em imagens (para OCR com pytesseract)
    # ocrmypdf: adiciona camada de texto OCR a PDFs escaneados
    # camelot + opencv: extração de tabelas com linhas (relatórios contábeis)
    PyMuPDF pdf2image ocrmypdf "camelot-py[base]" opencv-python-headless
RUN pip install --no-cache-dir \
    # Fiscal/contábil brasileiro (funcionam OFFLINE, sem acesso à SEFAZ):
    # validate-docbr: valida CPF/CNPJ/PIS/CNH/título etc.
    # num2words: valor por extenso em pt_BR (cheques, recibos, contratos)
    # xmltodict: XML fiscal (NF-e/CT-e) <-> dicionário Python
    # signxml: assinatura XML-DSig (base para NF-e/eSocial; SEM transmissão)
    # jsonschema: valida JSON de eSocial/Reinf/DCTFWeb contra schema
    validate-docbr num2words xmltodict signxml jsonschema \
    # Produtividade e análise (offline):
    # duckdb: banco analítico embutido para grandes volumes fiscais
    # jinja2: templates de relatórios; rapidfuzz: casar nomes de empresas
    # phonenumbers: valida telefones BR; unidecode: normaliza texto
    duckdb jinja2 rapidfuzz phonenumbers Unidecode PyYAML \
    python-dateutil pytz tzdata \
    # Análise de grandes volumes e visualização avançada:
    # polars (DataFrame rápido), pyarrow (Parquet), plotly + seaborn (gráficos)
    polars pyarrow plotly seaborn
# Fontes reais da Microsoft (Arial, Times New Roman, Courier New...) para
# fidelidade em documentos brasileiros. A Liberation (já instalada) é
# metricamente compatível e continua como fallback se o download falhar.
# O bloco termina com "; true" para nunca quebrar o build por falha de rede.
RUN sed -i 's/Components: main/Components: main contrib/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update >/dev/null 2>&1 || true; \
    echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections; \
    apt-get install -y --no-install-recommends cabextract wget ttf-mscorefonts-installer || true; \
    fc-cache -f >/dev/null 2>&1 || true; \
    rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
