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
    def _barra(self, cor=None, tamanho=48):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(10)
        pbdr = _el("w:pBdr")
        pbdr.append(_el("w:bottom", val="single", sz=tamanho, space="1", color=cor or self.pal["primaria"]))
        p._p.get_or_add_pPr().append(pbdr)
        return p

    def capa(self):
        for _ in range(2):
            self.doc.add_paragraph()
        if self.emissor:
            p = self.doc.add_paragraph(); _run(p, self.emissor, size=11, cor=self.pal["cinza"], bold=True)
        for _ in range(6):
            self.doc.add_paragraph()
        self._barra(tamanho=40)
        p = self.doc.add_paragraph(); _run(p, self.tipo, size=12, cor=self.pal["apoio"], bold=True, caps=True, spacing=30)
        p = self.doc.add_paragraph(); p.paragraph_format.space_after = Pt(4)
        _run(p, self.titulo_doc, size=27, cor=self.pal["primaria"], bold=True)
        if self.subtitulo:
            p = self.doc.add_paragraph(); _run(p, self.subtitulo, size=14, cor=self.pal["cinza"])
        self._barra(cor=self.pal["apoio"], tamanho=12)
        for _ in range(10):
            self.doc.add_paragraph()
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
        tblPr = t._tbl.tblPr
        b = _el("w:tblBorders")
        b.append(_el("w:top", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:bottom", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:insideH", val="single", sz=4, color=self.pal["borda"]))
        b.append(_el("w:left", val="nil"))
        b.append(_el("w:right", val="nil"))
        b.append(_el("w:insideV", val="nil"))
        tblPr.append(b)

    def tabela(self, cabecalho, linhas, total=False):
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


# atalhos de módulo
def sombrear(cell, cor):
    sombrear_celula(cell, cor)
