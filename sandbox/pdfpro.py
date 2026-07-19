"""pdfpro — kit de DESIGN profissional para PDF (.pdf) com reportlab.

Instalado no sandbox do Frederico AI Studio. Dá capa, títulos com barra lateral,
tabelas com cabeçalho colorido + zebra + TOTAL, callouts, parágrafos e rodapé
"Página X de Y" — no mesmo padrão visual do docpro/xlspro.

Uso mínimo:
    from pdfpro import RelatorioPDF
    r = RelatorioPDF("/workspace/outputs/proposta.pdf",
                     titulo="Proposta Comercial", cliente="ACME LTDA",
                     emissor="Meu Escritório", subtitulo="Serviços contábeis",
                     tipo="PROPOSTA COMERCIAL")
    r.capa()
    r.titulo("1. Escopo")
    r.paragrafo("Texto ...")
    r.tabela(["Serviço", "Valor"], [["Contabilidade", "R$ 1.200,00"],
             ["TOTAL", "R$ 1.200,00"]], total=True)
    r.callout("OBSERVAÇÃO", "texto")
    r.salvar()
"""
from datetime import date
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_RIGHT, TA_CENTER
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Table, TableStyle, Spacer, PageBreak, KeepTogether)
from reportlab.pdfgen import canvas as _canvas

PALETA = {
    "primaria": colors.HexColor("#1A3C6E"), "apoio": colors.HexColor("#2E75B6"),
    "corpo": colors.HexColor("#262626"), "cinza": colors.HexColor("#595959"),
    "suave": colors.HexColor("#F2F6FA"), "borda": colors.HexColor("#D9E2EC"),
    "branco": colors.white,
    "alerta_bg": colors.HexColor("#FEF6E7"), "alerta_bd": colors.HexColor("#D97706"),
    "critico_bg": colors.HexColor("#FDECEC"), "critico_bd": colors.HexColor("#C0392B"),
}


def _num(v):
    s = str(v).strip().replace("R$", "").replace(".", "").replace(",", ".").replace("%", "").strip()
    try:
        float(s); return True
    except Exception:
        return False


class _NumberedCanvas(_canvas.Canvas):
    """Rodapé 'Página X de Y' (duas passagens) + linha fina, exceto na capa."""
    emissor = ""
    pal = PALETA

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._saved = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for i, st in enumerate(self._saved):
            self.__dict__.update(st)
            if i > 0:  # capa (página 1) sem rodapé
                self._rodape(i + 1, total)
            super().showPage()
        super().save()

    def _rodape(self, num, total):
        w, _ = A4
        y = 1.2 * cm
        self.setStrokeColor(self.pal["borda"]); self.setLineWidth(0.5)
        self.line(2 * cm, y + 10, w - 2 * cm, y + 10)
        self.setFont("Helvetica", 8); self.setFillColor(self.pal["cinza"])
        if self.emissor:
            self.drawString(2 * cm, y, self.emissor)
        self.drawRightString(w - 2 * cm, y, "Página %d de %d" % (num, total))


class RelatorioPDF:
    def __init__(self, caminho, titulo="Documento", cliente="", emissor="",
                 subtitulo="", tipo="RELATÓRIO", data_str=None, cor_marca=None):
        self.caminho = caminho
        self.titulo_doc = titulo
        self.cliente = cliente
        self.emissor = emissor
        self.subtitulo = subtitulo
        self.tipo = tipo
        self.data_str = data_str or date.today().strftime("%d/%m/%Y")
        self.pal = dict(PALETA)
        if cor_marca:
            self.pal["primaria"] = colors.HexColor("#" + str(cor_marca).lstrip("#"))
        self.story = []
        ss = getSampleStyleSheet()
        self.s_body = ParagraphStyle("body", parent=ss["Normal"], fontName="Helvetica",
                                     fontSize=10.5, leading=15, textColor=self.pal["corpo"],
                                     alignment=TA_JUSTIFY, spaceAfter=6)
        self.s_small = ParagraphStyle("small", parent=self.s_body, fontSize=8,
                                      textColor=self.pal["cinza"], alignment=TA_LEFT)
        self.s_cell = ParagraphStyle("cell", parent=self.s_body, alignment=TA_LEFT, spaceAfter=0)
        self.s_cellh = ParagraphStyle("cellh", parent=self.s_cell, textColor=self.pal["branco"],
                                      fontName="Helvetica-Bold")

    # ---------- blocos ----------
    def capa(self):
        p = self.pal
        st_emis = ParagraphStyle("emis", fontName="Helvetica-Bold", fontSize=11, textColor=p["cinza"])
        st_kick = ParagraphStyle("kick", fontName="Helvetica-Bold", fontSize=12, textColor=p["apoio"])
        st_tit = ParagraphStyle("tit", fontName="Helvetica-Bold", fontSize=27, textColor=p["primaria"], leading=32)
        st_sub = ParagraphStyle("sub", fontName="Helvetica", fontSize=14, textColor=p["cinza"])
        if self.emissor:
            self.story.append(Paragraph(self.emissor, st_emis))
        self.story.append(Spacer(1, 6 * cm))
        self.story.append(self._barra(p["primaria"], 3))
        self.story.append(Spacer(1, 0.3 * cm))
        self.story.append(Paragraph(self.tipo.upper(), st_kick))
        self.story.append(Paragraph(self.titulo_doc, st_tit))
        if self.subtitulo:
            self.story.append(Paragraph(self.subtitulo, st_sub))
        self.story.append(Spacer(1, 0.2 * cm))
        self.story.append(self._barra(p["apoio"], 1.2))
        self.story.append(Spacer(1, 5 * cm))
        for rot, val in (("Cliente", self.cliente), ("Data", self.data_str), ("Emitido por", self.emissor)):
            if val:
                self.story.append(Paragraph("<b>%s:</b> %s" % (rot, val), self.s_small))
        self.story.append(PageBreak())

    def _barra(self, cor, espessura):
        t = Table([[""]], colWidths=[17 * cm], rowHeights=[espessura])
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), cor),
                               ("LINEBELOW", (0, 0), (-1, -1), 0, cor)]))
        return t

    def titulo(self, texto, nivel=1):
        st = ParagraphStyle("h%d" % nivel, fontName="Helvetica-Bold",
                            fontSize=15 if nivel == 1 else 12.5, textColor=self.pal["primaria"],
                            leftIndent=8, spaceBefore=12, spaceAfter=6)
        t = Table([[Paragraph(texto, st)]], colWidths=[17 * cm])
        t.setStyle(TableStyle([
            ("LINEBEFORE", (0, 0), (0, -1), 2.5, self.pal["primaria"]),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        self.story.append(t)

    def paragrafo(self, texto):
        self.story.append(Paragraph(texto, self.s_body))

    def tabela(self, cabecalho, linhas, total=False, larguras=None):
        p = self.pal
        ncols = len(cabecalho)
        # Robustez: reportlab exige que toda linha tenha o MESMO nº de colunas.
        # Normaliza cada linha para a largura do cabeçalho (completa as curtas,
        # corta as extras) — evita crash com dados de largura irregular.
        linhas = [list(linha)[:ncols] + [""] * (ncols - len(linha)) for linha in linhas]
        head = [Paragraph(str(c), self.s_cellh) for c in cabecalho]
        dados = [head]
        for linha in linhas:
            dados.append([Paragraph(str(v), self.s_cell) for v in linha])
        if not larguras:
            larguras = [17.0 * cm / ncols] * ncols
        t = Table(dados, colWidths=larguras, repeatRows=1)
        ts = [
            ("BACKGROUND", (0, 0), (-1, 0), p["primaria"]),
            ("LINEBELOW", (0, 0), (-1, 0), 1.2, p["primaria"]),
            ("LINEBELOW", (0, 1), (-1, -1), 0.4, p["borda"]),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
        # alinhamento por coluna (números à direita) — olha a 1ª linha de dados
        if linhas:
            for j in range(ncols):
                if _num(linhas[0][j]):
                    ts.append(("ALIGN", (j, 1), (j, -1), "RIGHT"))
        # zebra
        n = len(linhas)
        if n >= 6:
            for i in range(n):
                if i % 2 == 1 and not (total and i == n - 1):
                    ts.append(("BACKGROUND", (0, i + 1), (-1, i + 1), p["suave"]))
        # total
        if total and n:
            ts.append(("BACKGROUND", (0, n), (-1, n), p["suave"]))
            ts.append(("LINEABOVE", (0, n), (-1, n), 1.2, p["primaria"]))
            ts.append(("FONTNAME", (0, n), (-1, n), "Helvetica-Bold"))
        t.setStyle(TableStyle(ts))
        self.story.append(t)
        self.story.append(Spacer(1, 0.3 * cm))

    def callout(self, rotulo, texto, tipo="info"):
        p = self.pal
        bg = {"info": p["suave"], "alerta": p["alerta_bg"], "critico": p["critico_bg"]}[tipo]
        bd = {"info": p["primaria"], "alerta": p["alerta_bd"], "critico": p["critico_bd"]}[tipo]
        st_r = ParagraphStyle("crot", fontName="Helvetica-Bold", fontSize=8.5, textColor=bd, spaceAfter=3)
        inner = []
        if rotulo:
            inner.append(Paragraph(rotulo.upper(), st_r))
        inner.append(Paragraph(texto, self.s_cell))
        t = Table([[inner]], colWidths=[17 * cm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), bg),
            ("LINEBEFORE", (0, 0), (0, -1), 2.5, bd),
            ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        self.story.append(t)
        self.story.append(Spacer(1, 0.3 * cm))

    def espaco(self, cm_=0.4):
        self.story.append(Spacer(1, cm_ * cm))

    def salvar(self):
        doc = BaseDocTemplate(self.caminho, pagesize=A4,
                              leftMargin=2 * cm, rightMargin=2 * cm,
                              topMargin=2 * cm, bottomMargin=2 * cm)
        frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
        doc.addPageTemplates([PageTemplate(id="main", frames=[frame])])
        _NumberedCanvas.emissor = self.emissor
        _NumberedCanvas.pal = self.pal
        doc.build(self.story, canvasmaker=_NumberedCanvas)
        return self.caminho
