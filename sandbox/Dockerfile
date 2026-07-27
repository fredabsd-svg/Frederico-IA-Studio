FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git unzip zip poppler-utils tesseract-ocr tesseract-ocr-por \
    libmagic1 fonts-dejavu fonts-liberation \
    # Compila\u00e7\u00e3o e toolchains: C/C++, Go, Rust e Java passam a executar de verdade.
    build-essential cmake ninja-build pkg-config \
    golang-go rustc cargo default-jdk-headless \
    # Qualidade, depura\u00e7\u00e3o e diagn\u00f3stico de processos/rede.
    shellcheck valgrind gdb htop procps lsof strace \
    iproute2 net-tools dnsutils \
    # Bancos locais e clientes para inst\u00e2ncias externas (sem subir servidores no sandbox).
    sqlite3 postgresql-client default-mysql-client redis-tools \
    # Opera\u00e7\u00e3o remota por chave/configura\u00e7\u00e3o fornecida pelo usu\u00e1rio.
    openssh-client rsync ansible-core kubernetes-client \
    # Vetores e convers\u00e3o headless para design e documentos.
    inkscape librsvg2-bin potrace \
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
    # Node.js para scripts e toolchains de frontend.
    nodejs npm \
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
    # camelot + opencv: extração de tabelas com linhas em PDFs/relatórios
    PyMuPDF pdf2image ocrmypdf "camelot-py[base]" opencv-python-headless
RUN pip install --no-cache-dir \
    # Utilitários brasileiros de uso geral (funcionam OFFLINE):
    # validate-docbr: valida CPF/CNPJ/PIS/CNH/título etc.
    # num2words: valor por extenso em pt_BR (recibos, contratos, cheques)
    # xmltodict: XML <-> dicionário Python
    # signxml: assinatura XML-DSig genérica (SEM transmissão a terceiros)
    # jsonschema: valida documentos JSON contra um schema
    validate-docbr num2words xmltodict signxml jsonschema \
    # Produtividade e análise (offline):
    # duckdb: banco analítico embutido para grandes volumes de dados
    # jinja2: templates de relatórios; rapidfuzz: casar nomes/textos
    # phonenumbers: valida telefones BR; unidecode: normaliza texto
    duckdb jinja2 rapidfuzz phonenumbers Unidecode PyYAML \
    python-dateutil pytz tzdata \
    # Análise de grandes volumes e visualização avançada:
    # polars (DataFrame rápido), pyarrow (Parquet), plotly + seaborn (gráficos)
    polars pyarrow plotly seaborn \
    # Prot\u00f3tipos web, qualidade de c\u00f3digo, clientes de banco e vetores.
    flask fastapi uvicorn httpx \
    pytest black ruff mypy isort \
    sqlalchemy "psycopg[binary]" mysql-connector-python redis pymongo \
    cairosvg svglib

# Toolchains de frontend ficam globais para qualquer projeto montado no
# workspace. Assim `tsc`, `vite`, `sass`, `postcss`, `tailwindcss`, `prettier`
# e `eslint` funcionam sem uma instala\u00e7\u00e3o inicial em cada conversa.
RUN npm install -g --no-audit --no-fund \
    eslint prettier typescript vite sass postcss postcss-cli tailwindcss @tailwindcss/cli
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

# Camada adicional, mantida ao fim para reaproveitar a imagem de documentos já
# pronta quando estes recursos opcionais forem alterados.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb xauth && \
    rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
    pipenv poetry \
    scikit-learn onnxruntime transformers sentencepiece safetensors \
    psycopg2-binary
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g --no-audit --no-fund \
    yarn pnpm@10 playwright

# O pacote Kotlin do Debian é uma versão histórica. Usa o compilador JVM
# oficial atual da JetBrains para compatibilidade com projetos Kotlin modernos.
ARG KOTLIN_VERSION=2.3.21
RUN curl -fsSL "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" -o /tmp/kotlin.zip && \
    unzip -q /tmp/kotlin.zip -d /opt && \
    mv /opt/kotlinc /opt/kotlin && \
    ln -s /opt/kotlin/bin/kotlinc /usr/local/bin/kotlinc && \
    ln -s /opt/kotlin/bin/kotlin /usr/local/bin/kotlin && \
    rm -f /tmp/kotlin.zip

# SDK .NET para criar, compilar e testar aplicações C# dentro da sandbox.
# O instalador oficial é apropriado para ambientes automatizados e instala o SDK
# sem depender de um repositório de pacotes do sistema.
ENV DOTNET_ROOT=/opt/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    PATH=/opt/dotnet:${PATH}
RUN mkdir -p "$DOTNET_ROOT" && \
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && \
    bash /tmp/dotnet-install.sh --channel 10.0 --install-dir "$DOTNET_ROOT" --no-path && \
    ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet && \
    rm -f /tmp/dotnet-install.sh

# GraphQL: strawberry-graphql define o schema por type hints do Python (o módulo
# importável é `strawberry`, não `strawberry_graphql`). O extra [fastapi] traz o
# GraphQLRouter, que pluga no FastAPI já instalado acima, e o [cli] traz o comando
# `strawberry server`, que sobe um GraphiQL local para testar o schema sem escrever
# aplicação nenhuma. Fica NESTA camada final, e não junto de flask/fastapi, pelo
# mesmo motivo do bloco acima: acrescentar pacote no meio do arquivo invalidaria as
# camadas seguintes — dotnet, Kotlin, Chromium e Playwright seriam rebaixados a cada
# atualização, o que pesa demais numa VPS pequena.
RUN pip install --no-cache-dir "strawberry-graphql[fastapi,cli]"

# Kits de DESIGN profissional prontos (mesma paleta): Word (docpro), Excel
# (xlspro) e PDF (pdfpro). Importáveis como `from docpro import Relatorio`,
# `from xlspro import Planilha`, `from pdfpro import RelatorioPDF`. Dão capa,
# títulos, tabelas estilizadas com header colorido + zebra + TOTAL, callouts,
# gráficos (Excel) e rodapé paginado — sem o modelo precisar reinventar o estilo.
COPY docpro.py xlspro.py pdfpro.py /usr/local/lib/python3.12/site-packages/

# Compatibilidade com modelos que tentam salvar arquivos no caminho usado por
# outros sandboxes. Aqui ele aponta para o workspace real da conversa.
RUN mkdir -p /mnt && ln -sfnT /workspace /mnt/user-data

# CAMADAS DE PERSISTÊNCIA (plano de estabilização do ambiente).
# O container é efêmero; o que separa o trabalho preservado do descartável é
# ONDE o arquivo está:
#   /cache      → bind do host, por usuário. Cache de pip/npm/uv/poetry. É o que
#                 faz uma reinstalação depois de um reinício ser local e barata.
#   /artifacts  → aponta para /workspace/.artifacts (bind da conversa): relatórios,
#                 patches e resultados intermediários que sobrevivem ao container
#                 sem virar cartão de download (isso é papel de /workspace/outputs).
#   /runtime/tmp→ TEMPORÁRIO por design, é o TMPDIR de toda execução. Some junto
#                 com o container — nada essencial pode morar só aqui.
RUN mkdir -p /cache /runtime/tmp && \
    chown -R 1000:1000 /cache /runtime && \
    chmod 1777 /runtime/tmp && \
    ln -sfnT /workspace/.artifacts /artifacts

RUN useradd -m -u 1000 sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
