"""docpro — kit de DESIGN profissional para documentos Word (.docx) com python-docx.

Instalado no sandbox do Frederico AI Studio. Fornece funções PRONTAS e testadas
para o padrão de design de agência (paleta, capa, títulos com barra, tabelas sem
bordas verticais com cabeçalho colorido + zebra, callouts, KPIs, rodapé com
"Página X de Y"). Assim o modelo não precisa reinventar o oxml.

Uso mínimo:
    from docpro import Relatorio, PALETA
    r = Relatorio("Relatório Gerencial", cliente="ACME LTDA", emissor="Meu Escritório")
    r.capa()                                   # capa em página própria
    r.titulo("1. Dados cadastrais")
    r.tabela(["Campo", "Valor"], [["CNPJ", "00.000.000/0001-00"], ...])
    r.paragrafo("Texto de análise ...")
    r.callout("RESUMO", "Empresa ativa, porte médio ...")
    r.salvar("/workspace/outputs/relatorio.docx")   # já gera o PDF ao lado
"""
from datetime import date
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

PALETA = {
    "primaria": "1A3C6E", "apoio": "2E75B6", "corpo": "262626",
    "cinza": "595959", "suave": "F2F6FA", "borda": "D9E2EC", "branco": "FFFFFF",
    "alerta_bg": "FEF6E7", "alerta_bd": "D97706", "critico_bg": "FDECEC", "critico_bd": "C0392B",
}


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


def _cell_pad(cell, t=80, b=80, l=120, r=120):
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


def _run(p, texto, bold=False, size=11, cor=None, branco=False, caps=False, spacing=None):
    r = p.add_run("" if texto is None else str(texto))
    r.font.name = "Calibri"
    r.bold = bold
    r.font.size = Pt(size)
    r.font.color.rgb = RGBColor.from_string("FFFFFF" if branco else (cor or PALETA["corpo"]))
    if caps:
        r.font.all_caps = True
    if spacing:
        r._element.get_or_add_rPr().append(_el("w:spacing", val=spacing))
    return r


class Relatorio:
    def __init__(self, titulo, cliente="", emissor="", subtitulo="",
                 tipo="RELATÓRIO", data_str=None, margem_cm=2.0, cor_marca=None):
        self.doc = Document()
        self.titulo_doc = titulo
        self.cliente = cliente
        self.emissor = emissor
        self.subtitulo = subtitulo
        self.tipo = tipo
        self.data_str = data_str or date.today().strftime("%d/%m/%Y")
        self.pal = dict(PALETA)
        if cor_marca:
            self.pal["primaria"] = str(cor_marca).lstrip("#")
        st = self.doc.styles["Normal"]
        st.font.name = "Calibri"
        st.font.size = Pt(11)
        st.font.color.rgb = RGBColor.from_string(self.pal["corpo"])
        for s in self.doc.sections:
            s.top_margin = s.bottom_margin = Cm(margem_cm)
            s.left_margin = s.right_margin = Cm(margem_cm)

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
            p = self.doc.add_paragraph(); _run(p, self.emissor, size=11, cor=self.pal["cinza"], bold=True)
        self._gap(5.2)
        self._barra(tamanho=40)
        p = self.doc.add_paragraph(); _run(p, self.tipo, size=12, cor=self.pal["apoio"], bold=True, caps=True, spacing=30)
        p = self.doc.add_paragraph(); p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.keep_with_next = True
        _run(p, self.titulo_doc, size=27, cor=self.pal["primaria"], bold=True)
        if self.subtitulo:
            p = self.doc.add_paragraph(); _run(p, self.subtitulo, size=14, cor=self.pal["cinza"])
        self._barra(cor=self.pal["apoio"], tamanho=12)
        self._gap(5.0)
        for rot, val in (("Cliente", self.cliente), ("Data", self.data_str), ("Emitido por", self.emissor)):
            if val:
                p = self.doc.add_paragraph(); p.paragraph_format.space_after = Pt(2)
                _run(p, rot + ": ", bold=True, size=10, cor=self.pal["cinza"]); _run(p, val, size=10, cor=self.pal["cinza"])
        self.doc.add_page_break()
        self._rodape()

    def titulo(self, texto, nivel=1):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(14 if nivel == 1 else 8)
        p.paragraph_format.space_after = Pt(6)
        p.paragraph_format.left_indent = Pt(10)
        p.paragraph_format.keep_with_next = True
        _run(p, texto, bold=True, size=16 if nivel == 1 else 13, cor=self.pal["primaria"])
        pbdr = _el("w:pBdr")
        pbdr.append(_el("w:left", val="single", sz=24, space="8", color=self.pal["primaria"]))
        p._p.get_or_add_pPr().append(pbdr)
        return p

    def paragrafo(self, texto, justificado=True):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_after = Pt(8)
        p.paragraph_format.line_spacing = 1.15
        if justificado:
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        _run(p, texto)
        return p

    def _bordas_tabela(self, t):
        b = _el("w:tblBorders")
        b.append(_el("w:top", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:bottom", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:insideH", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:left", val="nil"))
        b.append(_el("w:right", val="nil"))
        b.append(_el("w:insideV", val="nil"))
        _tblpr_put(t._tbl.tblPr, b)

    def tabela(self, cabecalho, linhas, total=False):
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
            sombrear_celula(cell, self.pal["primaria"])
            cell.paragraphs[0].text = ""
            _run(cell.paragraphs[0], c, bold=True, branco=True)
            _cell_pad(cell)
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
                _run(cell.paragraphs[0], v, bold=eh_total)
                cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT if _num(v) else WD_ALIGN_PARAGRAPH.LEFT
                _cell_pad(cell)
            if eh_total:
                for cell in row.cells:
                    tcPr = cell._tc.get_or_add_tcPr()
                    bd = _el("w:tcBorders")
                    bd.append(_el("w:top", val="single", sz=14, color=self.pal["primaria"]))
                    tcPr.append(bd)
        self._fit(t)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        return t

    def callout(self, rotulo, texto, tipo="info"):
        bg = {"info": self.pal["suave"], "alerta": self.pal["alerta_bg"], "critico": self.pal["critico_bg"]}[tipo]
        bd = {"info": self.pal["primaria"], "alerta": self.pal["alerta_bd"], "critico": self.pal["critico_bd"]}[tipo]
        t = self.doc.add_table(rows=1, cols=1)
        cell = t.rows[0].cells[0]
        sombrear_celula(cell, bg)
        _cell_pad(cell, 120, 120, 160, 160)
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
        # itens = [(valor, rotulo), ...]
        t = self.doc.add_table(rows=2, cols=len(itens))
        for i, (valor, rot) in enumerate(itens):
            cv = t.rows[0].cells[i]; sombrear_celula(cv, self.pal["suave"]); _cell_pad(cv, 120, 40, 120, 120)
            cv.paragraphs[0].text = ""; cv.paragraphs[0].alignment = 1
            _run(cv.paragraphs[0], valor, bold=True, size=20, cor=self.pal["primaria"])
            cr = t.rows[1].cells[i]; sombrear_celula(cr, self.pal["suave"]); _cell_pad(cr, 0, 120, 120, 120)
            cr.paragraphs[0].text = ""; cr.paragraphs[0].alignment = 1
            _run(cr.paragraphs[0], rot, size=9, cor=self.pal["cinza"], caps=True)
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
        r = p.add_run(str(texto).upper()); r.bold = True; r.font.size = Pt(self.tam + 1)
        p.paragraph_format.space_after = Pt(12)
        return p

    def secao(self, texto, caps=True):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        r = p.add_run(str(texto).upper() if caps else str(texto)); r.bold = True
        p.paragraph_format.space_before = Pt(10); p.paragraph_format.space_after = Pt(4)
        return p

    def paragrafo(self, texto, recuo=True):
        p = self.doc.add_paragraph(str(texto))
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        if recuo:
            p.paragraph_format.first_line_indent = Cm(1.25)
        return p

    def item(self, texto, recuo=False):
        # cláusula/deliberação numerada — o texto já traz "1.", "CLÁUSULA 1ª" etc.
        return self.paragrafo(texto, recuo=recuo)

    def fecho(self, local_data):
        p = self.doc.add_paragraph(str(local_data))
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.space_before = Pt(14)
        return p

    def assinaturas(self, nomes, subtitulos=None):
        subtitulos = subtitulos or [None] * len(nomes)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(6)
        for i, nome in enumerate(nomes):
            self.doc.add_paragraph()  # respiro para assinar
            l = self.doc.add_paragraph("_" * 40); l.alignment = WD_ALIGN_PARAGRAPH.CENTER
            l.paragraph_format.space_after = Pt(0)
            n = self.doc.add_paragraph(); n.alignment = WD_ALIGN_PARAGRAPH.CENTER
            n.add_run(str(nome)).bold = True
            n.paragraph_format.space_after = Pt(0)
            if i < len(subtitulos) and subtitulos[i]:
                s = self.doc.add_paragraph(); s.alignment = WD_ALIGN_PARAGRAPH.CENTER
                s.add_run(str(subtitulos[i])).font.size = Pt(self.tam - 2)

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
