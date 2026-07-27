"""docpro — kit de DESIGN para documentos Word (.docx) com python-docx.

Instalado no sandbox do Frederico AI Studio. Fornece funções PRONTAS e testadas
para o padrão de design de agência, na identidade **"Tinta & Latão"**:
verde-tinta #0C3A30 com acento em latão #A9812F, Source Serif 4 (títulos e
números de destaque) sobre Source Sans 3 (corpo e tabelas). Assim o modelo não
precisa reinventar o oxml — nem a tipografia.

Duas regras estruturais que valem para todo bloco:

  * **uma aresta esquerda só** (`RECUO_PT`) — parágrafo, título, primeira coluna
    da tabela e conteúdo do callout pousam na mesma vertical;
  * **nenhuma tabela sem largura declarada** — ou 100% da área útil (`_fit`) ou
    largura fixa em dxa com a grade coerente (`_fixa`). É o que impede o
    clássico "tabela vazando a margem".

Uso mínimo:
    from docpro import Relatorio
    r = Relatorio("Análise Econômico-Financeira 2025", cliente="ACME LTDA",
                  emissor="Meu Escritório", tipo="RELATÓRIO GERENCIAL")
    r.capa()                                   # capa em página própria
    r.sumario([("Sumário executivo", 3), ("Indicadores", 4)])
    r.titulo("Dados cadastrais")               # vira "SEÇÃO 01" + título
    r.tabela(["Campo", "Valor"], [["CNPJ", "00.000.000/0001-00"]])
    r.paragrafo("Texto de análise ...")
    r.lista(["primeiro item", "segundo item"])
    r.kpis([("R$ 5,84 mi", "Receita"), ("18,4%", "Margem")])
    r.callout("RESUMO", "Empresa ativa, porte médio ...")
    r.grafico_barras(["2024", "2025"], {"Receita": [5.2, 5.8]}, titulo="Receita")
    r.assinaturas(["Nome"], cargos=["Contador"], local_data="Palmas/TO, ...")
    r.contracapa(contatos=["contato@empresa.com.br"])
    r.salvar("/workspace/outputs/relatorio.docx")   # já gera o PDF ao lado

Documento registrável (ata, contrato, alteração contratual — JUCETINS) usa a
outra classe, `Sobrio`: ZERO cor, Times 12, corpo justificado de fábrica.
"""
import re
import unicodedata
from datetime import date
from docx import Document
from docx.shared import Pt, Cm, Twips, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# Identidade "Tinta & Latão": verde-tinta profundo com acento em latão.
# `primaria` continua existindo como ALIAS de `tinta` — o kit inteiro a usa e
# manter as duas evita reescrever cada bloco só para trocar de nome.
PALETA = {
    "tinta": "0C3A30", "apoio": "33705C", "latao": "A9812F",
    "latao_escuro": "8A6825", "latao_claro": "C9A75B",
    "corpo": "26241E", "cinza": "6B6459", "suave": "F5F2EA",
    "borda": "E2DCCB", "borda_leve": "F0EBDD", "branco": "FFFFFF",
    "creme": "C9C2AE",
    "alerta_bg": "FBF3DE", "alerta_bd": "A97614",
    "critico_bg": "F9ECE7", "critico_bd": "9C3D24",
    "primaria": "0C3A30",
}

#: Tipografia: serifada nos títulos e nos números de destaque, sem serifa no
#: corpo e nas tabelas. O Word resolve a fonte pelo NOME — se ela não estiver
#: instalada na máquina de quem abre, cai no fallback e o documento continua
#: legível, só perde a voz. Para entrega externa, prefira o PDF (que embute).
F_SERIF = "Source Serif 4"
F_SANS = "Source Sans 3"
#: Cores dos gráficos, na ordem das séries/fatias (matplotlib usa "#RRGGBB").
CORES_GRAF = ["#0C3A30", "#A9812F", "#33705C", "#C9A75B"]

# ---------------------------------------------------------------------------
# Grade: a MESMA ideia do pdfpro. Existe uma única distância entre a margem do
# papel e o começo do texto, e todo bloco a respeita — parágrafo, título com
# barra, primeira coluna da tabela e conteúdo do callout. Sem isso o título
# nasce 10 pt à direita do corpo e a tabela 4 pt à esquerda dele: três arestas
# na mesma página, que é exatamente o que faz o documento parecer mal feito.
# ---------------------------------------------------------------------------

#: Recuo do texto em pontos. Em Word a margem interna de célula é medida em
#: dxa (1/20 de ponto), daí a conversão.
RECUO_PT = 10
RECUO_DXA = RECUO_PT * 20
#: Respiro interno das demais colunas da tabela (não afeta a aresta esquerda).
RESPIRO_DXA = 120

# Caractere de controle é ILEGAL em XML 1.0: escrevê-lo no .docx produz um
# arquivo que o Word recusa a abrir ("conteúdo ilegível"). O texto do modelo
# passa por aqui antes de virar run.
_CONTROLES = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def limpa_texto(valor):
    """Normaliza e remove o que quebraria o XML do documento."""
    if valor is None:
        return ""
    return _CONTROLES.sub("", unicodedata.normalize("NFC", str(valor))).replace("\t", " ")


def _el(tag, **attrs):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn("w:" + k), str(v))
    return e


# Ordem canônica dos filhos de <w:tblPr> (CT_TblPr). O Word até tolera fora de
# ordem, mas python-docx e validadores estritos não — inserir tblW/tblBorders/
# tblLayout na posição certa evita um .docx que "abre corrompido" ou perde o
# estilo. Só listamos os elementos que este kit realmente usa.
_TBLPR_ORDER = [
    "tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize",
    "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd",
    "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook",
]


def _tblpr_put(tblPr, el):
    """Substitui/insere `el` em `tblPr` respeitando a ordem do schema OOXML."""
    tag = el.tag.split("}")[-1]
    for existente in tblPr.findall(qn("w:" + tag)):
        tblPr.remove(existente)
    posteriores = set(_TBLPR_ORDER[_TBLPR_ORDER.index(tag) + 1:]) if tag in _TBLPR_ORDER else set()
    ref = None
    for filho in tblPr:
        if filho.tag.split("}")[-1] in posteriores:
            ref = filho
            break
    if ref is None:
        tblPr.append(el)
    else:
        ref.addprevious(el)


def _shade(elem, fill):
    elem.append(_el("w:shd", val="clear", fill=fill))


def sombrear_celula(cell, cor):
    _shade(cell._tc.get_or_add_tcPr(), cor)


def _cell_pad(cell, t=80, b=80, l=RESPIRO_DXA, r=RESPIRO_DXA):
    tcPr = cell._tc.get_or_add_tcPr()
    m = _el("w:tcMar")
    for k, v in (("top", t), ("bottom", b), ("start", l), ("end", r)):
        m.append(_el("w:" + k, w=v, type="dxa"))
    tcPr.append(m)


def _num(v):
    s = str(v).strip().replace("R$", "").replace(".", "").replace(",", ".").replace("%", "").strip()
    try:
        float(s)
        return True
    except Exception:
        return False


def _run(p, texto, bold=False, size=11, cor=None, branco=False, caps=False,
         spacing=None, serif=False, italico=False):
    r = p.add_run(limpa_texto(texto))
    fonte = F_SERIF if serif else F_SANS
    r.font.name = fonte
    rpr = r._element.get_or_add_rPr()
    # `font.name` sozinho só define o script latino: sem o w:rFonts completo, o
    # Word troca a fonte em qualquer caractere fora do ASCII.
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = _el("w:rFonts")
        rpr.append(rfonts)
    for a in ("ascii", "hAnsi", "cs"):
        rfonts.set(qn("w:" + a), fonte)
    r.bold = bold
    r.italic = italico
    r.font.size = Pt(size)
    r.font.color.rgb = RGBColor.from_string("FFFFFF" if branco else (cor or PALETA["corpo"]))
    if caps:
        r.font.all_caps = True
    if spacing:
        rpr.append(_el("w:spacing", val=spacing))
    return r


class Relatorio:
    def __init__(self, titulo, cliente="", emissor="", subtitulo="",
                 tipo="RELATÓRIO", data_str=None, margem_cm=2.0, cor_marca=None,
                 confidencial=True):
        self.doc = Document()
        self.titulo_doc = titulo
        self.cliente = cliente
        self.emissor = emissor
        self.subtitulo = subtitulo
        self.tipo = tipo
        self.confidencial = bool(confidencial)
        self.data_str = data_str or date.today().strftime("%d/%m/%Y")
        self.pal = dict(PALETA)
        if cor_marca:
            self.pal["tinta"] = self.pal["primaria"] = str(cor_marca).lstrip("#")
        self._sec = 0     # numeração automática de "SEÇÃO NN"
        self._tab = 0     # rótulo "Tabela N"
        self._fig = 0     # rótulo "Gráfico N"
        st = self.doc.styles["Normal"]
        st.font.name = F_SANS
        st.font.size = Pt(10.5)
        st.font.color.rgb = RGBColor.from_string(self.pal["corpo"])
        rpr = st.element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = _el("w:rFonts")
            rpr.append(rfonts)
        for a in ("ascii", "hAnsi", "cs"):
            rfonts.set(qn("w:" + a), F_SANS)
        for s in self.doc.sections:
            s.top_margin = s.bottom_margin = Cm(margem_cm)
            s.left_margin = s.right_margin = Cm(margem_cm)
        #: Largura útil em cm — usada pelos blocos de largura fixa.
        self._larg = 21.0 - 2 * margem_cm

    # ---------- blocos ----------
    def _fit(self, t, pct=5000):
        """Faz a tabela ocupar a largura útil da página (100% = pct 5000). Sem
        isso o python-docx cria a tabela com largura "auto", e conteúdo largo
        empurra as colunas PARA FORA da margem direita — o clássico "tabela
        vazando". Com tblW=100% + layout autofit, o Word ajusta as colunas ao
        conteúdo mas mantém a tabela dentro da área de texto."""
        tblPr = t._tbl.tblPr
        _tblpr_put(tblPr, _el("w:tblW", w=pct, type="pct"))
        _tblpr_put(tblPr, _el("w:tblLayout", type="autofit"))
        t.autofit = True
        return t

    def _fixa(self, t, larguras_cm):
        """Layout FIXO com larguras exatas (KPIs, linha do tempo, assinaturas).

        A largura total vai declarada em `w:tblW type="dxa"` E a grade
        (`w:tblGrid`) recebe as mesmas medidas. Sem mexer na grade, o Word
        resolve o layout fixo pela grade herdada do python-docx — colunas
        iguais, somando MAIS que a área útil — e a tabela vaza a margem mesmo
        com cada célula medida uma a uma. O arredondamento de cada coluna para
        twips pode somar um fio a mais que a área útil: o excedente sai da
        coluna mais larga."""
        larguras = [Cm(w).twips for w in larguras_cm]
        excesso = sum(larguras) - Cm(self._larg).twips
        if excesso > 0 and larguras:
            larguras[larguras.index(max(larguras))] -= excesso
        tblPr = t._tbl.tblPr
        _tblpr_put(tblPr, _el("w:tblW", w=sum(larguras), type="dxa"))
        _tblpr_put(tblPr, _el("w:tblLayout", type="fixed"))
        t.autofit = False
        grid = t._tbl.find(qn("w:tblGrid"))
        if grid is not None:
            for col, w in zip(grid.findall(qn("w:gridCol")), larguras):
                col.set(qn("w:w"), str(w))
        for row in t.rows:
            for i, w in enumerate(larguras):
                if i < len(row.cells):
                    row.cells[i].width = Twips(w)
        return t

    def _cell_borders(self, cell, **lados):
        """lados: top/bottom/left/right = (espessura, cor) | "nil"."""
        tcPr = cell._tc.get_or_add_tcPr()
        bd = _el("w:tcBorders")
        for lado, spec in lados.items():
            if spec == "nil":
                bd.append(_el("w:" + lado, val="nil"))
            else:
                sz, cor = spec
                bd.append(_el("w:" + lado, val="single", sz=sz, space="0", color=cor))
        tcPr.append(bd)
        return cell

    def _sem_bordas(self, t):
        b = _el("w:tblBorders")
        for e in ("top", "bottom", "left", "right", "insideH", "insideV"):
            b.append(_el("w:" + e, val="nil"))
        _tblpr_put(t._tbl.tblPr, b)
        return t

    def _rotulo_bloco(self, prefixo, contador, texto):
        """Rótulo "Tabela 1 — ..." / "Gráfico 1 — ...", preso ao bloco seguinte
        por keep_with_next (solto, ele fica órfão no pé da página)."""
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(10)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        p.paragraph_format.keep_with_next = True
        _run(p, "%s %d — %s" % (prefixo, contador, texto), bold=True, size=9.5,
             cor=self.pal["tinta"], serif=True)
        return p

    def _gap(self, cm_):
        """Espaço vertical de altura EXATA (para a capa não depender de contar
        parágrafos em branco, que estouram para uma 2ª página quando o título
        quebra em duas linhas)."""
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.space_before = Pt(0)
        pf.space_after = Cm(cm_)
        pf.line_spacing = Pt(2)
        r = p.add_run(""); r.font.size = Pt(2)
        return p

    def _barra(self, cor=None, tamanho=48):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(10)
        pbdr = _el("w:pBdr")
        pbdr.append(_el("w:bottom", val="single", sz=tamanho, space="1", color=cor or self.pal["primaria"]))
        p._p.get_or_add_pPr().append(pbdr)
        return p

    def capa(self):
        # A capa (1ª página) não leva o rodapé "Página X de Y": ativa o
        # cabeçalho/rodapé de primeira página diferente e deixa o dela vazio.
        self.doc.sections[0].different_first_page_header_footer = True
        if self.emissor:
            p = self.doc.add_paragraph()
            p.paragraph_format.left_indent = Pt(RECUO_PT)
            _run(p, self.emissor, size=10, cor=self.pal["cinza"], bold=True,
                 caps=True, spacing=40)
        self._gap(5.2)
        self._barra(tamanho=40)
        p = self.doc.add_paragraph()
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        _run(p, self.tipo, size=11, cor=self.pal["latao"], bold=True, caps=True, spacing=44)
        p = self.doc.add_paragraph(); p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        p.paragraph_format.keep_with_next = True
        _run(p, self.titulo_doc, size=27, cor=self.pal["tinta"], bold=True, serif=True)
        if self.subtitulo:
            p = self.doc.add_paragraph()
            p.paragraph_format.left_indent = Pt(RECUO_PT)
            _run(p, self.subtitulo, size=14, cor=self.pal["cinza"], serif=True, italico=True)
        self._barra(cor=self.pal["latao"], tamanho=12)
        self._gap(5.0)
        for rot, val in (("Cliente", self.cliente), ("Data", self.data_str), ("Emitido por", self.emissor)):
            if val:
                p = self.doc.add_paragraph(); p.paragraph_format.space_after = Pt(2)
                p.paragraph_format.left_indent = Pt(RECUO_PT)
                _run(p, rot + ": ", bold=True, size=10, cor=self.pal["cinza"]); _run(p, val, size=10, cor=self.pal["cinza"])
        if self.confidencial:
            p = self.doc.add_paragraph()
            p.paragraph_format.space_before = Pt(10)
            p.paragraph_format.left_indent = Pt(RECUO_PT)
            _run(p, "CONFIDENCIAL", bold=True, size=8.5, cor=self.pal["latao"], spacing=48)
        self.doc.add_page_break()
        self._rodape()

    def titulo(self, texto, nivel=1, kicker=None):
        """Título de seção. No nível 1 o kit numera sozinho ("SEÇÃO 01") — o
        texto recebe só o nome da seção. `kicker=""` desliga a numeração;
        `kicker="ANEXO A"` a substitui."""
        if nivel == 1 and kicker != "":
            if kicker is None:
                self._sec += 1
                kicker = "SEÇÃO %02d" % self._sec
            k = self.doc.add_paragraph()
            k.paragraph_format.space_before = Pt(16)
            k.paragraph_format.space_after = Pt(2)
            k.paragraph_format.left_indent = Pt(RECUO_PT)
            k.paragraph_format.keep_with_next = True
            _run(k, kicker, bold=True, size=8.5, cor=self.pal["latao"], spacing=44)
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0 if nivel == 1 else 8)
        p.paragraph_format.space_after = Pt(6)
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        p.paragraph_format.keep_with_next = True
        _run(p, texto, bold=True, size=16 if nivel == 1 else 13,
             cor=self.pal["tinta"], serif=True)
        pbdr = _el("w:pBdr")
        pbdr.append(_el("w:left", val="single", sz=24, space="8", color=self.pal["tinta"]))
        p._p.get_or_add_pPr().append(pbdr)
        return p

    def paragrafo(self, texto, justificado=True):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_after = Pt(8)
        p.paragraph_format.line_spacing = 1.15
        # O corpo usa o MESMO recuo do título e da primeira coluna da tabela:
        # é o que mantém uma única aresta esquerda na página inteira.
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        if justificado:
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        _run(p, texto)
        return p

    def lista(self, itens, ordenada=False):
        """Lista com marcador e recuo pendurado, alinhada à mesma aresta.

        Existe para o modelo não montar lista "na mão" com hífen no meio do
        parágrafo (que não recua a 2ª linha) nem com um caractere de marcador
        que a fonte do leitor pode não ter."""
        saida = []
        for i, item in enumerate(itens, start=1):
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.space_after = Pt(3)
            pf.line_spacing = 1.15
            pf.left_indent = Pt(RECUO_PT + 14)
            pf.first_line_indent = Pt(-14)   # marcador pendurado em RECUO_PT
            _run(p, ("%d. " % i) if ordenada else "• ")
            _run(p, item)
            saida.append(p)
        return saida

    def _bordas_tabela(self, t):
        b = _el("w:tblBorders")
        b.append(_el("w:top", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:bottom", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:insideH", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:left", val="nil"))
        b.append(_el("w:right", val="nil"))
        b.append(_el("w:insideV", val="nil"))
        _tblpr_put(t._tbl.tblPr, b)

    def tabela(self, cabecalho, linhas, total=False, titulo=None, fonte=None):
        """Tabela do kit. `titulo=` põe o rótulo "Tabela N — ..." acima e
        `fonte=` a linha de origem do dado abaixo."""
        if titulo:
            self._tab += 1
            self._rotulo_bloco("Tabela", self._tab, titulo)
        # Robustez: a tabela tem exatamente len(cabecalho) colunas. Normaliza
        # cada linha para essa largura (completa as curtas, corta as extras) —
        # assim uma linha com nº de valores diferente do cabeçalho nunca derruba
        # a geração inteira do documento com IndexError.
        ncols = len(cabecalho)
        linhas = [list(linha)[:ncols] + [""] * (ncols - len(linha)) for linha in linhas]
        t = self.doc.add_table(rows=1, cols=len(cabecalho))
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        try:
            t.style = "Table Grid"
        except Exception:
            pass
        self._bordas_tabela(t)
        # cabeçalho
        hdr = t.rows[0]
        hdr._tr.append(_el("w:trPr")) if hdr._tr.find(qn("w:trPr")) is None else None
        hdr._tr.get_or_add_trPr().append(_el("w:tblHeader"))
        for i, c in enumerate(cabecalho):
            cell = hdr.cells[i]
            sombrear_celula(cell, self.pal["tinta"])
            cell.paragraphs[0].text = ""
            _run(cell.paragraphs[0], c, bold=True, branco=True, size=10.5)
            # A 1ª coluna recebe o recuo da grade; as demais, só o respiro.
            _cell_pad(cell, l=RECUO_DXA if i == 0 else RESPIRO_DXA)
        # linhas
        n = len(linhas)
        for ri, linha in enumerate(linhas):
            row = t.add_row()
            eh_total = total and ri == n - 1
            zebra = (not eh_total) and n >= 6 and (ri % 2 == 1)
            for i, v in enumerate(linha):
                cell = row.cells[i]
                if eh_total:
                    sombrear_celula(cell, self.pal["suave"])
                elif zebra:
                    sombrear_celula(cell, self.pal["suave"])
                cell.paragraphs[0].text = ""
                _run(cell.paragraphs[0], v, bold=eh_total, size=10.5,
                     cor=self.pal["tinta"] if eh_total else None)
                cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT if _num(v) else WD_ALIGN_PARAGRAPH.LEFT
                _cell_pad(cell, l=RECUO_DXA if i == 0 else RESPIRO_DXA)
            if eh_total:
                for cell in row.cells:
                    tcPr = cell._tc.get_or_add_tcPr()
                    bd = _el("w:tcBorders")
                    # Filete de latão: separa o TOTAL sem repetir a cor do
                    # cabeçalho — é o acento da identidade.
                    bd.append(_el("w:top", val="single", sz=14, color=self.pal["latao"]))
                    tcPr.append(bd)
        self._fit(t)
        if fonte:
            p = self.doc.add_paragraph()
            p.paragraph_format.space_before = Pt(3)
            p.paragraph_format.left_indent = Pt(RECUO_PT)
            _run(p, fonte, size=8, cor=self.pal["cinza"])
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        return t

    def callout(self, rotulo, texto, tipo="info"):
        bg = {"info": self.pal["suave"], "alerta": self.pal["alerta_bg"], "critico": self.pal["critico_bg"]}[tipo]
        bd = {"info": self.pal["tinta"], "alerta": self.pal["alerta_bd"], "critico": self.pal["critico_bd"]}[tipo]
        t = self.doc.add_table(rows=1, cols=1)
        cell = t.rows[0].cells[0]
        sombrear_celula(cell, bg)
        _cell_pad(cell, 120, 120, RECUO_DXA, RECUO_DXA)
        tcPr = cell._tc.get_or_add_tcPr()
        b = _el("w:tcBorders")
        b.append(_el("w:left", val="single", sz=24, color=bd))
        for e in ("top", "bottom", "right"):
            b.append(_el("w:" + e, val="nil"))
        tcPr.append(b)
        cell.paragraphs[0].text = ""
        if rotulo:
            _run(cell.paragraphs[0], rotulo, bold=True, size=9, cor=bd, caps=True, spacing=20)
            p = cell.add_paragraph()
        else:
            p = cell.paragraphs[0]
        _run(p, texto)
        self._fit(t)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        return t

    def kpis(self, itens):
        """Cartões de indicador — `[(valor, rótulo), ...]`, de 2 a 4."""
        itens = list(itens)
        if not itens:
            return None
        t = self.doc.add_table(rows=2, cols=len(itens))
        for i, (valor, rot) in enumerate(itens):
            cv = t.rows[0].cells[i]; sombrear_celula(cv, self.pal["suave"]); _cell_pad(cv, 130, 40, 120, 120)
            cv.paragraphs[0].text = ""; cv.paragraphs[0].alignment = 1
            _run(cv.paragraphs[0], valor, bold=True, size=19, cor=self.pal["tinta"], serif=True)
            # Filete de latão no topo do cartão — o acento da identidade.
            self._cell_borders(cv, top=(24, self.pal["latao"]))
            cr = t.rows[1].cells[i]; sombrear_celula(cr, self.pal["suave"]); _cell_pad(cr, 0, 130, 120, 120)
            cr.paragraphs[0].text = ""; cr.paragraphs[0].alignment = 1
            _run(cr.paragraphs[0], rot, size=7.5, bold=True, cor=self.pal["cinza"],
                 caps=True, spacing=24)
        # Separa os cartões: linha branca grossa entre colunas (senão os KPIs
        # coladas com o mesmo fundo suave viram um bloco único, sem respiro).
        b = _el("w:tblBorders")
        for e in ("top", "bottom", "left", "right", "insideH"):
            b.append(_el("w:" + e, val="nil"))
        b.append(_el("w:insideV", val="single", sz=36, color=self.pal["branco"]))
        _tblpr_put(t._tbl.tblPr, b)
        self._fit(t)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        return t

    # ---------- blocos editoriais ----------
    def sumario(self, entradas, titulo="Conteúdo deste documento"):
        """Sumário com índice pontilhado. `entradas` = [(título, página)] ou
        [(número, título, página)]. Os números são os que VOCÊ informa — o
        docx não recalcula campo de página sem abrir o Word."""
        k = self.doc.add_paragraph()
        k.paragraph_format.space_before = Pt(6)
        k.paragraph_format.space_after = Pt(2)
        k.paragraph_format.left_indent = Pt(RECUO_PT)
        k.paragraph_format.keep_with_next = True
        _run(k, "SUMÁRIO", bold=True, size=8.5, cor=self.pal["latao"], spacing=44)
        p = self.doc.add_paragraph()
        p.paragraph_format.space_after = Pt(12)
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        p.paragraph_format.keep_with_next = True
        pbdr = _el("w:pBdr")
        pbdr.append(_el("w:bottom", val="single", sz=20, space="8", color=self.pal["tinta"]))
        p._p.get_or_add_pPr().append(pbdr)
        _run(p, titulo, bold=True, size=19, cor=self.pal["tinta"], serif=True)
        for i, entrada in enumerate(entradas):
            entrada = list(entrada)
            if len(entrada) == 3:
                num, tit, pag = entrada
            else:
                tit, pag = entrada
                num = "%02d" % (i + 1)
            e = self.doc.add_paragraph()
            e.paragraph_format.space_before = Pt(6)
            e.paragraph_format.space_after = Pt(6)
            e.paragraph_format.left_indent = Pt(RECUO_PT)
            e.paragraph_format.tab_stops.add_tab_stop(
                Cm(self._larg), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
            pbdr = _el("w:pBdr")
            pbdr.append(_el("w:bottom", val="single", sz=4, space="4",
                            color=self.pal["borda_leve"]))
            e._p.get_or_add_pPr().append(pbdr)
            _run(e, str(num) + "   ", bold=True, size=9.5, cor=self.pal["latao"])
            _run(e, tit, bold=True, size=11, serif=True)
            e.add_run("\t")
            _run(e, str(pag), size=9.5, cor=self.pal["cinza"])
        self.doc.add_paragraph().paragraph_format.space_after = Pt(8)
        return None

    def citacao(self, texto, fonte=""):
        """Frase-chave destacada por um filete de latão à esquerda."""
        t = self.doc.add_table(rows=1, cols=1)
        self._sem_bordas(t)
        cell = t.rows[0].cells[0]
        self._cell_borders(cell, left=(18, self.pal["latao"]))
        _cell_pad(cell, 60, 60, RECUO_DXA + 180, RECUO_DXA)
        cell.paragraphs[0].text = ""
        p = cell.paragraphs[0]
        p.paragraph_format.line_spacing = 1.35
        _run(p, "“" + str(texto).strip("“”\"") + "”", size=13.5,
             cor=self.pal["tinta"], serif=True, italico=True)
        if fonte:
            pf = cell.add_paragraph()
            pf.paragraph_format.space_before = Pt(5)
            _run(pf, fonte, bold=True, size=8, cor=self.pal["cinza"], caps=True, spacing=20)
        self._fit(t)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        return t

    def etapas(self, itens, titulo=None):
        """Linha do tempo vertical — `[(etapa, quando/descrição), ...]`."""
        itens = list(itens)
        if not itens:
            return None
        if titulo:
            self.titulo(titulo, nivel=2)
        col_num = 1.3
        t = self.doc.add_table(rows=len(itens), cols=2)
        self._sem_bordas(t)
        for i, item in enumerate(itens):
            etapa, quando = (list(item) + [""])[:2]
            cnum = t.rows[i].cells[0]
            cnum.paragraphs[0].text = ""
            _run(cnum.paragraphs[0], "%02d" % (i + 1), bold=True, size=14,
                 cor=self.pal["latao"], serif=True)
            _cell_pad(cnum, 110, 110, RECUO_DXA, 60)
            ctx = t.rows[i].cells[1]
            ctx.paragraphs[0].text = ""
            _run(ctx.paragraphs[0], etapa, bold=True, size=10.5)
            if quando:
                pd = ctx.add_paragraph()
                pd.paragraph_format.space_before = Pt(1)
                _run(pd, quando, size=9, cor=self.pal["cinza"])
            _cell_pad(ctx, 110, 110, 60, RECUO_DXA)
            if i < len(itens) - 1:
                self._cell_borders(cnum, bottom=(4, self.pal["borda_leve"]))
                self._cell_borders(ctx, bottom=(4, self.pal["borda_leve"]))
        self._fixa(t, [col_num, self._larg - col_num])
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        return t

    # ---------- gráficos (matplotlib com o tema do kit) ----------
    def _plt(self):
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.rcParams["font.family"] = "sans-serif"
        plt.rcParams["font.sans-serif"] = [F_SANS, "DejaVu Sans"]
        plt.rcParams["axes.edgecolor"] = "#" + self.pal["borda"]
        plt.rcParams["text.color"] = "#" + self.pal["corpo"]
        plt.rcParams["xtick.color"] = "#" + self.pal["cinza"]
        plt.rcParams["ytick.color"] = "#" + self.pal["cinza"]
        return plt

    def _fecha_fig(self, plt, fig, titulo, largura_cm, altura_cm):
        import os
        import tempfile
        for ax in fig.axes:
            for lado in ("top", "right", "left"):
                ax.spines[lado].set_visible(False)
            ax.spines["bottom"].set_color("#" + self.pal["borda"])
            ax.tick_params(length=0, labelsize=8)
            ax.set_axisbelow(True)
        fig.set_size_inches(largura_cm / 2.54, altura_cm / 2.54)
        fig.tight_layout()
        caminho = os.path.join(tempfile.gettempdir(), "docpro_fig_%d.png" % self._fig)
        fig.savefig(caminho, dpi=200, facecolor="white", bbox_inches="tight")
        plt.close(fig)
        if titulo:
            self._rotulo_bloco("Gráfico", self._fig, titulo)
        # O parágrafo da figura recebe o MESMO recuo do corpo: sem ele a imagem
        # nasce colada na margem e cria uma segunda aresta na página.
        p = self.doc.add_paragraph()
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        p.add_run().add_picture(caminho, width=Cm(largura_cm))
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        return caminho

    def grafico_barras(self, categorias, series, titulo="", largura_cm=None, altura_cm=7.0):
        """`series` = {"Nome": [valores]} ou uma lista simples de valores."""
        largura_cm = largura_cm or (self._larg - 0.6)
        self._fig += 1
        plt = self._plt()
        fig, ax = plt.subplots()
        if not isinstance(series, dict):
            series = {"": list(series)}
        ns = max(1, len(series))
        larg = 0.8 / ns
        x = range(len(categorias))
        for si, (nome, vals) in enumerate(series.items()):
            pos = [xi + si * larg - 0.4 + larg / 2 for xi in x]
            ax.bar(pos, list(vals), width=larg * 0.9,
                   color=CORES_GRAF[si % len(CORES_GRAF)], label=nome or None)
        ax.set_xticks(list(x))
        ax.set_xticklabels([limpa_texto(c) for c in categorias])
        ax.grid(axis="y", color="#" + self.pal["borda"], linewidth=0.6)
        if any(series.keys()):
            ax.legend(frameon=False, fontsize=8, loc="upper left")
        return self._fecha_fig(plt, fig, titulo, largura_cm, altura_cm)

    def grafico_linhas(self, categorias, series, titulo="", largura_cm=None, altura_cm=7.0):
        largura_cm = largura_cm or (self._larg - 0.6)
        self._fig += 1
        plt = self._plt()
        fig, ax = plt.subplots()
        if not isinstance(series, dict):
            series = {"": list(series)}
        for si, (nome, vals) in enumerate(series.items()):
            ax.plot(range(len(categorias)), list(vals), linewidth=2.2, marker="o",
                    markersize=4, color=CORES_GRAF[si % len(CORES_GRAF)], label=nome or None)
        ax.set_xticks(range(len(categorias)))
        ax.set_xticklabels([limpa_texto(c) for c in categorias])
        ax.grid(axis="y", color="#" + self.pal["borda"], linewidth=0.6)
        if any(series.keys()):
            ax.legend(frameon=False, fontsize=8, loc="upper left")
        return self._fecha_fig(plt, fig, titulo, largura_cm, altura_cm)

    def grafico_pizza(self, rotulos, valores, titulo="", largura_cm=11.0, altura_cm=7.0):
        self._fig += 1
        plt = self._plt()
        fig, ax = plt.subplots()
        cores = [CORES_GRAF[i % len(CORES_GRAF)] for i in range(len(valores))]
        ax.pie(list(valores), labels=[limpa_texto(r) for r in rotulos], colors=cores,
               autopct="%1.0f%%", pctdistance=0.78, textprops={"fontsize": 8},
               wedgeprops={"width": 0.42, "edgecolor": "white", "linewidth": 2})
        return self._fecha_fig(plt, fig, titulo, largura_cm, altura_cm)

    # ---------- fecho, assinaturas e contracapa ----------
    def fecho(self, local_data):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(16)
        p.paragraph_format.left_indent = Pt(RECUO_PT)
        _run(p, local_data)
        return p

    def assinaturas(self, nomes, cargos=None, local_data=None):
        """Linhas de assinatura em PARES lado a lado, dentro da grade."""
        nomes = list(nomes)
        cargos = list(cargos or []) + [None] * len(nomes)
        if local_data:
            self.fecho(local_data)
        self._gap(2.2)
        meio = 1.4
        w = (self._larg - meio) / 2
        t = None
        for pi in range(0, len(nomes), 2):
            par = nomes[pi:pi + 2]
            t = self.doc.add_table(rows=1, cols=3)
            self._sem_bordas(t)
            for j, nome in enumerate(par):
                cell = t.rows[0].cells[j * 2]
                self._cell_borders(cell, top=(6, self.pal["corpo"]))
                _cell_pad(cell, 110, 40, 60, 60)
                cell.paragraphs[0].text = ""
                cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
                _run(cell.paragraphs[0], nome, bold=True, size=11, serif=True)
                cargo = cargos[pi + j]
                if cargo:
                    pc = cell.add_paragraph()
                    pc.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    _run(pc, cargo, size=8.5, cor=self.pal["cinza"])
            self._fixa(t, [w, meio, w])
            if pi + 2 < len(nomes):
                self._gap(1.6)
        return t

    def contracapa(self, contatos=None, nota=None):
        """Página final em tinta com os contatos do emissor.

        No Word a mancha ocupa a ÁREA ÚTIL: as margens do papel continuam
        brancas (o formato não tem sangria). Chame só quando houver contato
        REAL — sem contato ela não tem função."""
        self.doc.add_page_break()
        t = self.doc.add_table(rows=1, cols=1)
        self._sem_bordas(t)
        cell = t.rows[0].cells[0]
        sombrear_celula(cell, self.pal["tinta"])
        self._cell_borders(cell, top=(24, self.pal["latao"]))
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        trPr = t.rows[0]._tr.get_or_add_trPr()
        trPr.append(_el("w:trHeight", val=int(Cm(23.0).pt * 20), hRule="exact"))
        cell.paragraphs[0].text = ""
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        _run(p, self.emissor or self.titulo_doc, bold=True, size=20,
             cor=self.pal["suave"], serif=True)
        if contatos:
            pk = cell.add_paragraph()
            pk.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pk.paragraph_format.space_before = Pt(14)
            _run(pk, "CONTATO", bold=True, size=8, cor=self.pal["latao_claro"], spacing=48)
            for linha in contatos:
                pc = cell.add_paragraph()
                pc.alignment = WD_ALIGN_PARAGRAPH.CENTER
                pc.paragraph_format.space_after = Pt(2)
                _run(pc, linha, size=10, cor=self.pal["creme"])
        if nota is None and self.confidencial:
            nota = ("Este documento é confidencial e destina-se exclusivamente "
                    "ao cliente identificado na capa.")
        if nota:
            pn = cell.add_paragraph()
            pn.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pn.paragraph_format.space_before = Pt(36)
            _run(pn, nota, size=7.5, cor=self.pal["creme"])
        self._fit(t)
        return t

    def _rodape(self):
        sec = self.doc.sections[-1]
        f = sec.footer
        f.is_linked_to_previous = False
        p = f.paragraphs[0]
        p.text = ""
        pbdr = _el("w:pBdr")
        pbdr.append(_el("w:top", val="single", sz=4, color=self.pal["borda"]))
        p._p.get_or_add_pPr().append(pbdr)
        _run(p, (self.emissor or "") + "   ", size=8, cor=self.pal["cinza"])
        if self.confidencial:
            _run(p, "CONFIDENCIAL   ", bold=True, size=8, cor=self.pal["latao"], spacing=24)
        _run(p, "Página ", size=8, cor=self.pal["cinza"])
        self._campo(p, "PAGE")
        _run(p, " de ", size=8, cor=self.pal["cinza"])
        self._campo(p, "NUMPAGES")

    def _campo(self, p, code):
        r = p.add_run()
        fld = _el("w:fldChar", fldCharType="begin"); r._r.append(fld)
        r2 = p.add_run(); instr = OxmlElement("w:instrText"); instr.set(qn("xml:space"), "preserve"); instr.text = " " + code + " "; r2._r.append(instr)
        r3 = p.add_run(); fld2 = _el("w:fldChar", fldCharType="end"); r3._r.append(fld2)
        for rr in (r, r2, r3):
            rr.font.size = Pt(8); rr.font.color.rgb = RGBColor.from_string(self.pal["cinza"])

    def salvar(self, caminho, pdf=True):
        self.doc.save(caminho)
        if pdf:
            import subprocess, os
            try:
                subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir",
                                os.path.dirname(caminho) or ".", caminho],
                               timeout=90, capture_output=True, check=False)
            except Exception:
                pass
        return caminho


class Sobrio:
    """Documento SÓBRIO/registrável (ata, contrato, alteração contratual) em
    python-docx puro: ZERO cor, corpo SEMPRE JUSTIFICADO, fonte formal, margens
    de documento oficial e rodapé "Página X de Y". A justificação nasce no
    estilo Normal — não depende de o modelo lembrar de alinhar cada parágrafo.

    Uso:
        from docpro import Sobrio
        a = Sobrio()                       # Times New Roman 12, entrelinha 1,5
        a.titulo("ATA DE REUNIÃO DE SÓCIOS")
        a.paragrafo("Aos vinte e cinco dias do mês de ...")   # já sai justificado
        a.secao("ORDEM DO DIA")
        a.item("1. Aprovação das contas do exercício ...")
        a.fecho("Palmas/TO, 25 de outubro de 2025.")
        a.assinaturas(["João da Silva", "Maria Oliveira"],
                      subtitulos=["Sócio-administrador", "Sócia"])
        a.salvar("/workspace/outputs/ata.docx")               # gera o PDF ao lado
    """

    def __init__(self, fonte="Times New Roman", tamanho=12, entrelinha=1.5,
                 rodape_paginado=True):
        self.doc = Document()
        self.tam = tamanho
        for s in self.doc.sections:
            s.top_margin = Cm(2.5); s.bottom_margin = Cm(2.5)
            s.left_margin = Cm(3.0); s.right_margin = Cm(2.0)
        st = self.doc.styles["Normal"]
        st.font.name = fonte
        st.font.size = Pt(tamanho)
        st.font.color.rgb = RGBColor(0, 0, 0)
        # garante a fonte em todos os scripts (evita fallback estranho)
        rpr = st.element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = _el("w:rFonts"); rpr.append(rfonts)
        for a in ("ascii", "hAnsi", "cs"):
            rfonts.set(qn("w:" + a), fonte)
        pf = st.paragraph_format
        pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY   # <- justificação de fábrica
        pf.line_spacing = entrelinha
        pf.space_after = Pt(6)
        if rodape_paginado:
            self._rodape()

    def titulo(self, texto):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(limpa_texto(texto).upper()); r.bold = True; r.font.size = Pt(self.tam + 1)
        p.paragraph_format.space_after = Pt(12)
        return p

    def identificacao(self, titulo, linha2=None):
        """Bloco de abertura registrável: título centralizado, a qualificação
        da sociedade (razão social, CNPJ, NIRE) e um filete duplo abaixo.

        É o que a junta comercial espera ver no alto da folha — e o que evita
        o modelo abrir a ata com um título solto e a qualificação perdida no
        meio do primeiro parágrafo."""
        p = self.titulo(titulo)
        p.paragraph_format.space_after = Pt(4)
        if linha2:
            q = self.doc.add_paragraph()
            q.alignment = WD_ALIGN_PARAGRAPH.CENTER
            q.paragraph_format.space_after = Pt(6)
            r = q.add_run(limpa_texto(linha2))
            r.font.size = Pt(self.tam - 1)
        fil = self.doc.add_paragraph()
        fil.paragraph_format.space_before = Pt(0)
        fil.paragraph_format.space_after = Pt(14)
        pbdr = _el("w:pBdr")
        pbdr.append(_el("w:bottom", val="double", sz=6, space="1", color="000000"))
        fil._p.get_or_add_pPr().append(pbdr)
        return p

    def secao(self, texto, caps=True):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        texto = limpa_texto(texto)
        r = p.add_run(texto.upper() if caps else texto); r.bold = True
        p.paragraph_format.space_before = Pt(10); p.paragraph_format.space_after = Pt(4)
        return p

    def paragrafo(self, texto, recuo=True):
        p = self.doc.add_paragraph(limpa_texto(texto))
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        if recuo:
            p.paragraph_format.first_line_indent = Cm(1.25)
        return p

    def item(self, texto, recuo=False):
        # cláusula/deliberação numerada — o texto já traz "1.", "CLÁUSULA 1ª" etc.
        return self.paragrafo(texto, recuo=recuo)

    def fecho(self, local_data):
        p = self.doc.add_paragraph(limpa_texto(local_data))
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.space_before = Pt(14)
        return p

    def assinaturas(self, nomes, subtitulos=None):
        """Assinaturas em PARES lado a lado — uma folha de ata com seis sócios
        empilhados um por linha vira três páginas de espaço em branco."""
        nomes = list(nomes)
        subtitulos = list(subtitulos or []) + [None] * len(nomes)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(12)
        # Largura útil desta página: A4 menos as margens oficiais (3 + 2 cm).
        util = 21.0 - 3.0 - 2.0
        meio = 1.2
        w = (util - meio) / 2
        t = None
        for pi in range(0, len(nomes), 2):
            par = nomes[pi:pi + 2]
            t = self.doc.add_table(rows=1, cols=3)
            b = _el("w:tblBorders")
            for e in ("top", "bottom", "left", "right", "insideH", "insideV"):
                b.append(_el("w:" + e, val="nil"))
            _tblpr_put(t._tbl.tblPr, b)
            for j, nome in enumerate(par):
                cell = t.rows[0].cells[j * 2]
                tcPr = cell._tc.get_or_add_tcPr()
                bd = _el("w:tcBorders")
                bd.append(_el("w:top", val="single", sz=6, space="0", color="000000"))
                tcPr.append(bd)
                _cell_pad(cell, 120, 40, 60, 60)
                cell.paragraphs[0].text = ""
                cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
                cell.paragraphs[0].paragraph_format.space_after = Pt(0)
                r = cell.paragraphs[0].add_run(limpa_texto(nome))
                r.bold = True
                r.font.size = Pt(self.tam - 1)
                sub = subtitulos[pi + j]
                if sub:
                    ps = cell.add_paragraph()
                    ps.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    ps.paragraph_format.space_after = Pt(0)
                    ps.add_run(limpa_texto(sub)).font.size = Pt(self.tam - 3)
            # Layout fixo com a grade declarada: sem isso a tabela de assinatura
            # vaza a margem direita da folha registrável.
            larguras = [Cm(x).twips for x in (w, meio, w)]
            _tblpr_put(t._tbl.tblPr, _el("w:tblW", w=sum(larguras), type="dxa"))
            _tblpr_put(t._tbl.tblPr, _el("w:tblLayout", type="fixed"))
            t.autofit = False
            grid = t._tbl.find(qn("w:tblGrid"))
            if grid is not None:
                for col, larg in zip(grid.findall(qn("w:gridCol")), larguras):
                    col.set(qn("w:w"), str(larg))
            for col_i, larg in enumerate(larguras):
                t.rows[0].cells[col_i].width = Twips(larg)
            if pi + 2 < len(nomes):
                self.doc.add_paragraph().paragraph_format.space_after = Pt(24)
        return t

    def _rodape(self):
        f = self.doc.sections[-1].footer
        f.is_linked_to_previous = False
        p = f.paragraphs[0]; p.text = ""; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.add_run("Página ").font.size = Pt(9)
        self._campo(p, "PAGE")
        p.add_run(" de ").font.size = Pt(9)
        self._campo(p, "NUMPAGES")

    def _campo(self, p, code):
        r = p.add_run(); r._r.append(_el("w:fldChar", fldCharType="begin"))
        r2 = p.add_run(); instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve"); instr.text = " " + code + " "; r2._r.append(instr)
        r3 = p.add_run(); r3._r.append(_el("w:fldChar", fldCharType="end"))
        for rr in (r, r2, r3):
            rr.font.size = Pt(9); rr.font.color.rgb = RGBColor(0, 0, 0)

    def salvar(self, caminho, pdf=True):
        self.doc.save(caminho)
        if pdf:
            import subprocess, os
            try:
                subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir",
                                os.path.dirname(caminho) or ".", caminho],
                               timeout=90, capture_output=True, check=False)
            except Exception:
                pass
        return caminho


# atalhos de módulo
def sombrear(cell, cor):
    sombrear_celula(cell, cor)
