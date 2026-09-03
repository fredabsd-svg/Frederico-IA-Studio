"""pdfpro — motor de layout profissional para PDF (.pdf) sobre reportlab.

Instalado no sandbox do Frederico AI Studio. O objetivo deste módulo NÃO é
"ter alguns helpers bonitos": é ser a ÚNICA porta de entrada para gerar PDF,
de modo que nenhum documento saia com os defeitos estruturais clássicos de
quem desenha reportlab na mão (margens de tamanhos diferentes na mesma página,
glifo inexistente no lugar do marcador de lista, numeração de página que
"anda" quando passa de 9 para 10, fonte não embutida, texto que não pode ser
copiado).

## O contrato de layout (por que existe UMA grade)

O erro mais caro em PDF gerado por modelo é o texto começar em coordenadas
levemente diferentes conforme o bloco (título, parágrafo, célula, callout,
rodapé). A olho isso lê como "documento mal feito" mesmo quando o conteúdo
está certo. Aqui existem exatamente DUAS arestas verticais, e elas são
constantes no documento inteiro:

    X_CAIXA  = onde começa qualquer CAIXA (fundo de callout, faixa do
               cabeçalho de tabela, barra da capa, régua do rodapé)
    X_TEXTO  = X_CAIXA + RECUO = onde começa QUALQUER TEXTO, sem exceção
               (corpo, título, primeira coluna da tabela, marcador de lista,
               texto do rodapé, dados da capa)

Todo bloco deste módulo é construído para pousar o texto em X_TEXTO. Nenhum
bloco aceita recuo próprio, nenhum bloco usa largura literal em cm. A barra de
destaque à esquerda de títulos e callouts é uma COLUNA da tabela (largura
`BARRA`), não um `LINEBEFORE` — assim ela fica inteiramente dentro da caixa e
não empurra o texto nem invade a margem.

## Tipografia

Uma escala fechada (`ESCALA`) e a identidade **"Tinta & Latão"**: Source Serif 4
nos títulos, na capa e nos números de destaque; Source Sans 3 no corpo, nas
tabelas e no rodapé. A fonte é EMBUTIDA (TrueType),
o que resolve de uma vez: cobertura de acentos e símbolos, texto copiável e
pesquisável (o reportlab emite `/ToUnicode` para TTF) e renderização igual em
qualquer leitor. Se nenhuma TTF existir na máquina, cai para as Type1 base-14 —
e nesse caso o saneamento converte para ASCII tudo que o WinAnsi não cobre.
Caractere sem glifo NUNCA chega ao reportlab: ele seria emitido como `\\177`
(DEL) e apareceria como quadrado preto ou vazio dependendo do leitor.

Uso mínimo:
    from pdfpro import RelatorioPDF
    r = RelatorioPDF("/workspace/outputs/proposta.pdf",
                     titulo="Proposta Comercial", cliente="ACME LTDA",
                     emissor="Meu Escritório", subtitulo="Serviços contábeis",
                     tipo="PROPOSTA COMERCIAL")
    r.capa()
    r.sumario()                       # opcional; monta a partir dos títulos
    r.titulo("1. Escopo")
    r.paragrafo("Texto ...")
    r.lista(["primeiro item", "segundo item"])
    r.tabela(["Serviço", "Valor"], [["Contabilidade", "R$ 1.200,00"],
             ["TOTAL", "R$ 1.200,00"]], total=True)
    r.callout("OBSERVAÇÃO", "texto")
    r.salvar()                        # já audita o arquivo gerado

Documento registrável (ata, contrato) — mesmo motor, zero cor, serifada:
    r = RelatorioPDF(caminho, titulo="...", estilo="sobrio")
"""
import base64
import os
import re
import unicodedata
import zlib
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import unicode2T1
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as _canvas
from reportlab.platypus import (BaseDocTemplate, Frame, Image, KeepTogether,
                                PageBreak, PageTemplate, Paragraph, Spacer,
                                Table, TableStyle)
from reportlab.platypus.tableofcontents import TableOfContents

import kits
from kits import (KitError, achado, achados_de_placeholder, e_numero,
                  escala_kpi, falha_se_grave, fmt, formata_valor,
                  liga_identificadores, linha_de_total, linhas_de_kpi,
                  normaliza_linhas, paleta_para, relatorio, tipos_de_coluna)

# ---------------------------------------------------------------------------
# 1. GRADE — fonte única de verdade das coordenadas
# ---------------------------------------------------------------------------

PAGINA = A4
MARGEM = {"esq": 2.2 * cm, "dir": 2.2 * cm, "sup": 2.2 * cm, "inf": 2.4 * cm}

#: Distância entre a borda de uma caixa e o texto dentro dela. É o ÚNICO
#: recuo do documento: título, parágrafo, célula, callout e rodapé usam este
#: mesmo valor, então todo texto pousa exatamente em X_TEXTO.
RECUO = 10.0
#: Espessura da barra de destaque à esquerda (coluna própria da tabela).
BARRA = 2.5

LARGURA_CAIXA = PAGINA[0] - MARGEM["esq"] - MARGEM["dir"]
X_CAIXA = MARGEM["esq"]
X_TEXTO = X_CAIXA + RECUO
LARGURA_TEXTO = LARGURA_CAIXA - 2 * RECUO
#: Linha de base do rodapé e da régua acima dele (abaixo do frame de conteúdo).
Y_RODAPE = 1.25 * cm
Y_REGUA_RODAPE = Y_RODAPE + 0.30 * cm

#: Escala tipográfica FECHADA, a MESMA dos três kits (vem de `kits.ESCALA`).
#: Uma escala por kit é como o mesmo pacote de entrega sai com o título do PDF
#: num corpo e o do Word noutro.
ESCALA = dict(kits.ESCALA)
#: Multiplicador de entrelinha do reportlab (não confundir com
#: `kits.ENTRELINHA`, que é o espaçamento de linha do Word).
ENTRELINHA = 1.42

# Identidade "Tinta & Latão": verde-tinta profundo com acento em latão. Vem de
# `kits.PALETA` — os três kits leem a MESMA definição, senão o verde do PDF e o
# do Word divergem no mesmo pacote de entrega. A chave `primaria` continua
# existindo como ALIAS de `tinta`.
PALETA = {k: (colors.white if v == "FFFFFF" else colors.HexColor("#" + v))
          for k, v in kits.PALETA.items()}

#: Cores dos gráficos, na ordem das séries/fatias.
CORES_GRAF = [colors.HexColor(c) for c in kits.CORES_GRAF]

#: Registro por tipo de documento — o MESMO do docpro, para o modelo escolher o
#: preset e não os blocos. `sobrio` existe só aqui (no Word ele é a classe
#: `docpro.Sobrio`).
PRESETS = {
    "gerencial": {"capa": "faixa", "sumario": "auto", "numeracao": "secao",
                  "corpo": "esquerda", "fechamento": "auto",
                  "tipo": "RELATÓRIO GERENCIAL"},
    "parecer": {"capa": "simples", "sumario": "auto", "numeracao": "decimal",
                "corpo": "justificado", "fechamento": "faixa",
                "tipo": "PARECER TÉCNICO"},
    "proposta": {"capa": "faixa", "sumario": "nunca", "numeracao": None,
                 "corpo": "esquerda", "fechamento": "faixa",
                 "tipo": "PROPOSTA COMERCIAL"},
    "carta": {"capa": None, "sumario": "nunca", "numeracao": None,
              "corpo": "justificado", "fechamento": "assinatura",
              "tipo": "CARTA"},
    "sobrio": {"capa": None, "sumario": "nunca", "numeracao": None,
               "corpo": "justificado", "fechamento": "assinatura",
               "tipo": ""},
}
#: Sumário automático só a partir deste número de seções de 1º nível, e nunca
#: com página própria abaixo de `LIMITE_SUMARIO_SEM_PAGINA` entradas.
MINIMO_SECOES_PARA_SUMARIO = 4
LIMITE_SUMARIO_SEM_PAGINA = 10
#: Acima deste número de linhas a tabela pode quebrar entre páginas.
LIMITE_TABELA_INDIVISIVEL = 15


def _paleta_reportlab(cor_marca=None):
    """A paleta de `kits.py` (hex) convertida para cores do reportlab."""
    return {k: colors.HexColor("#" + v) if v != "FFFFFF" else colors.white
            for k, v in paleta_para(cor_marca).items()}


#: Paleta do documento SÓBRIO/registrável: zero cor (só preto e cinzas), para
#: ata, contrato e alteração contratual — o mesmo critério do `docpro.Sobrio`.
PALETA_SOBRIA = {
    "tinta": colors.black, "primaria": colors.black,
    "apoio": colors.HexColor("#333333"),
    "latao": colors.HexColor("#333333"), "latao_claro": colors.HexColor("#666666"),
    "corpo": colors.black, "cinza": colors.HexColor("#444444"),
    "suave": colors.HexColor("#F4F4F4"), "borda": colors.HexColor("#BBBBBB"),
    "borda_leve": colors.HexColor("#DDDDDD"), "branco": colors.white,
    "creme": colors.HexColor("#DDDDDD"),
    "alerta_bg": colors.HexColor("#F4F4F4"), "alerta_bd": colors.HexColor("#333333"),
    "critico_bg": colors.HexColor("#F4F4F4"), "critico_bd": colors.black,
    "sucesso_bg": colors.HexColor("#F4F4F4"), "sucesso_bd": colors.HexColor("#333333"),
    "info_bg": colors.HexColor("#F4F4F4"), "info_bd": colors.black,
    "positivo": colors.black, "negativo": colors.black,
    "latao_escuro": colors.HexColor("#333333"),
}


# ---------------------------------------------------------------------------
# 2. FONTES — TrueType embutida, com degradação previsível
# ---------------------------------------------------------------------------

# DUAS tipografias, registradas as duas no import e escolhidas por documento:
#
#   "office"    (PADRÃO) — Carlito sobre Caladea: são metricamente IDÊNTICAS ao
#               Calibri e ao Cambria que o docpro pede no Word. É o que faz o
#               PDF gerado aqui quebrar a linha no mesmo lugar que o Word do
#               cliente — sem isso, conferir o PDF gêmeo é conferir um
#               documento diferente do que ele abre. Vêm de
#               `fonts-crosextra-carlito`/`-caladea` (sandbox/Dockerfile).
#   "editorial" — Source Sans 3 sobre Source Serif 4, a voz original da
#               identidade "Tinta & Latão". Só faz sentido em PDF, onde a fonte
#               vai EMBUTIDA no arquivo. O Dockerfile as instala em
#               /usr/share/fonts/truetype/tinta-latao; como o download pode
#               falhar (o bloco é tolerante a rede, de propósito), a lista cai
#               para as demais.
#
# DejaVu tem a cobertura de glifos mais ampla e Liberation existe em
# praticamente toda imagem Debian — as duas fecham a lista. A base-14 do PDF é
# o último recurso: não embute nada e limita o texto ao WinAnsi.
#
# O negrito do Source é o SEMIBOLD, não o Bold: no corpo de um relatório o Bold
# do Source pesa demais e "grita" ao lado do verde-tinta.
_TL = "/usr/share/fonts/truetype/tinta-latao/"
_XTRA = "/usr/share/fonts/truetype/crosextra/"
_CARLITO = ("Carlito", _XTRA + "Carlito-{}.ttf",
            {"": "Regular", "-Bold": "Bold", "-Italico": "Italic", "-BoldItalico": "BoldItalic"})
_CALADEA = ("Caladea", _XTRA + "Caladea-{}.ttf",
            {"": "Regular", "-Bold": "Bold", "-Italico": "Italic", "-BoldItalico": "BoldItalic"})
_SOURCE_SANS = ("SourceSans3", _TL + "SourceSans3-{}.ttf",
                {"": "Regular", "-Bold": "Semibold", "-Italico": "It", "-BoldItalico": "SemiboldIt"})
_SOURCE_SERIF = ("SourceSerif4", _TL + "SourceSerif4-{}.ttf",
                 {"": "Regular", "-Bold": "Semibold", "-Italico": "It", "-BoldItalico": "SemiboldIt"})
_LIB_SANS = ("LiberationSans", "/usr/share/fonts/truetype/liberation/LiberationSans-{}.ttf",
             {"": "Regular", "-Bold": "Bold", "-Italico": "Italic", "-BoldItalico": "BoldItalic"})
_LIB_SERIF = ("LiberationSerif", "/usr/share/fonts/truetype/liberation/LiberationSerif-{}.ttf",
              {"": "Regular", "-Bold": "Bold", "-Italico": "Italic", "-BoldItalico": "BoldItalic"})
_DEJAVU_SANS = ("DejaVuSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans{}.ttf",
                {"": "", "-Bold": "-Bold", "-Italico": "-Oblique", "-BoldItalico": "-BoldOblique"})
_DEJAVU_SERIF = ("DejaVuSerif", "/usr/share/fonts/truetype/dejavu/DejaVuSerif{}.ttf",
                 {"": "", "-Bold": "-Bold", "-Italico": "-Italic", "-BoldItalico": "-BoldItalic"})

_FAMILIAS = (_CARLITO, _LIB_SANS, _DEJAVU_SANS)
_SERIFADAS = (_CALADEA, _LIB_SERIF, _DEJAVU_SERIF)
_FAMILIAS_EDITORIAL = (_SOURCE_SANS, _CARLITO, _LIB_SANS, _DEJAVU_SANS)
_SERIFADAS_EDITORIAL = (_SOURCE_SERIF, _CALADEA, _LIB_SERIF, _DEJAVU_SERIF)
_MONO = (
    ("DejaVuSansMono", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono{}.ttf",
     {"": "", "-Bold": "-Bold"}),
    ("LiberationMono", "/usr/share/fonts/truetype/liberation/LiberationMono-{}.ttf",
     {"": "Regular", "-Bold": "Bold"}),
)


def _registra_familia(candidatas, base14):
    """Registra a primeira família TrueType disponível e devolve
    `(normal, negrito, itálico)`.

    Exige só regular + negrito: várias distribuições trazem o pacote "core" da
    família sem as variantes inclinadas (é o caso do fonts-dejavu-core), e
    descartar a família inteira por causa do itálico jogaria fora uma fonte
    perfeitamente utilizável. Sem nenhuma TTF, devolve as Type1 base-14 — o
    documento continua saindo, só sem embutir fonte."""
    for nome, molde, variantes in candidatas:
        caminhos = {suf: molde.format(v) for suf, v in variantes.items()
                    if os.path.exists(molde.format(v))}
        if "" not in caminhos or "-Bold" not in caminhos:
            continue
        try:
            for sufixo, caminho in caminhos.items():
                pdfmetrics.registerFont(TTFont(nome + sufixo, caminho))
        except Exception:
            continue
        normal = nome
        negrito = nome + "-Bold"
        italico = nome + "-Italico" if "-Italico" in caminhos else negrito
        bolditalico = nome + "-BoldItalico" if "-BoldItalico" in caminhos else negrito
        # Sem registerFontFamily o reportlab ignora <b>/<i> dentro de Paragraph
        # em fonte TTF: o trecho em negrito sairia com o peso normal.
        pdfmetrics.registerFontFamily(normal, normal=normal, bold=negrito,
                                      italic=italico, boldItalic=bolditalico)
        return normal, negrito, italico
    return base14


FONTE, FONTE_BOLD, FONTE_ITALICO = _registra_familia(
    _FAMILIAS, ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique"))
FONTE_SERIF, FONTE_SERIF_BOLD, FONTE_SERIF_ITALICO = _registra_familia(
    _SERIFADAS, ("Times-Roman", "Times-Bold", "Times-Italic"))
FONTE_MONO, FONTE_MONO_BOLD, _ = _registra_familia(
    _MONO, ("Courier", "Courier-Bold", "Courier-Oblique"))
_ED_SANS = _registra_familia(_FAMILIAS_EDITORIAL,
                             ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique"))
_ED_SERIF = _registra_familia(_SERIFADAS_EDITORIAL,
                              ("Times-Roman", "Times-Bold", "Times-Italic"))

#: As duas tipografias já registradas: `(sans, sans_bold, sans_it, serif,
#: serif_bold, serif_it)`. `RelatorioPDF(tipografia=...)` escolhe uma.
TIPOGRAFIAS = {
    "office": (FONTE, FONTE_BOLD, FONTE_ITALICO,
               FONTE_SERIF, FONTE_SERIF_BOLD, FONTE_SERIF_ITALICO),
    "editorial": (_ED_SANS[0], _ED_SANS[1], _ED_SANS[2],
                  _ED_SERIF[0], _ED_SERIF[1], _ED_SERIF[2]),
}

#: True quando a fonte do corpo é TrueType embutida — o caso normal. Serve para
#: o saneamento saber se pode confiar na cobertura da fonte e para a auditoria
#: exigir `/FontFile2` + `/ToUnicode`.
FONTE_EMBUTIDA = FONTE not in ("Helvetica", "Times-Roman")


# ---------------------------------------------------------------------------
# 3. SANEAMENTO DE TEXTO — nada sem glifo chega ao reportlab
# ---------------------------------------------------------------------------

# Caracteres de controle (inclui DEL 0x7F e a faixa C1) só produzem lixo no
# PDF. O `\n` vira <br/> no parágrafo; `\t` vira espaço; o resto some.
_CONTROLES = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")

# Equivalentes ASCII para quando a fonte ativa não tiver o glifo. A lista cobre
# o que um relatório técnico/contábil realmente usa; o resto cai na
# decomposição Unicode e, em último caso, é descartado.
_EQUIVALENTES = {
    "•": "-", "●": "-", "▪": "-", "■": "-", "‣": "-",
    "–": "-", "—": "--", "−": "-", "‐": "-", "‑": "-",
    "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"',
    "„": '"', "«": '"', "»": '"', "′": "'", "″": '"',
    "…": "...", "·": "-", "‧": "-",
    "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "⇐": "<=",
    "≥": ">=", "≤": "<=", "≠": "!=", "×": "x", "÷": "/",
    "±": "+/-", "∞": "infinito", "≈": "~", "∑": "soma",
    "✓": "OK", "✔": "OK", "✗": "X", "✘": "X", "✅": "OK",
    "❌": "X", "⚠": "!", "️": "", "​": "", " ": " ",
    " ": " ", " ": " ", " ": " ", "⁠": "",
    "€": "EUR", "£": "GBP", "™": "(TM)", "℗": "(P)",
}


def _cobre(fonte, ch):
    """A fonte ativa desenha este caractere DE FATO?

    Para TTF a resposta vem do cmap real. Para as Type1 base-14 a pergunta é
    feita ao próprio reportlab (`unicode2T1`), porque a resposta intuitiva está
    errada: `"•".encode("cp1252")` funciona, mas o reportlab codifica o bullet
    em Helvetica como `\\x7f` (DEL) — o caractere que não tem desenho e que o
    leitor mostra como quadrado ou como nada. Foi essa a origem dos 320
    marcadores quebrados do relatório que motivou esta reescrita. Símbolos que
    ele não acha na fonte ele redesenha com Symbol/ZapfDingbats, o que também
    conta como não coberto."""
    try:
        objeto = pdfmetrics.getFont(fonte)
    except Exception:
        return False
    mapa = getattr(objeto.face, "charToGlyph", None)
    if mapa is not None:
        return ord(ch) in mapa
    try:
        for fonte_usada, bytes_ in unicode2T1(ch, [objeto]):
            if fonte_usada.fontName != fonte or b"\x7f" in bytes_:
                return False
        return True
    except Exception:
        try:
            ch.encode("cp1252")
            return True
        except Exception:
            return False


def _glifos(texto, fonte=None):
    """Troca por equivalentes o que a fonte não desenha. Sem isto o reportlab
    emite `\\177` (DEL) no lugar do caractere — foi exatamente essa a origem
    dos marcadores de lista que apareciam como quadrado ou como nada."""
    fonte = fonte or FONTE
    saida = []
    for ch in texto:
        if ch in "\n\t" or _cobre(fonte, ch):
            saida.append(ch)
            continue
        alt = _EQUIVALENTES.get(ch)
        if alt is None:
            # Última tentativa: decompor (ex.: "ﬁ" -> "fi", "Å" -> "A").
            alt = "".join(c for c in unicodedata.normalize("NFKD", ch)
                          if not unicodedata.combining(c))
            if alt == ch:
                alt = ""
        saida.append("".join(c if _cobre(fonte, c) else "" for c in alt))
    return "".join(saida)


# Marcação que o reportlab entende dentro de um Paragraph. Tudo que NÃO estiver
# aqui é escapado: um "&" de "Silva & Cia" ou um "<" de "a < b" vindo de dado
# do usuário derrubaria a geração inteira com erro de parse.
_TAGS_OK = re.compile(
    r"</?(?:b|i|u|strong|em|br|sub|super|sup|para|font\b[^>]*|link\b[^>]*|a\b[^>]*)\s*/?>",
    re.IGNORECASE)
_E_COMERCIAL_SOLTO = re.compile(r"&(?!(?:[A-Za-z][A-Za-z0-9]{1,10}|#\d{1,6}|#x[0-9A-Fa-f]{1,5});)")


def _escapa(trecho):
    return _E_COMERCIAL_SOLTO.sub("&amp;", trecho).replace("<", "&lt;").replace(">", "&gt;")


def _marcacao(texto):
    """Escapa o texto preservando as tags permitidas."""
    partes, pos = [], 0
    for m in _TAGS_OK.finditer(texto):
        partes.append(_escapa(texto[pos:m.start()]))
        partes.append(m.group(0))
        pos = m.end()
    partes.append(_escapa(texto[pos:]))
    return "".join(partes)


def texto_seguro(valor, fonte=None):
    """Normaliza -> remove controles -> resolve glifos -> escapa marcação.

    É por onde passa TODO texto do módulo. Exposta porque quem precisar montar
    um Paragraph fora dos blocos daqui deve usá-la também."""
    s = "" if valor is None else str(valor)
    s = unicodedata.normalize("NFC", s)
    s = _CONTROLES.sub("", s).replace("\t", " ")
    s = _glifos(s, fonte)
    s = _marcacao(s)
    return s.replace("\n", "<br/>")


def _plano(valor):
    """Versão sem marcação (para sumário, metadados e medição de largura)."""
    s = "" if valor is None else str(valor)
    s = unicodedata.normalize("NFC", s)
    s = _CONTROLES.sub("", s).replace("\t", " ").replace("\n", " ")
    return _glifos(s)


_LIMPA_NUM = re.compile(r"[R$\s%. ]")


def _num(v):
    """O valor se comporta como número (para alinhar a coluna à direita)?"""
    s = _LIMPA_NUM.sub("", str(v).strip()).replace(",", ".").replace("(", "-").replace(")", "")
    if not s or s in "-+":
        return False
    try:
        float(s)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 4. CANVAS — rodapé paginado alinhado à grade
# ---------------------------------------------------------------------------

class _CanvasNumerado(_canvas.Canvas):
    """Duas passagens para saber o total de páginas, e rodapé desenhado SEMPRE
    nas mesmas coordenadas.

    O número da página sai por `drawRightString`: com `drawString` a borda
    direita anda quando o número passa de uma para duas casas ("Página 9 de 19"
    x "Página 10 de 19"), que é um defeito visível e difícil de explicar."""

    emissor = ""
    titulo_doc = ""
    pal = PALETA
    fonte = FONTE
    fonte_bold = FONTE_BOLD
    confidencial = False
    #: Marcadores do outline: (página, nível, texto, chave). Reiniciada a
    #: cada `salvar()` — é atributo de CLASSE porque o platypus constrói o
    #: canvas por dentro e não dá para passar estado pelo construtor.
    marcadores = []

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._paginas = []

    def showPage(self):
        self._paginas.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._paginas)
        nivel_anterior = -1
        for i, estado in enumerate(self._paginas):
            self.__dict__.update(estado)
            if i > 0:  # a capa (página 1) não leva rodapé
                self._rodape(i + 1, total)
            # Marcadores (outline) da página corrente: registrados AQUI, na
            # reemissão, porque é só agora que a página existe de verdade.
            for pagina, nivel, texto, chave in self.marcadores:
                if pagina == i + 1:
                    self.bookmarkPage(chave)
                    # O reportlab RECUSA pular níveis (de -1 direto para 1): um
                    # documento que começa por um título de 2º nível derrubaria
                    # a geração inteira. O nível entra no máximo um degrau
                    # abaixo do último emitido.
                    nivel_ok = min(max(0, nivel - 1), nivel_anterior + 1)
                    nivel_anterior = nivel_ok
                    self.addOutlineEntry(texto, chave, level=nivel_ok, closed=False)
            super().showPage()
        super().save()

    def _rodape(self, num, total):
        direita = X_CAIXA + LARGURA_CAIXA
        self.setStrokeColor(self.pal["borda"])
        self.setLineWidth(0.5)
        self.line(X_CAIXA, Y_REGUA_RODAPE, direita, Y_REGUA_RODAPE)
        centro = X_CAIXA + LARGURA_CAIXA / 2.0
        # A marca de sigilo vai no CENTRO e é desenhada antes de cortar o
        # emissor: é ela que define quanto espaço sobra à esquerda.
        limite = LARGURA_TEXTO - 3.2 * cm
        if self.confidencial:
            self.setFont(self.fonte_bold, ESCALA["rodape"] - 0.5)
            self.setFillColor(self.pal["latao"])
            marca = "CONFIDENCIAL"
            meia = pdfmetrics.stringWidth(marca, self.fonte_bold, ESCALA["rodape"] - 0.5) / 2.0
            self.drawCentredString(centro, Y_RODAPE, marca)
            limite = min(limite, centro - meia - 0.6 * cm - X_TEXTO)
        self.setFont(self.fonte, ESCALA["rodape"])
        self.setFillColor(self.pal["cinza"])
        esquerda = self.emissor or self.titulo_doc
        if esquerda and limite > 0:
            # Corta pelo espaço REAL disponível (nunca por número de letras):
            # o rodapé não pode encostar na marca do centro nem na numeração.
            texto = _plano(esquerda)
            while texto and pdfmetrics.stringWidth(texto, self.fonte, ESCALA["rodape"]) > limite:
                texto = texto[:-1]
            self.drawString(X_TEXTO, Y_RODAPE, texto)
        self.drawRightString(direita - RECUO, Y_RODAPE, "Página %d de %d" % (num, total))


# ---------------------------------------------------------------------------
# 5. DOCUMENTO — template com sumário
# ---------------------------------------------------------------------------

class _Documento(BaseDocTemplate):
    """Aviso de entrada de sumário e MARCADOR (outline) do PDF. O título é um
    Table (a barra de destaque é uma coluna), então as marcas `_toc` e
    `_marcador` viajam no Table."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._chaves_de_marcador = set()

    def beforeDocument(self):
        # `multiBuild` constrói o documento DUAS vezes (a 2ª já com o sumário
        # paginado). Sem zerar aqui, os marcadores da 1ª passagem — feitos antes
        # de o sumário ocupar suas páginas — sobreviveriam com o número errado.
        self._chaves_de_marcador = set()
        _CanvasNumerado.marcadores = []

    def afterFlowable(self, flowable):
        entrada = getattr(flowable, "_toc", None)
        if entrada:
            nivel, texto = entrada
            self.notify("TOCEntry", (nivel, texto, self.page))
        marcador = getattr(flowable, "_marcador", None)
        if marcador:
            nivel, texto = marcador
            chave = "sec-%d-%s" % (self.page, re.sub(r"\W+", "-", texto)[:40])
            if chave in self._chaves_de_marcador:
                return
            self._chaves_de_marcador.add(chave)
            # O marcador NÃO pode ser registrado aqui: `_CanvasNumerado` guarda
            # cada página e só as emite de novo em `save()` (é assim que ele
            # sabe o total de páginas), então um `bookmarkPage` feito agora
            # apontaria para a página errada — todas caíam na 1. A entrada fica
            # anotada e o canvas a registra na página certa, na reemissão.
            _CanvasNumerado.marcadores.append((self.page, nivel, texto, chave))


# ---------------------------------------------------------------------------
# 6. RELATÓRIO
# ---------------------------------------------------------------------------

class RelatorioPDF:
    """Documento PDF montado só por blocos. Nenhum método aceita coordenada,
    largura em cm ou recuo próprio: a grade do módulo é a única referência."""

    def __init__(self, caminho, titulo="Documento", cliente="", emissor="",
                 subtitulo="", tipo=None, data_str=None, cor_marca=None,
                 estilo=None, assunto="", confidencial=True, preset=None,
                 tipografia="office", capa=None, sumario=None, contracapa=None):
        # `estilo="sobrio"` continua aceito (compatibilidade): vira o preset de
        # mesmo nome.
        if preset is None:
            preset = "sobrio" if str(estilo or "").lower().startswith("sobri") \
                else "gerencial"
        if preset not in PRESETS:
            raise KitError("preset desconhecido: %r (use %s)"
                           % (preset, " | ".join(sorted(PRESETS))))
        self.preset = preset
        self.regras = dict(PRESETS[preset])
        self.caminho = caminho
        self.titulo_doc = titulo
        self.cliente = cliente
        self.emissor = emissor
        self.subtitulo = subtitulo
        self.tipo = tipo if tipo is not None else self.regras["tipo"]
        self.assunto = assunto or subtitulo
        self.data_str = data_str or fmt.data()
        self.sobrio = preset == "sobrio"
        self.estilo = "sobrio" if self.sobrio else "relatorio"
        # Documento sóbrio/registrável não carrega marca de sigilo: ata e
        # contrato vão a registro público.
        self.confidencial = bool(confidencial) and not self.sobrio
        self.pal = dict(PALETA_SOBRIA) if self.sobrio else _paleta_reportlab(cor_marca)
        if tipografia not in TIPOGRAFIAS:
            raise KitError('tipografia deve ser "office" ou "editorial"')
        self.tipografia = tipografia
        sans, sans_bold, _sans_it, serif, serif_bold, _serif_it = TIPOGRAFIAS[tipografia]
        if self.sobrio:
            self.fonte, self.fonte_bold = serif, serif_bold
            self.display, self.display_bold = serif, serif_bold
        else:
            # A voz da identidade: serifada nos títulos e nos números de
            # destaque, sem serifa no corpo e nas tabelas.
            self.fonte, self.fonte_bold = sans, sans_bold
            self.display, self.display_bold = serif, serif_bold
        self.story = []
        self._capa = []       # flowables da capa, prepostos em salvar()
        self._sumario = []    # flowables do sumário, prepostos em salvar()
        self._toc = None
        self._niveis_vistos = set()
        self._secao = 0    # numeração automática de seção
        self._sub = 0
        self._fig = 0
        self._titulos = []
        self._kpis_escritos = []
        self._assinantes = []
        self._textos_de_fechamento = []   # fecho, contatos, nota
        self._contracapa_de_pagina = False
        self._achados_geracao = []
        self._fecho_pendente = None
        self._marca_bloco = 0   # onde começa o último bloco de conteúdo
        self._quer_capa = capa
        self._quer_sumario = sumario
        self._quer_contracapa = contracapa
        self._contracapa_feita = False
        self._construir_estilos()

    # ---------- estilos ----------
    def _construir_estilos(self):
        p = self.pal
        corpo_pt = ESCALA["corpo"] + (1.5 if self.sobrio else 0)

        def base(nome, **kw):
            kw.setdefault("fontName", self.fonte)
            kw.setdefault("fontSize", corpo_pt)
            kw.setdefault("leading", round(kw["fontSize"] * ENTRELINHA, 1))
            kw.setdefault("textColor", p["corpo"])
            return ParagraphStyle(nome, **kw)

        # Corpo: o recuo dos dois lados é o que faz o texto pousar em X_TEXTO
        # e parar em (X_CAIXA + LARGURA_CAIXA - RECUO). Nenhum outro bloco pode
        # inventar recuo diferente.
        self.s_corpo = base("corpo", alignment=TA_JUSTIFY, spaceAfter=7,
                            leftIndent=RECUO, rightIndent=RECUO,
                            firstLineIndent=(1.0 * cm if self.sobrio else 0))
        # Alinhado à esquerda: o preset gerencial/proposta não justifica o corpo
        # (linha justificada curta abre "rios" brancos no meio do parágrafo).
        self.s_corpo_esquerda = base("corpo_esq", alignment=TA_LEFT, spaceAfter=7,
                                     leftIndent=RECUO, rightIndent=RECUO)
        self.s_apoio = base("apoio", fontSize=ESCALA["apoio"], alignment=TA_LEFT,
                            textColor=p["cinza"], leftIndent=RECUO, rightIndent=RECUO)
        self.s_pequeno = base("pequeno", fontSize=ESCALA["pequeno"], alignment=TA_LEFT,
                              textColor=p["cinza"], leftIndent=RECUO, rightIndent=RECUO,
                              spaceAfter=2)
        # Dentro de tabela/callout quem garante o recuo é o padding da célula,
        # então o estilo da célula NÃO recua (senão soma duas vezes).
        self.s_celula = base("celula", alignment=TA_LEFT, spaceAfter=0)
        self.s_celula_dir = base("celula_dir", alignment=TA_RIGHT, spaceAfter=0)
        self.s_celula_cab = base("celula_cab", alignment=TA_LEFT, spaceAfter=0,
                                 fontName=self.fonte_bold, textColor=p["branco"])
        self.s_celula_cab_dir = base("celula_cab_dir", alignment=TA_RIGHT, spaceAfter=0,
                                     fontName=self.fonte_bold, textColor=p["branco"])
        self.s_bloco = base("bloco", alignment=TA_JUSTIFY, spaceAfter=0)
        self.s_bloco_pequeno = base("bloco_pequeno", fontSize=ESCALA["pequeno"],
                                    alignment=TA_LEFT, textColor=p["cinza"], spaceAfter=0)
        self.s_lista = base("lista", alignment=TA_LEFT, spaceAfter=4,
                            leftIndent=RECUO + 14, bulletIndent=RECUO,
                            rightIndent=RECUO, bulletFontName=self.fonte)
        self.s_codigo = base("codigo", fontName=FONTE_MONO, fontSize=ESCALA["codigo"],
                             alignment=TA_LEFT, spaceAfter=0)
        self.s_centro = base("centro", alignment=TA_CENTER, spaceAfter=0)

    def _h(self, nivel):
        chave = {1: "h1", 2: "h2", 3: "h3"}.get(nivel, "h3")
        tam = ESCALA[chave]
        return ParagraphStyle(
            "titulo%d" % nivel, fontName=self.display_bold, fontSize=tam,
            leading=round(tam * 1.25, 1), textColor=self.pal["tinta"],
            spaceBefore=0, spaceAfter=0, alignment=TA_LEFT,
            # keepWithNext impede título órfão no pé da página — o defeito de
            # hierarquia mais comum em documento gerado por modelo.
            keepWithNext=1)

    def _kicker(self):
        """Estilo do rótulo curto em latão acima do título — a assinatura
        visual da identidade. Vive na mesma caixa do título, então respeita a
        grade."""
        return ParagraphStyle("kicker", fontName=self.fonte_bold,
                              fontSize=ESCALA["pequeno"], leading=11,
                              textColor=self.pal["latao"], spaceAfter=2,
                              alignment=TA_LEFT)

    # ---------- primitivas de grade ----------
    def _caixa(self, conteudo, cor_barra=None, fundo=None, pad_v=3, pad_extra_dir=0):
        """Bloco de largura cheia com barra opcional à esquerda.

        A barra é uma COLUNA (largura BARRA), não um `LINEBEFORE`: assim ela
        fica inteira dentro da caixa, e o padding da coluna de conteúdo é
        calculado para o texto cair exatamente em X_TEXTO."""
        if cor_barra is not None:
            larguras = [BARRA, LARGURA_CAIXA - BARRA]
            dados = [["", conteudo]]
            col = 1
            pad_esq = RECUO - BARRA
        else:
            larguras = [LARGURA_CAIXA]
            dados = [[conteudo]]
            col = 0
            pad_esq = RECUO
        t = Table(dados, colWidths=larguras)
        estilo = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (col, 0), (col, -1), pad_esq),
            ("RIGHTPADDING", (col, 0), (col, -1), RECUO + pad_extra_dir),
            ("TOPPADDING", (0, 0), (-1, -1), pad_v),
            ("BOTTOMPADDING", (0, 0), (-1, -1), pad_v),
        ]
        if cor_barra is not None:
            estilo += [
                ("BACKGROUND", (0, 0), (0, -1), cor_barra),
                ("LEFTPADDING", (0, 0), (0, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, -1), 0),
                ("TOPPADDING", (0, 0), (0, -1), 0),
                ("BOTTOMPADDING", (0, 0), (0, -1), 0),
            ]
        if fundo is not None:
            estilo.append(("BACKGROUND", (col, 0), (-1, -1), fundo))
        t.setStyle(TableStyle(estilo))
        return t

    def _regua(self, cor=None, espessura=1.0, largura=None):
        t = Table([[""]], colWidths=[largura or LARGURA_CAIXA], rowHeights=[espessura])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), cor or self.pal["primaria"]),
            ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        return t

    # ---------- blocos ----------
    def capa(self, estilo=None):
        """Capa em página própria, inteiramente DENTRO da grade.

        `estilo="faixa"` (padrão dos presets gerencial/proposta) põe o título
        numa faixa de tinta no terço superior; `"simples"` mantém a capa branca
        com filete, para parecer e laudo.

        Nada de faixa sangrada até a borda do papel: numa impressora com área
        não imprimível diferente, a sangria corta e a capa parece torta. Aqui
        as réguas começam e terminam nas mesmas arestas do resto do documento."""
        estilo = estilo or self.regras["capa"] or "simples"
        p = self.pal
        destino = self._capa
        st_meta = ParagraphStyle("cp_meta", parent=self.s_pequeno)
        if estilo == "faixa":
            destino.extend(self._capa_faixa())
        else:
            destino.extend(self._capa_simples())
        for rotulo, valor in (("Cliente", self.cliente), ("Data", self.data_str),
                              ("Emitido por", self.emissor)):
            if valor:
                destino.append(Paragraph(
                    "<b>%s:</b> %s" % (_plano(rotulo), texto_seguro(valor, self.fonte)),
                    st_meta))
        if self.confidencial:
            st_conf = ParagraphStyle("cp_conf", fontName=self.fonte_bold,
                                     fontSize=ESCALA["pequeno"], leading=11,
                                     textColor=p["latao"], leftIndent=RECUO,
                                     spaceBefore=10)
            destino.append(Paragraph("CONFIDENCIAL", st_conf))
        destino.append(PageBreak())
        return self

    def _estilos_de_capa(self, sobre_tinta=False):
        p = self.pal
        cor_kicker = p["latao_claro"] if sobre_tinta else p["latao"]
        return {
            # O emissor é o rótulo MENOR: no mesmo corpo do tipo do documento,
            # as duas linhas viram um bloco só e nenhuma das duas se lê.
            "emissor": ParagraphStyle(
                "cp_emis", fontName=self.fonte_bold, fontSize=ESCALA["kicker"],
                leading=13, textColor=p["creme"] if sobre_tinta else p["cinza"],
                leftIndent=RECUO, spaceAfter=6),
            "tipo": ParagraphStyle(
                "cp_tipo", fontName=self.fonte_bold, fontSize=ESCALA["capa_tipo"],
                leading=14, textColor=cor_kicker, leftIndent=RECUO),
            "titulo": ParagraphStyle(
                "cp_tit", fontName=self.display_bold, fontSize=ESCALA["capa_titulo"],
                leading=round(ESCALA["capa_titulo"] * 1.18, 1),
                textColor=p["branco"] if sobre_tinta else p["tinta"],
                leftIndent=RECUO, rightIndent=RECUO, spaceBefore=4),
            "sub": ParagraphStyle(
                "cp_sub", fontName=self.display, fontSize=ESCALA["capa_sub"],
                leading=round(ESCALA["capa_sub"] * 1.35, 1),
                textColor=p["creme"] if sobre_tinta else p["cinza"],
                leftIndent=RECUO, rightIndent=RECUO, spaceBefore=6),
        }

    def _capa_faixa(self):
        """Capa com faixa de tinta no terço superior. A capa e o fechamento têm
        o MESMO peso visual de propósito: capa branca com contracapa verde de
        página inteira abre discreto e fecha gritando."""
        st = self._estilos_de_capa(sobre_tinta=True)
        dentro = [Spacer(1, 3.2 * cm)]
        if self.emissor:
            dentro.append(Paragraph(texto_seguro(self.emissor, self.fonte).upper(),
                                    st["emissor"]))
        if self.tipo:
            dentro.append(Paragraph(_plano(self.tipo).upper(), st["tipo"]))
        dentro.append(Paragraph(texto_seguro(self.titulo_doc, self.display), st["titulo"]))
        if self.subtitulo:
            dentro.append(Paragraph(texto_seguro(self.subtitulo, self.display), st["sub"]))
        dentro.append(Spacer(1, 0.8 * cm))
        return [Spacer(1, 1.2 * cm),
                self._caixa(dentro, fundo=self.pal["tinta"], pad_v=0),
                self._regua(self.pal["latao"], 3),
                Spacer(1, 6.2 * cm)]

    def _capa_simples(self):
        st = self._estilos_de_capa()
        saida = []
        if self.emissor:
            saida.append(Paragraph(texto_seguro(self.emissor, self.fonte), st["emissor"]))
        saida.append(Spacer(1, 5.4 * cm))
        saida.append(self._regua(self.pal["tinta"], 3))
        saida.append(Spacer(1, 0.35 * cm))
        if self.tipo:
            saida.append(Paragraph(_plano(self.tipo).upper(), st["tipo"]))
        saida.append(Paragraph(texto_seguro(self.titulo_doc, self.display), st["titulo"]))
        if self.subtitulo:
            saida.append(Paragraph(texto_seguro(self.subtitulo, self.display), st["sub"]))
        saida.append(Spacer(1, 0.35 * cm))
        saida.append(self._regua(self.pal["latao"], 1.2))
        saida.append(Spacer(1, 4.6 * cm))
        return saida

    def sumario(self, titulo="Sumário"):
        """Sumário automático a partir dos `titulo()` do documento. Os números
        de página se acertam sozinhos porque `salvar()` faz multiBuild quando há
        sumário.

        Ele NÃO ganha página própria com até `LIMITE_SUMARIO_SEM_PAGINA`
        entradas: um sumário de três linhas ocupando uma folha inteira é uma
        página desperdiçada no meio de uma proposta de três páginas."""
        destino = self._sumario
        # Sem kicker: "SUMÁRIO" acima de "Sumário" é a mesma palavra duas vezes.
        destino.append(self._bloco_de_titulo(titulo, nivel=1, indexar=False, kicker=""))
        toc = TableOfContents()
        toc.levelStyles = [
            ParagraphStyle("toc1", fontName=self.display_bold, fontSize=ESCALA["corpo"],
                           leading=18, textColor=self.pal["tinta"],
                           leftIndent=RECUO, rightIndent=RECUO, firstLineIndent=-0),
            ParagraphStyle("toc2", fontName=self.fonte, fontSize=ESCALA["apoio"],
                           leading=15, textColor=self.pal["corpo"],
                           leftIndent=RECUO + 14, rightIndent=RECUO),
            ParagraphStyle("toc3", fontName=self.fonte, fontSize=ESCALA["apoio"],
                           leading=14, textColor=self.pal["cinza"],
                           leftIndent=RECUO + 28, rightIndent=RECUO),
        ]
        # Guia de pontos em TODOS os níveis (o padrão do reportlab começa no
        # nível 2): sem ela, o número da seção de 1º nível flutua num vazio e
        # não fecha na mesma coluna dos demais.
        toc.dotsMinLevel = 0
        self._toc = toc
        destino.append(toc)
        return self

    def _rotulo_de_secao(self, nivel):
        """Kicker/numeração conforme o preset: "SEÇÃO 01" no gerencial, "1."/
        "1.1" no parecer, nada na proposta, na carta e no sóbrio."""
        numeracao = self.regras["numeracao"]
        if numeracao == "secao":
            if nivel == 1:
                self._secao += 1
                self._sub = 0
                return "SEÇÃO %02d" % self._secao, None
            return None, None
        if numeracao == "decimal":
            if nivel == 1:
                self._secao += 1
                self._sub = 0
                return None, "%d." % self._secao
            self._sub += 1
            return None, "%d.%d" % (self._secao, self._sub)
        return None, None

    def _bloco_de_titulo(self, texto, nivel=1, indexar=True, kicker=None):
        nivel = 1 if nivel not in (1, 2, 3) else nivel
        automatico, prefixo = self._rotulo_de_secao(nivel) if indexar else (None, None)
        if kicker == "":
            automatico = None
        elif kicker:
            automatico = kicker
        dentro = []
        if automatico:
            dentro.append(Paragraph(_plano(automatico).upper(), self._kicker()))
        rotulado = ("%s %s" % (prefixo, texto)) if prefixo else str(texto)
        dentro.append(Paragraph(texto_seguro(rotulado, self.display), self._h(nivel)))
        cor = None if self.sobrio and nivel > 1 else self.pal["tinta"]
        bloco = self._caixa(dentro if len(dentro) > 1 else dentro[0],
                            cor_barra=cor if nivel == 1 else None,
                            pad_v=2 if nivel == 1 else 1)
        if indexar:
            bloco._toc = (nivel - 1, _plano(rotulado))
            # Marcador (outline) do PDF: é o que dá o painel de navegação no
            # leitor. Sem ele, um relatório de 20 páginas se lê rolando.
            bloco._marcador = (nivel, _plano(rotulado))
            self._niveis_vistos.add(nivel)
            self._titulos.append((nivel, rotulado))
        return bloco

    def titulo(self, texto, nivel=1, indexar=True, kicker=None):
        """Título de seção com marcador (outline) no PDF.

        A numeração é do KIT: no preset gerencial sai "SEÇÃO 01" acima do
        título; no parecer, "1." / "1.1" antes dele. Nunca escreva o número no
        texto. `kicker=""` desliga; `kicker="ANEXO A"` substitui."""
        bloco = self._bloco_de_titulo(texto, nivel, indexar, kicker)
        self._marca_bloco = len(self.story)
        self.story.append(Spacer(1, 14 if nivel == 1 else 9))
        self.story.append(bloco)
        self.story.append(Spacer(1, 6))
        return self

    def paragrafo(self, texto, justificado=None):
        if justificado is None:
            justificado = self.regras["corpo"] == "justificado"
        estilo = self.s_corpo if justificado else self.s_corpo_esquerda
        self.story.append(Paragraph(texto_seguro(texto, self.fonte), estilo))
        return self

    def lista(self, itens, ordenada=False):
        """Lista com marcador REAL e recuo pendurado.

        O marcador sai do glifo que a fonte tem de fato (`•` quando existe,
        `-` quando não) — nunca um caractere sem glifo, que o reportlab
        emitiria como `\\177` e o leitor mostraria como quadrado ou vazio."""
        marcador = "•" if _cobre(self.fonte, "•") else "-"
        for i, item in enumerate(itens, start=1):
            bullet = ("%d." % i) if ordenada else marcador
            self.story.append(Paragraph(texto_seguro(item, self.fonte), self.s_lista,
                                        bulletText=bullet))
        self.story.append(Spacer(1, 4))
        return self

    def tabela(self, cabecalho, linhas, total=False, larguras=None, alinhar=None,
               moeda=None, pct=None, milhar=None, data=None, titulo=None, fonte=None):
        """Tabela de largura cheia — **passe NÚMEROS, não strings formatadas**.

        `moeda=`/`pct=`/`milhar=`/`data=` recebem NOMES de coluna do cabeçalho;
        o kit formata em pt-BR (o mesmo `kits.fmt` do Word e do Excel), alinha o
        numérico à direita e escreve o negativo entre parênteses. `total="soma"`
        CALCULA a linha de total; `total=True` mantém o comportamento antigo (a
        última linha já é o total e só recebe o destaque).

        As colunas são dimensionadas pela LARGURA REAL do texto (não pelo número
        de letras) e o cabeçalho se repete a cada página. `alinhar` = lista
        opcional de "E"/"D"/"C" por coluna; sem ela, uma coluna vai para a
        direita quando a MAIORIA das suas células é numérica (olhar só a
        primeira linha erra sempre que ela é "-" ou vazia)."""
        p = self.pal
        cabecalho = list(cabecalho)
        ncols = max(1, len(cabecalho))
        tipos = tipos_de_coluna(cabecalho, moeda, pct, milhar, data)
        linhas, achados = normaliza_linhas(cabecalho, linhas)
        self._achados_geracao.extend(achados)
        if str(total).lower() == "soma":
            linhas = linhas + [linha_de_total(cabecalho, linhas, tipos)]
            total = True
        # Formata os NÚMEROS antes de virarem texto: é o kit quem decide o
        # separador, o símbolo e o parêntese do negativo.
        if tipos:
            linhas = [[formata_valor(v, tipos.get(j),
                                     parenteses=(e_numero(v) and float(v) < 0))
                       for j, v in enumerate(linha)] for linha in linhas]
            alinhar = alinhar or ["D" if j in tipos and tipos[j] != "data" else "E"
                                  for j in range(ncols)]
        if titulo:
            self._fig_rotulo("Tabela", titulo)

        if alinhar:
            alinhamentos = [str(a or "E").upper()[0] for a in alinhar]
            alinhamentos += ["E"] * (ncols - len(alinhamentos))
        else:
            alinhamentos = []
            for j in range(ncols):
                valores = [l[j] for l in linhas if str(l[j]).strip()]
                numericas = sum(1 for v in valores if _num(v))
                alinhamentos.append("D" if valores and numericas >= max(1, len(valores) * 0.6) else "E")

        estilo_por_al = {"E": self.s_celula, "D": self.s_celula_dir, "C": self.s_centro}
        dados = [[Paragraph(texto_seguro(c, self.fonte), self.s_celula_cab) for c in cabecalho]]
        for linha in linhas:
            dados.append([Paragraph(texto_seguro(v, self.fonte), estilo_por_al[alinhamentos[j]])
                          for j, v in enumerate(linha)])

        if not larguras:
            larguras = self._larguras(cabecalho, linhas)

        t = Table(dados, colWidths=larguras, repeatRows=1, hAlign="LEFT")
        n = len(linhas)
        cor_cab = p["tinta"]
        estilo = [
            ("BACKGROUND", (0, 0), (-1, 0), cor_cab),
            ("LINEBELOW", (0, 0), (-1, 0), 1.0, cor_cab),
            ("LINEBELOW", (0, 1), (-1, -1), 0.4, p["borda"]),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            # Interior com respiro menor; as bordas EXTERNAS da tabela usam o
            # RECUO da grade, então a 1ª coluna pousa em X_TEXTO.
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (0, -1), RECUO),
            ("RIGHTPADDING", (-1, 0), (-1, -1), RECUO),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
        if n >= 6:
            for i in range(n):
                if i % 2 == 1 and not (total and i == n - 1):
                    estilo.append(("BACKGROUND", (0, i + 1), (-1, i + 1), p["suave"]))
        if total and n:
            estilo += [
                ("BACKGROUND", (0, n), (-1, n), p["suave"]),
                # Filete de latão: é o acento da identidade e o que separa o
                # TOTAL do corpo da tabela sem repetir a cor do cabeçalho.
                ("LINEABOVE", (0, n), (-1, n), 1.2, p["latao"]),
                ("FONTNAME", (0, n), (-1, n), self.fonte_bold),
            ]
        # Cabeçalho da coluna numérica alinhado com os números que ele encima.
        for j, al in enumerate(alinhamentos):
            if al == "D":
                dados[0][j] = Paragraph(texto_seguro(cabecalho[j], self.fonte),
                                        self.s_celula_cab_dir)
        t.setStyle(TableStyle(estilo))
        bloco = [t]
        if fonte:
            bloco.append(Spacer(1, 3))
            bloco.append(Paragraph(texto_seguro(fonte, self.fonte), self.s_pequeno))
        # Tabela curta é INDIVISÍVEL: cabeçalho repetido numa página com a linha
        # TOTAL órfã na seguinte é o defeito de paginação mais visível de todos.
        if n <= LIMITE_TABELA_INDIVISIVEL:
            self.story.append(KeepTogether(bloco))
        else:
            self.story.extend(bloco)
        self.story.append(Spacer(1, 0.35 * cm))
        return self

    def _fig_rotulo(self, prefixo, texto):
        """Rótulo "Tabela N — ..." / "Gráfico N — ...", preso ao bloco seguinte."""
        self._fig += 1
        st = ParagraphStyle("rot_%s" % prefixo, fontName=self.display_bold,
                            fontSize=ESCALA["pequeno"], leading=12,
                            textColor=self.pal["tinta"], leftIndent=RECUO,
                            spaceAfter=4, keepWithNext=1)
        self.story.append(Paragraph("%s %d — %s" % (prefixo, self._fig, _plano(texto)), st))
        return self

    def _recheios(self, ncols):
        """Soma do padding horizontal de cada coluna, na ordem.

        Não é detalhe: a largura que a coluna precisa é a do TEXTO mais o seu
        recuo, e o recuo das colunas das pontas é maior (é ele que põe o texto
        em X_TEXTO). Distribuir sem descontar isso deixa o cabeçalho quebrando
        no meio da palavra ("Format/o") mesmo com espaço sobrando na página."""
        if ncols == 1:
            return [2 * RECUO]
        recheios = [6 + 6] * ncols
        recheios[0] = RECUO + 6
        recheios[-1] = 6 + RECUO
        return recheios

    def _larguras(self, cabecalho, linhas):
        """Larguras pela largura tipográfica real de cada célula.

        Contar letras (o método antigo) trata "Wi" e "il" como iguais; medir com
        `stringWidth` respeita a fonte de fato e evita tanto a coluna espremida
        quanto a tabela que estoura a margem."""
        ncols = len(cabecalho)
        recheios = self._recheios(ncols)
        disponivel = LARGURA_CAIXA - sum(recheios)
        piso = 1.2 * cm          # largura mínima do TEXTO, sem o recuo
        teto = 9.0 * cm
        pesos = []
        for j in range(ncols):
            largura = pdfmetrics.stringWidth(_plano(cabecalho[j]), self.fonte_bold,
                                             ESCALA["corpo"])
            for linha in linhas:
                largura = max(largura, pdfmetrics.stringWidth(
                    _plano(linha[j]), self.fonte, ESCALA["corpo"]))
            pesos.append(min(teto, max(piso, largura)))
        if sum(pesos) <= disponivel:
            # Cabe tudo: dá a cada coluna a largura natural e reparte a sobra,
            # para a tabela ocupar a linha inteira sem espremer ninguém.
            sobra = (disponivel - sum(pesos)) / ncols
            textos = [w + sobra for w in pesos]
        else:
            fator = disponivel / sum(pesos)
            textos = [max(piso, w * fator) for w in pesos]
            textos = [w * disponivel / sum(textos) for w in textos]
        larguras = [t + r for t, r in zip(textos, recheios)]
        # A soma tem de fechar EXATAMENTE a largura útil: o resíduo de ponto
        # flutuante é o que faz a última coluna passar da margem direita.
        larguras[-1] += LARGURA_CAIXA - sum(larguras)
        return larguras

    def callout(self, rotulo, texto, tipo="info"):
        p = self.pal
        fundos = {"info": p["info_bg"], "alerta": p["alerta_bg"],
                  "critico": p["critico_bg"], "sucesso": p["sucesso_bg"]}
        bordas = {"info": p["info_bd"], "alerta": p["alerta_bd"],
                  "critico": p["critico_bd"], "sucesso": p["sucesso_bd"]}
        if tipo not in fundos:
            raise KitError('callout: tipo deve ser info | alerta | critico | '
                           'sucesso (recebi %r)' % (tipo,))
        st_rotulo = ParagraphStyle("cal_rot", fontName=self.fonte_bold,
                                   fontSize=ESCALA["pequeno"], leading=11,
                                   textColor=bordas[tipo], spaceAfter=3)
        dentro = []
        if rotulo:
            dentro.append(Paragraph(_plano(rotulo).upper(), st_rotulo))
        dentro.append(Paragraph(texto_seguro(texto, self.fonte), self.s_bloco))
        self.story.append(self._caixa(dentro, cor_barra=bordas[tipo],
                                      fundo=fundos[tipo], pad_v=8))
        self.story.append(Spacer(1, 0.35 * cm))
        return self

    def kpis(self, itens):
        """Cartões de indicador — de 2 a 6.

        Cada item é `(valor, rótulo)` ou `(valor, rótulo, tipo)` com tipo
        `moeda | pct | milhar | num | texto`. O valor pode ser NÚMERO (o kit
        formata) ou texto já pronto; o tamanho do número é ADAPTATIVO, para o
        valor comprido reduzir de corpo em vez de quebrar em duas linhas.

        Uma única tabela de duas linhas por fileira, não um cartão-tabela por
        indicador: assim todos os cartões têm exatamente a mesma altura. Com
        tabelas aninhadas, um valor mais curto encolhia aquele cartão e a
        fileira ficava dente de serra. O vão entre eles é uma linha branca."""
        itens = list(itens)
        if not itens:
            return self
        if len(itens) > 6:
            raise KitError("kpis: use de 2 a 6 indicadores (recebi %d)" % len(itens))
        for fileira in linhas_de_kpi(itens):
            self._fileira_de_kpis(fileira)
        return self

    def _fileira_de_kpis(self, fileira):
        p = self.pal
        textos = []
        for item in fileira:
            item = list(item)
            tipo = item[2] if len(item) > 2 else None
            tipo = None if tipo in (None, "texto", "num") else tipo
            textos.append((formata_valor(item[0], tipo), item[1]))
        # Um só tamanho para a fileira inteira: cartões vizinhos com corpos
        # diferentes leem como erro, não como hierarquia.
        tamanho = min(escala_kpi(v) for v, _ in textos)
        st_valor = ParagraphStyle("kpi_v%d" % tamanho, fontName=self.display_bold,
                                  fontSize=tamanho, leading=round(tamanho * 1.15, 1),
                                  textColor=p["tinta"], alignment=TA_CENTER)
        st_rot = ParagraphStyle("kpi_r", fontName=self.fonte, fontSize=ESCALA["kpi_rotulo"],
                                leading=11, textColor=p["cinza"], alignment=TA_CENTER)
        n = len(textos)
        largura = LARGURA_CAIXA / n
        # Valor vazio (ou reduzido a nada pelo saneamento) vira travessão: um
        # cartão sem número nenhum lê como falha de geração.
        valores = []
        for v, _ in textos:
            self._kpis_escritos.append(v)
            valores.append(Paragraph(texto_seguro(v, self.fonte) or "—", st_valor))
        rotulos = [Paragraph(_plano(r).upper(), st_rot) for _, r in textos]
        t = Table([valores, rotulos], colWidths=[largura] * n, hAlign="LEFT")
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), p["suave"]),
            ("LINEABOVE", (0, 0), (-1, 0), 2, p["latao"]),
            ("LINEAFTER", (0, 0), (-2, -1), 6, p["branco"]),
            ("TOPPADDING", (0, 0), (-1, 0), 10), ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
            ("TOPPADDING", (0, 1), (-1, 1), 0), ("BOTTOMPADDING", (0, 1), (-1, 1), 10),
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        self.story.append(KeepTogether(t))
        self.story.append(Spacer(1, 0.35 * cm))
        return self

    def chave_valor(self, pares):
        """Ficha "Campo | Valor" sem cabeçalho colorido — para dado cadastral."""
        dados = [[Paragraph("<b>%s</b>" % texto_seguro(k, self.fonte), self.s_celula),
                  Paragraph(texto_seguro(v, self.fonte), self.s_celula)] for k, v in pares]
        if not dados:
            return self
        rotulo = min(6.0 * cm, max(
            [pdfmetrics.stringWidth(_plano(k), self.fonte_bold, ESCALA["corpo"])
             for k, _ in pares] + [3.0 * cm]) + RECUO + 12)
        t = Table(dados, colWidths=[rotulo, LARGURA_CAIXA - rotulo], hAlign="LEFT")
        t.setStyle(TableStyle([
            ("LINEBELOW", (0, 0), (-1, -1), 0.4, self.pal["borda"]),
            ("LEFTPADDING", (0, 0), (0, -1), RECUO), ("LEFTPADDING", (1, 0), (1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (-1, 0), (-1, -1), RECUO),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        self.story.append(t)
        self.story.append(Spacer(1, 0.35 * cm))
        return self

    def citacao(self, texto, fonte="", autor=""):
        """Frase-chave destacada. `autor=` é aceito como alias de `fonte=`
        (compatibilidade): os três kits usam `fonte=`."""
        autor = fonte or autor
        st = ParagraphStyle("cit", parent=self.s_bloco, fontName=self.display,
                            fontSize=ESCALA["h3"] + 1,
                            leading=round((ESCALA["h3"] + 1) * 1.35, 1),
                            textColor=self.pal["tinta"], alignment=TA_LEFT)
        dentro = [Paragraph("<i>%s</i>" % texto_seguro(texto, self.display), st)]
        if autor:
            dentro.append(Paragraph(_plano(autor).upper(), self.s_bloco_pequeno))
        self.story.append(self._caixa(dentro, cor_barra=self.pal["latao"], pad_v=6))
        self.story.append(Spacer(1, 0.3 * cm))
        return self

    def codigo(self, texto):
        """Bloco monoespaçado. Não justifica, não quebra palavra e mantém os
        espaços — o único lugar do documento em que a fonte muda de família."""
        # `_plano` troca "\n" por espaço (ele existe para medir e para metadado),
        # então a quebra de linha tem de ser feita ANTES — senão o bloco inteiro
        # colapsa numa linha só.
        linhas = str(texto).replace("\t", "    ").split("\n")
        conteudo = []
        for linha in linhas:
            limpa = _plano(linha)
            recuo = len(limpa) - len(limpa.lstrip(" "))
            # Só o recuo vira espaço inquebrável: preservá-lo é o que mantém o
            # código legível. Se TODOS os espaços fossem inquebráveis, uma linha
            # comprida não quebraria e vazaria para fora da caixa.
            corpo = "&nbsp;" * recuo + _marcacao(limpa.lstrip(" "))
            conteudo.append(Paragraph(corpo or "&nbsp;", self.s_codigo))
        self.story.append(self._caixa(conteudo, cor_barra=self.pal["borda"],
                                      fundo=self.pal["suave"], pad_v=8))
        self.story.append(Spacer(1, 0.3 * cm))
        return self

    def imagem(self, caminho, largura_cm=None, legenda=""):
        """Imagem sempre contida na largura útil e na altura restante da página
        (uma figura maior que a página trava o platypus num laço infinito)."""
        if not os.path.exists(caminho):
            raise ValueError("imagem: arquivo não encontrado: %s" % caminho)
        larg_nat, alt_nat = ImageReader(caminho).getSize()
        alvo = min(LARGURA_TEXTO, (largura_cm * cm) if largura_cm else LARGURA_TEXTO)
        altura = alvo * alt_nat / float(larg_nat or 1)
        teto = PAGINA[1] - MARGEM["sup"] - MARGEM["inf"] - 3 * cm
        if altura > teto:
            alvo *= teto / altura
            altura = teto
        img = Image(caminho, width=alvo, height=altura)
        img.hAlign = "LEFT"
        bloco = [img]
        if legenda:
            bloco.append(Spacer(1, 4))
            bloco.append(Paragraph(texto_seguro(legenda, self.fonte), self.s_bloco_pequeno))
        self.story.append(KeepTogether(self._caixa(bloco, pad_v=0)))
        self.story.append(Spacer(1, 0.35 * cm))
        return self

    def assinaturas(self, nomes, cargos=None, subtitulos=None, testemunhas=None):
        """Linhas de assinatura em pares, dentro da grade.

        O fecho, as assinaturas e as testemunhas viajam num ÚNICO
        `KeepTogether`: nunca sobra uma página com apenas a linha de assinatura
        — que foi exatamente o defeito da proposta na revisão da v1.
        `subtitulos=` é aceito como alias de `cargos=` (compatibilidade)."""
        nomes = list(nomes)
        cargos = list(cargos or subtitulos or []) + [""] * len(nomes)
        # O bloco de fecho COLA NO CONTEÚDO ANTERIOR: sem isso ele desce
        # sozinho para a página seguinte e sobra uma folha com uma linha de
        # assinatura — o defeito da proposta na revisão da v1.
        bloco = self._puxar_bloco_anterior()
        if self._fecho_pendente:
            bloco.append(Paragraph(texto_seguro(self._fecho_pendente, self.fonte),
                                   self.s_apoio))
            self._textos_de_fechamento.append(self._fecho_pendente)
            self._fecho_pendente = None
        bloco.append(Spacer(1, 0.9 * cm))
        self._assinantes += [(n, cargos[i]) for i, n in enumerate(nomes)]
        bloco.extend(self._pares_de_assinatura(nomes, cargos))
        if testemunhas:
            testemunhas = list(testemunhas)
            st_rot = ParagraphStyle("as_test", fontName=self.fonte_bold,
                                    fontSize=ESCALA["pequeno"], leading=12,
                                    textColor=self.pal["cinza"], leftIndent=RECUO)
            bloco.append(Spacer(1, 0.4 * cm))
            bloco.append(Paragraph("TESTEMUNHAS", st_rot))
            self._assinantes += [(n, "") for n in testemunhas]
            bloco.extend(self._pares_de_assinatura(testemunhas, [""] * len(testemunhas)))
        self.story.append(KeepTogether(bloco))
        return self

    #: Fração da altura útil que o conteúdo puxado para o bloco de assinaturas
    #: pode ocupar. Acima disso o `KeepTogether` fica maior que a página, o
    #: reportlab o parte assim mesmo e a assinatura volta a ficar sozinha —
    #: exatamente o que se queria evitar.
    _TETO_DO_BLOCO_ANTERIOR = 0.35

    def _puxar_bloco_anterior(self):
        """Tira da story o último bloco de conteúdo, para ele viajar junto com
        o fecho e as assinaturas.

        Puxa de trás para a frente enquanto couber no teto acima e sem passar
        do último `titulo()`: arrastar uma tabela de trinta linhas junto com a
        assinatura estouraria a página e não resolveria nada."""
        altura_util = PAGINA[1] - MARGEM["sup"] - MARGEM["inf"]
        teto = altura_util * self._TETO_DO_BLOCO_ANTERIOR
        somado = 0.0
        inicio = len(self.story)
        while inicio > self._marca_bloco:
            candidato = self.story[inicio - 1]
            try:
                _largura, altura = candidato.wrap(LARGURA_CAIXA, altura_util)
            except Exception:                                  # pragma: no cover
                break
            if somado + altura > teto:
                break
            somado += altura
            inicio -= 1
        anterior = self.story[inicio:]
        del self.story[inicio:]
        return list(anterior)

    def _pares_de_assinatura(self, nomes, cargos):
        st_nome = ParagraphStyle("as_nome", fontName=self.fonte_bold, fontSize=ESCALA["apoio"],
                                 leading=13, alignment=TA_CENTER, textColor=self.pal["corpo"])
        st_sub = ParagraphStyle("as_sub", fontName=self.fonte, fontSize=ESCALA["pequeno"],
                                leading=11, alignment=TA_CENTER, textColor=self.pal["cinza"])
        saida = []
        for i in range(0, len(nomes), 2):
            par = nomes[i:i + 2]
            largura = LARGURA_CAIXA / 2
            celulas = []
            for j, nome in enumerate(par):
                interno = [self._regua(self.pal["cinza"], 0.6, largura - 2 * cm),
                           Spacer(1, 4),
                           Paragraph(texto_seguro(nome, self.fonte), st_nome)]
                sub = cargos[i + j] if i + j < len(cargos) else ""
                if sub:
                    interno.append(Paragraph(
                        texto_seguro(liga_identificadores(sub), self.fonte), st_sub))
                celulas.append(interno)
            # Assinatura SOLITÁRIA vai ao centro: encostada à esquerda, num par
            # que não existe, ela lê como se faltasse o segundo signatário.
            sozinho = len(celulas) == 1
            if sozinho:
                celulas = [[Spacer(1, 1)], celulas[0], [Spacer(1, 1)]]
                colunas = [LARGURA_CAIXA / 4, LARGURA_CAIXA / 2, LARGURA_CAIXA / 4]
            else:
                colunas = [largura, largura]
            t = Table([celulas], colWidths=colunas, hAlign="LEFT")
            t.setStyle(TableStyle([
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), cm), ("RIGHTPADDING", (0, 0), (-1, -1), cm),
                ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]))
            saida.append(t)
            saida.append(Spacer(1, 0.6 * cm))
        return saida

    def testemunhas(self, nomes, cargos=None):
        """Bloco "TESTEMUNHAS" separado, quando as assinaturas já saíram."""
        return self.assinaturas([], testemunhas=nomes)

    def etapas(self, itens, titulo=None):
        """Linha do tempo vertical — `[(etapa, quando/descrição), ...]`.

        Uma tabela de duas colunas: o número em latão na coluna estreita e o
        texto na larga. A coluna do número usa o RECUO da grade, então o "01"
        pousa em X_TEXTO como qualquer outro texto da página."""
        itens = list(itens)
        if not itens:
            return self
        if titulo:
            self.titulo(titulo, nivel=2)
        p = self.pal
        st_num = ParagraphStyle("et_num", fontName=self.display_bold,
                                fontSize=ESCALA["h3"] + 2, leading=16,
                                textColor=p["latao"], alignment=TA_LEFT)
        st_tit = ParagraphStyle("et_tit", fontName=self.fonte_bold,
                                fontSize=ESCALA["corpo"], leading=14,
                                textColor=p["corpo"], alignment=TA_LEFT)
        st_desc = ParagraphStyle("et_desc", fontName=self.fonte,
                                 fontSize=ESCALA["apoio"], leading=13,
                                 textColor=p["cinza"], alignment=TA_LEFT)
        col_num = 1.3 * cm
        dados, estilo = [], [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (0, -1), RECUO),
            ("LEFTPADDING", (1, 0), (1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), RECUO),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]
        for i, item in enumerate(itens):
            etapa, quando = (list(item) + [""])[:2]
            bloco = [Paragraph(texto_seguro(etapa, self.fonte), st_tit)]
            if quando:
                bloco.append(Paragraph(texto_seguro(quando, self.fonte), st_desc))
            dados.append([Paragraph("%02d" % (i + 1), st_num), bloco])
            if i < len(itens) - 1:
                estilo.append(("LINEBELOW", (0, i), (-1, i), 0.5, p["borda_leve"]))
        t = Table(dados, colWidths=[col_num, LARGURA_CAIXA - col_num], hAlign="LEFT")
        t.setStyle(TableStyle(estilo))
        self.story.append(t)
        self.story.append(Spacer(1, 0.35 * cm))
        return self

    def fecho(self, local_data):
        """Local e data. Guardado para entrar no MESMO bloco indivisível das
        assinaturas — o fecho numa página e a assinatura na seguinte é o defeito
        que mais desmoraliza um documento pronto."""
        self._fecho_pendente = str(local_data)
        return self

    def contracapa(self, contatos=None, nota=None, estilo=None):
        """Fechamento: FAIXA de tinta no fim da última página (padrão) ou página
        inteira (`estilo="pagina"`).

        A página inteira só se justifica num documento longo: numa proposta de
        três páginas ela vira uma quarta página verde e vazia, e o documento
        fecha gritando o que a capa abriu discreto. Chame só quando houver
        contato REAL; sem contato ela não tem função."""
        estilo = estilo or self._quer_contracapa or "faixa"
        self._contracapa_feita = True
        if estilo != "pagina":
            return self._faixa_de_fechamento(contatos, nota)
        self._contracapa_de_pagina = True
        p = self.pal
        st_nome = ParagraphStyle("cc_nome", fontName=self.display_bold, fontSize=20,
                                 leading=26, textColor=p["suave"], alignment=TA_CENTER)
        st_rot = ParagraphStyle("cc_rot", fontName=self.fonte_bold,
                                fontSize=ESCALA["pequeno"], leading=12,
                                textColor=p["latao_claro"], alignment=TA_CENTER)
        st_con = ParagraphStyle("cc_con", fontName=self.fonte, fontSize=ESCALA["corpo"],
                                leading=16, textColor=p["creme"], alignment=TA_CENTER)
        st_nota = ParagraphStyle("cc_nota", fontName=self.fonte,
                                 fontSize=ESCALA["pequeno"], leading=12,
                                 textColor=p["creme"], alignment=TA_CENTER)
        dentro = [Spacer(1, 6.4 * cm),
                  Paragraph(texto_seguro(self.emissor or self.titulo_doc, self.display), st_nome),
                  Spacer(1, 0.5 * cm)]
        if contatos:
            dentro.append(Paragraph("CONTATO", st_rot))
            dentro.append(Spacer(1, 0.25 * cm))
            for linha in contatos:
                dentro.append(Paragraph(texto_seguro(linha, self.fonte), st_con))
        if nota is None and self.confidencial:
            nota = ("Este documento é confidencial e destina-se exclusivamente "
                    "ao cliente identificado na capa.")
        if nota:
            dentro.append(Spacer(1, 2.2 * cm))
            dentro.append(Paragraph(texto_seguro(nota, self.fonte), st_nota))
        # Fecha perto do rodapé sem alcançá-lo: a mancha tem de caber na página
        # (um centímetro a mais cria uma 7ª página em branco de tinta).
        dentro.append(Spacer(1, 8.6 * cm))
        self.story.append(PageBreak())
        self.story.append(self._regua(p["latao"], 3))
        self.story.append(self._caixa(dentro, fundo=p["tinta"], pad_v=0))
        return self

    def _faixa_de_fechamento(self, contatos=None, nota=None):
        """Faixa de tinta de ~4 cm fechando a última página, no mesmo peso
        visual da capa em faixa."""
        p = self.pal
        st_nome = ParagraphStyle("fx_nome", fontName=self.display_bold,
                                 fontSize=ESCALA["h2"], leading=18,
                                 textColor=p["suave"], alignment=TA_CENTER)
        st_rot = ParagraphStyle("fx_rot", fontName=self.fonte_bold,
                                fontSize=ESCALA["legenda"], leading=11,
                                textColor=p["latao_claro"], alignment=TA_CENTER)
        st_con = ParagraphStyle("fx_con", fontName=self.fonte, fontSize=ESCALA["apoio"],
                                leading=13, textColor=p["creme"], alignment=TA_CENTER)
        self._textos_de_fechamento += [self.emissor or self.titulo_doc, nota or ""]
        self._textos_de_fechamento += list(contatos or [])
        dentro = [Spacer(1, 0.35 * cm),
                  Paragraph(texto_seguro(self.emissor or self.titulo_doc, self.display),
                            st_nome)]
        if contatos:
            dentro.append(Spacer(1, 0.2 * cm))
            dentro.append(Paragraph("CONTATO", st_rot))
            for linha in contatos:
                dentro.append(Paragraph(texto_seguro(linha, self.fonte), st_con))
        if nota:
            dentro.append(Spacer(1, 0.3 * cm))
            dentro.append(Paragraph(texto_seguro(nota, self.fonte), st_con))
        dentro.append(Spacer(1, 0.35 * cm))
        self.story.append(Spacer(1, 0.5 * cm))
        self.story.append(KeepTogether([self._regua(p["latao"], 3),
                                        self._caixa(dentro, fundo=p["tinta"], pad_v=0)]))
        return self

    # ---------- gráficos vetoriais nativos ----------
    def _drawing(self, altura_cm):
        from reportlab.graphics.shapes import Drawing
        # A largura é a da CAIXA menos o recuo dos dois lados: o desenho entra
        # dentro de _caixa(), e é a caixa que o põe na grade. Sem descontar, o
        # eixo Y do gráfico começaria à esquerda de X_TEXTO e a auditoria
        # acusaria texto fora da área útil.
        return Drawing(LARGURA_TEXTO, altura_cm * cm)

    def _fecha_grafico(self, d, titulo):
        bloco = [d]
        if titulo:
            self._fig += 1
            st = ParagraphStyle("gr_rot", fontName=self.display_bold,
                                fontSize=ESCALA["pequeno"], leading=12,
                                textColor=self.pal["tinta"], spaceAfter=4)
            bloco.insert(0, Paragraph("Gráfico %d — %s" % (self._fig, _plano(titulo)), st))
        self.story.append(KeepTogether(self._caixa(bloco, pad_v=4)))
        self.story.append(Spacer(1, 0.35 * cm))
        return d

    def _eixos(self, ch, categorias):
        p = self.pal
        ch.categoryAxis.categoryNames = [_plano(c) for c in categorias]
        ch.categoryAxis.labels.fontName = self.fonte
        ch.categoryAxis.labels.fontSize = ESCALA["pequeno"]
        ch.categoryAxis.labels.fillColor = p["cinza"]
        ch.categoryAxis.strokeColor = p["borda"]
        ch.valueAxis.labels.fontName = self.fonte
        ch.valueAxis.labels.fontSize = ESCALA["pequeno"]
        ch.valueAxis.labels.fillColor = p["cinza"]
        ch.valueAxis.strokeColor = colors.transparent
        ch.valueAxis.visibleGrid = True
        ch.valueAxis.gridStrokeColor = p["borda"]
        ch.valueAxis.gridStrokeWidth = 0.5

    def _legenda(self, d, nomes, x, y, colunas=1):
        from reportlab.graphics.charts.legends import Legend
        nomes = [n for n in nomes if n]
        if not nomes:
            return
        lg = Legend()
        lg.x, lg.y = x, y
        lg.fontName = self.fonte
        lg.fontSize = ESCALA["pequeno"]
        lg.fillColor = self.pal["corpo"]
        lg.alignment = "right"
        lg.columnMaximum = colunas
        lg.deltay = 13
        lg.dxTextSpace = 6
        lg.colorNamePairs = [(CORES_GRAF[i % len(CORES_GRAF)], _plano(n))
                             for i, n in enumerate(nomes)]
        d.add(lg)

    def grafico_barras(self, categorias, series, titulo="", altura_cm=6.5):
        """`series` = {"Nome": [valores]} ou uma lista simples de valores."""
        from reportlab.graphics.charts.barcharts import VerticalBarChart
        if not isinstance(series, dict):
            series = {"": list(series)}
        d = self._drawing(altura_cm)
        ch = VerticalBarChart()
        ch.x, ch.y = 34, 26
        ch.width, ch.height = d.width - 44, altura_cm * cm - 46
        ch.data = [list(v) for v in series.values()]
        self._eixos(ch, categorias)
        # Barra SEMPRE parte do zero: com a base automática do reportlab, uma
        # série de 4,1 a 5,8 vira quatro barras quase idênticas e a série menor
        # some — o gráfico passa a mentir sobre a proporção.
        ch.valueAxis.valueMin = min(0, min(min(v) for v in ch.data if v) if ch.data else 0)
        ch.bars.strokeColor = colors.transparent
        for i in range(len(series)):
            ch.bars[i].fillColor = CORES_GRAF[i % len(CORES_GRAF)]
        ch.groupSpacing = 12
        ch.barSpacing = 2
        d.add(ch)
        self._legenda(d, list(series.keys()), 34, altura_cm * cm - 10,
                      colunas=max(1, len(series)))
        return self._fecha_grafico(d, titulo)

    def grafico_linhas(self, categorias, series, titulo="", altura_cm=6.5):
        from reportlab.graphics.charts.linecharts import HorizontalLineChart
        if not isinstance(series, dict):
            series = {"": list(series)}
        d = self._drawing(altura_cm)
        ch = HorizontalLineChart()
        ch.x, ch.y = 34, 26
        ch.width, ch.height = d.width - 44, altura_cm * cm - 46
        ch.data = [list(v) for v in series.values()]
        self._eixos(ch, categorias)
        for i in range(len(series)):
            ch.lines[i].strokeColor = CORES_GRAF[i % len(CORES_GRAF)]
            ch.lines[i].strokeWidth = 2.2
        d.add(ch)
        self._legenda(d, list(series.keys()), 34, altura_cm * cm - 10,
                      colunas=max(1, len(series)))
        return self._fecha_grafico(d, titulo)

    def grafico_pizza(self, rotulos, valores, titulo="", altura_cm=6.5):
        """Rosca à esquerda, participação na legenda à direita.

        Rótulo colado na fatia não cabe: o texto escuro cai dentro da fatia
        escura e o rótulo da esquerda sai da caixa (a auditoria reprovaria).
        A leitura de um gráfico de participação é o PERCENTUAL — ele vai na
        legenda, com vírgula decimal."""
        from reportlab.graphics.charts.piecharts import Pie
        valores = [float(v) for v in valores]
        soma = sum(valores) or 1.0
        d = self._drawing(altura_cm)
        lado = min(altura_cm * cm - 24, d.width * 0.44)
        ch = Pie()
        ch.x = 8
        ch.y = (altura_cm * cm - lado) / 2
        ch.width = ch.height = lado
        ch.data = valores
        ch.labels = None
        ch.slices.strokeColor = colors.white
        ch.slices.strokeWidth = 1.2
        for i in range(len(valores)):
            ch.slices[i].fillColor = CORES_GRAF[i % len(CORES_GRAF)]
        d.add(ch)
        nomes = ["%s — %s%%" % (_plano(r), ("%.1f" % (100.0 * v / soma)).replace(".", ","))
                 for r, v in zip(rotulos, valores)]
        self._legenda(d, nomes, lado + 28,
                      altura_cm * cm / 2 + (len(valores) - 1) * 6.5,
                      colunas=max(1, len(valores)))
        return self._fecha_grafico(d, titulo)

    def divisor(self):
        self.story.append(Spacer(1, 0.35 * cm))
        self.story.append(self._regua(self.pal["borda"], 0.6))
        self.story.append(Spacer(1, 0.35 * cm))
        return self

    def espaco(self, cm_=0.4):
        self.story.append(Spacer(1, cm_ * cm))
        return self

    def quebra(self):
        self.story.append(PageBreak())
        return self

    # ---------- saída ----------
    def _finalizar_estrutura(self):
        """Aplica o preset: capa, sumário e fechamento que o modelo não pediu
        explicitamente. Capa e sumário são montados AGORA — quando já se sabe
        quantas seções o documento tem — e entram na FRENTE da story."""
        secoes = sum(1 for nivel, _ in self._titulos if nivel == 1)
        quer_capa = self._quer_capa
        if quer_capa is None:
            quer_capa = self.regras["capa"] is not None
        if quer_capa and not self._capa:
            self.capa(estilo=None if quer_capa is True else quer_capa)

        quer_sumario = self._quer_sumario
        if quer_sumario is None:
            quer_sumario = (self.regras["sumario"] == "auto"
                            and secoes >= MINIMO_SECOES_PARA_SUMARIO)
        if quer_sumario and not self._sumario:
            self.sumario()
        if self._sumario and secoes > LIMITE_SUMARIO_SEM_PAGINA:
            # Só um sumário LONGO merece página própria. Com poucas entradas, a
            # quebra deixa uma folha com três linhas — o defeito da proposta na
            # revisão da v1.
            self._sumario.append(PageBreak())
        elif self._sumario:
            self._sumario.append(Spacer(1, 0.6 * cm))

        if self._fecho_pendente:
            self.story.append(Spacer(1, 0.6 * cm))
            self.story.append(Paragraph(
                texto_seguro(self._fecho_pendente, self.fonte), self.s_apoio))
            self._fecho_pendente = None

        fechamento = self._quer_contracapa
        if fechamento is None:
            fechamento = self.regras["fechamento"]
        if fechamento in ("faixa", "pagina") and not self._contracapa_feita:
            self.contracapa(estilo=fechamento)
        return self._capa + self._sumario + self.story

    def salvar(self, auditar=True):
        """Constrói o PDF e, por padrão, AUDITA o arquivo gerado.

        A auditoria não é enfeite: é o que garante que o arquivo entregue não
        tem texto fora da margem, caractere sem glifo, fonte não embutida,
        metadado vazio, placeholder de rascunho, página em branco ou assinatura
        órfã. Devolve `{"ok", "paginas", "achados"}`; achado grave levanta
        `KitError` — é melhor falhar na geração do que entregar um PDF
        quebrado."""
        historia = self._finalizar_estrutura()
        doc = _Documento(
            self.caminho, pagesize=PAGINA,
            leftMargin=MARGEM["esq"], rightMargin=MARGEM["dir"],
            topMargin=MARGEM["sup"], bottomMargin=MARGEM["inf"],
            title=_plano(self.titulo_doc) or "Documento",
            author=_plano(self.emissor or self.cliente) or "Frederico AI Studio",
            subject=_plano(self.assunto) or _plano(self.tipo),
            creator="Frederico AI Studio", lang="pt-BR")
        frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                      leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
                      id="conteudo")
        doc.addPageTemplates([PageTemplate(id="principal", frames=[frame])])
        _CanvasNumerado.emissor = _plano(self.emissor)
        _CanvasNumerado.titulo_doc = _plano(self.titulo_doc)
        _CanvasNumerado.pal = self.pal
        _CanvasNumerado.fonte = self.fonte
        _CanvasNumerado.fonte_bold = self.fonte_bold
        _CanvasNumerado.confidencial = self.confidencial
        _CanvasNumerado.marcadores = []
        if self._toc is not None:
            # multiBuild: o sumário só sabe as páginas na 2ª passagem.
            doc.multiBuild(historia, canvasmaker=_CanvasNumerado)
        else:
            doc.build(historia, canvasmaker=_CanvasNumerado)
        if not auditar:
            self.auditoria = []
            return relatorio([], paginas=_paginas_do_pdf(self.caminho),
                             caminho=self.caminho)
        achados = list(self._achados_geracao)
        achados += auditar_pdf(self.caminho)
        achados += self._auditar_conteudo()
        self.auditoria = achados
        rel = relatorio(achados, paginas=_paginas_do_pdf(self.caminho),
                        caminho=self.caminho)
        return falha_se_grave(rel, "pdfpro")

    def _auditar_conteudo(self):
        """Achados de CONTEÚDO — os mesmos do docpro: placeholder de rascunho,
        página em branco e assinatura sozinha numa página."""
        paginas = _texto_por_pagina(self.caminho)
        if not paginas:
            return [achado("aviso", "pdf-ilegivel",
                           "não foi possível ler o texto do PDF gerado "
                           "(pypdf ausente?): placeholder e página vazia não "
                           "foram conferidos")]
        achados = achados_de_placeholder(paginas, "PDF")
        for valor in self._kpis_escritos:
            alvo = re.sub(r"\s+", " ", valor).strip()
            if alvo and not any(alvo in re.sub(r"[ \t]+", " ", p) for p in paginas):
                achados.append(achado(
                    "aviso", "kpi-quebrado",
                    "o KPI %r não aparece inteiro em nenhuma linha do PDF — "
                    "provavelmente quebrou em duas" % valor))
        achados += kits.achados_de_paginacao(
            paginas, self._assinantes, self._textos_de_fechamento,
            ultima_e_arte=self._contracapa_de_pagina)
        return achados


# ---------------------------------------------------------------------------
# 7. AUDITORIA — lê o PDF PRONTO e confere o que o leitor vai ver
# ---------------------------------------------------------------------------

_OBJ = re.compile(rb"(\d+)\s+0\s+obj\b(.*?)(?:\bstream\r?\n|\bendobj\b)", re.DOTALL)
_PAGINA_OBJ = re.compile(rb"/Type\s*/Page(?![sA-Za-z])")
_CONTEUDO_REF = re.compile(rb"/Contents\s*(?:(\d+)\s+0\s+R|\[([^\]]*)\])")
_REFS = re.compile(rb"(\d+)\s+0\s+R")
_KIDS = re.compile(rb"/Kids\s*\[([^\]]*)\]")
# Fontes que o reportlab usa como ÚLTIMO recurso quando o caractere pedido não
# existe na fonte do texto. Ver `_conteudos`/auditoria: elas aparecendo no meio
# de um parágrafo é sinal de glifo trocado, não de escolha tipográfica.
_FONTES_DE_ULTIMO_RECURSO = (b"Symbol", b"ZapfDingbats")
_FONTE_OBJ = re.compile(rb"<<([^<>]*?/Type\s*/Font.*?)>>", re.DOTALL)
_NUM = r"-?\d+(?:\.\d+)?"
# O texto do reportlab sai como `BT 1 0 0 1 x y Tm (...) Tj`, mas SEMPRE dentro
# de um ou mais `q ... cm ... Q`: cada flowable do platypus é desenhado num
# sistema de coordenadas próprio. Ler o `Tm` sem acompanhar a pilha de `cm` dá
# números relativos e sem sentido — por isso o auditor mantém a pilha.
_TOKENS = re.compile(
    (r"(?P<q>\bq\b)|(?P<Q>\bQ\b)"
     r"|(?P<cm>({n})\s+({n})\s+({n})\s+({n})\s+({n})\s+({n})\s+cm\b)"
     r"|(?P<tm>({n})\s+({n})\s+({n})\s+({n})\s+({n})\s+({n})\s+Tm\b)"
     r"|(?P<td>({n})\s+({n})\s+(?:Td|TD)\b)"
     r"|(?P<mostra>\bTj\b|\bTJ\b)"
     ).format(n=_NUM).encode("ascii"))
#: Literais de texto do PDF. São removidos ANTES de varrer os operadores: um
#: relatório que cite "Tj" ou "q" no corpo não pode confundir o auditor.
_LITERAL = re.compile(rb"\((?:\\.|[^()\\])*\)", re.DOTALL)


def _descomprime(cru, cabecalho):
    """Desfaz os filtros que o reportlab usa (ASCII85 e/ou Flate)."""
    dado = cru
    if b"/ASCII85Decode" in cabecalho:
        limpo = dado.strip()
        if limpo.endswith(b"~>"):
            limpo = limpo[:-2]
        dado = base64.a85decode(limpo)
    if b"/FlateDecode" in cabecalho:
        dado = zlib.decompress(dado)
    return dado


def _objetos(bruto):
    """`{número do objeto: (cabeçalho, conteúdo do stream ou None)}`."""
    mapa = {}
    for m in _OBJ.finditer(bruto):
        numero = int(m.group(1))
        cabecalho = m.group(2)
        dados = None
        if m.group(0).rstrip().endswith(b"stream"):
            fim = bruto.find(b"endstream", m.end())
            if fim >= 0:
                try:
                    dados = _descomprime(bruto[m.end():fim], cabecalho)
                except Exception:
                    dados = None
        mapa[numero] = (cabecalho, dados)
    return mapa


def _conteudos(bruto):
    """Conteúdo de cada PÁGINA, já descomprimido e NA ORDEM das páginas.

    Devolver "todos os streams" seria mais simples e estaria errado: o arquivo
    também carrega o binário das fontes embutidas, e varrer aquilo à procura de
    operadores de texto produz coordenadas inventadas — alarme falso na
    auditoria."""
    objetos = _objetos(bruto)
    paginas = [n for n, (cab, _) in objetos.items() if _PAGINA_OBJ.search(cab)]
    kids = _KIDS.search(bruto)
    if kids:
        ordem = [int(x) for x in _REFS.findall(kids.group(1))]
        conhecidas = set(paginas)
        paginas = [n for n in ordem if n in conhecidas] + \
                  [n for n in sorted(paginas) if n not in set(ordem)]
    else:
        paginas = sorted(paginas)

    saida = []
    for numero in paginas:
        cabecalho, _ = objetos[numero]
        ref = _CONTEUDO_REF.search(cabecalho)
        if not ref:
            continue
        alvos = [int(ref.group(1))] if ref.group(1) else \
            [int(x) for x in _REFS.findall(ref.group(2) or b"")]
        pedacos = [objetos[a][1] for a in alvos if a in objetos and objetos[a][1]]
        if pedacos:
            saida.append(b"\n".join(pedacos))
    return saida


def _fontes_de_ultimo_recurso(bruto):
    """Nomes (`/F5`) das fontes Symbol/ZapfDingbats declaradas no arquivo."""
    nomes = set()
    for m in _FONTE_OBJ.finditer(bruto):
        corpo = m.group(1)
        base = re.search(rb"/BaseFont\s*/([A-Za-z0-9+\-]+)", corpo)
        nome = re.search(rb"/Name\s*/(F\d+)", corpo)
        if base and nome and base.group(1) in _FONTES_DE_ULTIMO_RECURSO:
            nomes.add(nome.group(1))
    return nomes


def posicoes_de_texto(conteudo):
    """Coordenadas `(x, y)` ABSOLUTAS onde cada trecho de texto DESENHADO começa.

    Três cuidados que a leitura ingênua não tem, e sem os quais a medida não
    serve para nada:

      1. o `Tm` de cada flowable é relativo ao `q ... cm ... Q` em que o
         platypus o desenhou — é preciso compor a pilha de matrizes;
      2. o reportlab centraliza e alinha à direita com `Td`, não com `Tm`:
         ignorar o `Td` reporta a origem da célula, não onde o texto começa;
      3. `BT ... Tm ... ET` sem nenhum `Tj` é bloco VAZIO (o platypus emite
         vários) e não pode entrar na conta.
    """
    pilha = []
    # Só as translações interessam (o kit nunca rotaciona nem escala texto).
    ax, ay, ex, ey = 1.0, 1.0, 0.0, 0.0
    tx = ty = 0.0                  # posição corrente dentro do objeto de texto
    saida = []
    for m in _TOKENS.finditer(_LITERAL.sub(b"()", conteudo)):
        nome = m.lastgroup
        if nome == "q":
            pilha.append((ax, ay, ex, ey))
        elif nome == "Q":
            if pilha:
                ax, ay, ex, ey = pilha.pop()
        elif nome == "cm":
            v = [float(x) for x in m.groups()[3:9]]
            ex, ey = ax * v[4] + ex, ay * v[5] + ey
            ax, ay = ax * v[0], ay * v[3]
        elif nome == "tm":
            v = [float(x) for x in m.groups()[10:16]]
            tx, ty = v[4], v[5]
        elif nome == "td":
            tx += float(m.group(18))
            ty += float(m.group(19))
        elif nome == "mostra":
            saida.append((ax * tx + ex, ay * ty + ey))
    return saida


def auditar_pdf(caminho, margem_tolerancia=1.0):
    """Confere o PDF PRONTO e devolve a lista de achados.

    Cada achado é `{"gravidade": "grave"|"aviso", "codigo": ..., "mensagem": ...}`.
    Verifica o que de fato quebra a entrega:

      texto-fora-da-grade  algum texto começa fora da caixa útil (margem furada)
      glifo-invalido       caractere de controle/DEL no conteúdo (quadrado no leitor)
      fonte-nao-embutida   nenhuma fonte embutida (depende do leitor ter a fonte)
      sem-tounicode        fonte embutida sem /ToUnicode (não dá para copiar/buscar)
      metadado-vazio       sem /Title ou /Author (leitor mostra o nome do arquivo)
      pagina-irregular     páginas com tamanhos diferentes
    """
    with open(caminho, "rb") as f:
        bruto = f.read()
    achados = []

    if not bruto.startswith(b"%PDF-"):
        return [{"gravidade": "grave", "codigo": "nao-e-pdf",
                 "mensagem": "o arquivo não começa com %PDF-"}]

    conteudos = _conteudos(bruto)
    limite_esq = X_CAIXA - margem_tolerancia
    limite_dir = X_CAIXA + LARGURA_CAIXA + margem_tolerancia
    fora = []
    for conteudo in conteudos:
        for x, _y in posicoes_de_texto(conteudo):
            if x < limite_esq or x > limite_dir:
                fora.append(round(x, 2))

    embutidas = bruto.count(b"/FontFile2") + bruto.count(b"/FontFile3") + bruto.count(b"/FontFile")
    # Um caractere que a fonte não desenha some de duas formas, conforme a
    # versão do reportlab: vira `\177` (DEL) na própria fonte, ou é redesenhado
    # com a Symbol/ZapfDingbats — e aí o leitor mostra uma letra grega no lugar
    # do marcador. As duas contam como glifo trocado.
    controles = 0
    if not embutidas:
        # `\177` só é legível em fonte base-14 (WinAnsi), onde o byte do stream
        # É o código do caractere. Em TTF embutida os bytes são índices do
        # subconjunto: qualquer valor é legítimo e a varredura só daria alarme
        # falso.
        for conteudo in conteudos:
            for texto in _LITERAL.findall(conteudo):
                if b"\\177" in texto:
                    controles += 1
    for nome in _fontes_de_ultimo_recurso(bruto):
        for conteudo in conteudos:
            controles += len(re.findall(rb"/" + nome + rb"\s+[\d.]+\s+Tf", conteudo))

    if fora:
        achados.append({
            "gravidade": "grave", "codigo": "texto-fora-da-grade",
            "mensagem": "%d trecho(s) de texto começam fora da caixa útil "
                        "(x=%s; esperado entre %.1f e %.1f pt)"
                        % (len(fora), sorted(set(fora))[:6], limite_esq, limite_dir)})
    if controles:
        achados.append({
            "gravidade": "grave", "codigo": "glifo-invalido",
            "mensagem": "%d trecho(s) com glifo trocado (DEL ou fonte Symbol de "
                        "último recurso) — use texto_seguro() ou os blocos do kit"
                        % controles})

    if not embutidas:
        achados.append({
            "gravidade": "aviso", "codigo": "fonte-nao-embutida",
            "mensagem": "nenhuma fonte embutida: o texto depende de o leitor "
                        "ter a fonte instalada"})
    elif b"/ToUnicode" not in bruto:
        achados.append({
            "gravidade": "grave", "codigo": "sem-tounicode",
            "mensagem": "fonte embutida sem /ToUnicode: o texto não pode ser "
                        "copiado nem pesquisado"})

    if b"/Title" not in bruto or b"/Author" not in bruto:
        achados.append({
            "gravidade": "aviso", "codigo": "metadado-vazio",
            "mensagem": "sem /Title ou /Author: o leitor mostra o nome do arquivo"})

    caixas = set(re.findall(rb"/MediaBox\s*\[([^\]]+)\]", bruto))
    if len(caixas) > 1:
        achados.append({
            "gravidade": "grave", "codigo": "pagina-irregular",
            "mensagem": "o documento tem páginas de tamanhos diferentes"})
    return achados


def _texto_por_pagina(caminho):
    """Texto de cada página do PDF, na ordem. `[]` quando não dá para ler."""
    try:
        from pypdf import PdfReader
    except Exception:                                          # pragma: no cover
        try:
            from PyPDF2 import PdfReader  # type: ignore
        except Exception:
            return []
    try:
        return [(p.extract_text() or "") for p in PdfReader(caminho).pages]
    except Exception:                                          # pragma: no cover
        return []


def _paginas_do_pdf(caminho):
    """Número de páginas — pelo pypdf quando existir, senão contando /Type/Page."""
    paginas = _texto_por_pagina(caminho)
    if paginas:
        return len(paginas)
    try:
        with open(caminho, "rb") as f:
            return len(_conteudos(f.read()))
    except Exception:                                          # pragma: no cover
        return 0


def verificar_pdf(caminho):
    """Atalho para o modelo conferir o próprio arquivo antes de entregar.
    Imprime o resultado e devolve True quando não há achado grave."""
    achados = auditar_pdf(caminho)
    if not achados:
        print("PDF OK: grade, glifos, fontes e metadados conferidos.")
        return True
    for a in achados:
        print("[%s] %s: %s" % (a["gravidade"].upper(), a["codigo"], a["mensagem"]))
    return not any(a["gravidade"] == "grave" for a in achados)
