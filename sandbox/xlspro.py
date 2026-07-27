"""xlspro — kit de DESIGN para planilhas Excel (.xlsx) com openpyxl.

Instalado no sandbox do Frederico AI Studio, na mesma identidade
**"Tinta & Latão"** do docpro/pdfpro: cabeçalho em verde-tinta com filete de
latão, zebra, bordas horizontais discretas, formatos de número (R$, %, milhar),
linha de TOTAL, congelamento do cabeçalho, largura de coluna pelo texto
EXIBIDO, gráficos com as cores do tema e a **aba-painel** (KPIs + gráficos).

Uso mínimo:
    from xlspro import Planilha
    p = Planilha(emissor="Meu Escritório")
    ws = p.aba("Vendas")
    p.titulo(ws, "Vendas por produto — 2025")
    info = p.tabela(ws, ["Produto", "Qtd", "Preço", "Total"], linhas,
                    moeda=["Preço", "Total"], total=True)   # última linha = TOTAL
    painel = p.painel("Painel — Vendas 2025",
                      kpis=[("R$ 2,41 mi", "Faturamento"), (1284, "Pedidos")],
                      atualizado="27/07/2026")              # vira a 1ª aba
    p.grafico_barras(painel, info, categoria="Produto", valor="Total",
                     titulo="Total por produto", anchor="B10")
    p.salvar("/workspace/outputs/vendas.xlsx")
"""
import re
import unicodedata

import warnings

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.chart.marker import DataPoint
from openpyxl.chart.shapes import GraphicalProperties

# Identidade "Tinta & Latão", a mesma do docpro/pdfpro. `primaria` continua
# existindo como ALIAS de `tinta` para não reescrever cada bloco.
PALETA = {
    "tinta": "0C3A30", "apoio": "33705C", "latao": "A9812F",
    "latao_claro": "C9A75B", "corpo": "26241E", "cinza": "6B6459",
    "suave": "F5F2EA", "borda": "E2DCCB", "branco": "FFFFFF",
    "primaria": "0C3A30",
}
#: Serifada nos títulos e nos números de destaque; sem serifa no corpo.
F_SERIF = "Source Serif 4"
F_SANS = "Source Sans 3"
#: Cores dos gráficos, na ordem das séries/fatias.
CORES_GRAF = ["0C3A30", "A9812F", "33705C", "C9A75B"]
MOEDA_FMT = 'R$ #,##0.00'
PCT_FMT = '0.0%'
MILHAR_FMT = '#,##0'


# O openpyxl LEVANTA IllegalCharacterError ao gravar caractere de controle
# (ilegal em XML 1.0). Uma única célula com \x07 vinda de um PDF ou de um CSV
# sujo derrubava a geração inteira da planilha.
_CONTROLES = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def limpa_texto(valor):
    """Normaliza texto e remove o que o Excel não aceita. Números, datas e
    fórmulas passam intactos — só o texto é tratado."""
    if not isinstance(valor, str):
        return valor
    return _CONTROLES.sub("", unicodedata.normalize("NFC", valor)).replace("\t", " ")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _texto_exibido(val, kind):
    """Comprimento aproximado do TEXTO que o Excel realmente mostra na célula,
    já considerando o formato de número. Sem isso, uma coluna de moeda cujo
    valor bruto é 15015.0 (5 chars) ganhava largura de 5 e aparecia como
    ###### — porque o exibido é "R$ 15.015,00" (12 chars). O separador de
    milhar do Python é "," e o decimal ".", mas o COMPRIMENTO é o mesmo do
    padrão pt-BR ("1.234,50"), então serve para dimensionar a coluna."""
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return len(str(val))
    neg = 1 if val < 0 else 0
    if kind == "moeda":
        return len("R$ " + format(abs(val), ",.2f")) + neg
    if kind == "pct":
        return len(format(val * 100, ".1f")) + 1  # "15.6" + "%"
    if kind == "milhar":
        return len(format(abs(val), ",.0f")) + neg
    return len(str(val))


class Planilha:
    def __init__(self, cor_marca=None, emissor=""):
        self.wb = Workbook()
        self.wb.remove(self.wb.active)  # começa sem abas; use .aba() / .painel()
        self.pal = dict(PALETA)
        if cor_marca:
            self.pal["tinta"] = self.pal["primaria"] = str(cor_marca).lstrip("#")
        self.emissor = emissor
        self.fonte = F_SANS
        self.fonte_titulo = F_SERIF

    def aba(self, nome):
        # O Excel recusa nome de aba com : \ / ? * [ ] e limita a 31 caracteres.
        limpo = re.sub(r"[:\\/?*\[\]]", "-", limpa_texto(str(nome))).strip() or "Planilha"
        ws = self.wb.create_sheet(title=limpo[:31])
        ws.sheet_view.showGridLines = False
        return ws

    def titulo(self, ws, texto, colspan=6, linha=1):
        c = ws.cell(row=linha, column=1, value=limpa_texto(texto))
        c.font = Font(name=self.fonte_titulo, size=15, bold=True, color=self.pal["tinta"])
        c.alignment = Alignment(horizontal="left", vertical="center")
        ws.merge_cells(start_row=linha, start_column=1, end_row=linha, end_column=max(1, colspan))
        ws.row_dimensions[linha].height = 26
        return linha + 1

    def tabela(self, ws, cabecalho, linhas, inicio=None, moeda=None, pct=None,
               milhar=None, total=False, congelar=True):
        """Escreve uma tabela estilizada. `moeda`/`pct`/`milhar` = lista de nomes
        de coluna (do cabecalho) com esse formato. `total`=True destaca a última
        linha. Retorna dict com {ws, r0 (linha do cabeçalho), r1 (última linha de
        dados), c0, c1, cols} para uso em gráficos."""
        moeda = set(moeda or []); pct = set(pct or []); milhar = set(milhar or [])
        # Onde a tabela começa. Se `inicio` não vier: aba vazia → linha 1; caso
        # contrário (já tem título ou tabela acima) deixa UMA linha de respiro em
        # branco em vez de colar o cabeçalho no conteúdo anterior.
        if inicio:
            r0 = inicio
        elif ws.max_row == 1 and ws.cell(row=1, column=1).value is None:
            r0 = 1
        else:
            r0 = ws.max_row + 2
        ncols = len(cabecalho)
        thin = Side(style="thin", color=self.pal["borda"])
        # cabeçalho
        head_fill = PatternFill("solid", fgColor=self.pal["tinta"])
        for j, nome in enumerate(cabecalho, start=1):
            c = ws.cell(row=r0, column=j, value=limpa_texto(nome))
            c.font = Font(name=self.fonte, size=10.5, bold=True, color=self.pal["branco"])
            c.fill = head_fill
            c.alignment = Alignment(horizontal="center", vertical="center")
            c.border = Border(bottom=Side(style="medium", color=self.pal["latao"]))
        ws.row_dimensions[r0].height = 20
        # dados
        n = len(linhas)
        zebra_fill = PatternFill("solid", fgColor=self.pal["suave"])
        for i, linha in enumerate(linhas):
            r = r0 + 1 + i
            eh_total = total and i == n - 1
            zebra = (not eh_total) and n >= 6 and (i % 2 == 1)
            for j, val in enumerate(linha, start=1):
                val = limpa_texto(val)
                c = ws.cell(row=r, column=j, value=val)
                c.font = Font(name=self.fonte, size=10.5, bold=eh_total,
                              color=self.pal["tinta"] if eh_total else self.pal["corpo"])
                if eh_total:
                    c.fill = zebra_fill
                    c.border = Border(top=Side(style="medium", color=self.pal["latao"]),
                                      bottom=thin)
                else:
                    if zebra:
                        c.fill = zebra_fill
                    c.border = Border(bottom=thin)
                # Robustez: uma linha pode vir com MAIS valores que o cabeçalho
                # (erro comum do modelo). Nesse caso a célula extra é escrita sem
                # formato especial — nunca deixamos um IndexError derrubar a
                # geração inteira do arquivo.
                col_nome = cabecalho[j - 1] if j - 1 < len(cabecalho) else None
                if col_nome in moeda:
                    c.number_format = MOEDA_FMT
                elif col_nome in pct:
                    c.number_format = PCT_FMT
                elif col_nome in milhar:
                    c.number_format = MILHAR_FMT
                c.alignment = Alignment(horizontal="right" if _num(val) else "left",
                                        vertical="center")
        # largura automática (aproximada), considerando o FORMATO de cada coluna
        # (moeda/%/milhar) — senão a coluna fica curta e o Excel mostra ######.
        def _kind(nome):
            if nome in moeda: return "moeda"
            if nome in pct: return "pct"
            if nome in milhar: return "milhar"
            return None
        for j, nome in enumerate(cabecalho, start=1):
            kind = _kind(nome)
            largura = len(str(nome)) + 2  # cabeçalho em negrito ocupa um pouco mais
            for linha in linhas:
                if j - 1 < len(linha):
                    largura = max(largura, _texto_exibido(linha[j - 1], kind))
            L = get_column_letter(j)
            nova = min(52, max(10, largura + 3))
            # No Excel a largura é UMA por coluna: se outra tabela já usa esta
            # coluna acima, mantém a maior das duas em vez de encolher a anterior.
            atual = ws.column_dimensions[L].width
            ws.column_dimensions[L].width = max(atual or 0, nova)
        # Congela o cabeçalho só da PRIMEIRA tabela da aba: se uma segunda tabela
        # chamasse tabela() de novo, o freeze_panes (propriedade única da aba)
        # pulava para o cabeçalho dela e escondia a primeira. Não sobrescreve.
        if congelar and ws.freeze_panes is None:
            ws.freeze_panes = ws.cell(row=r0 + 1, column=1)
        return {"ws": ws, "r0": r0, "r1": r0 + n, "c0": 1, "c1": ncols,
                "cols": list(cabecalho), "total": bool(total)}

    def _idx(self, info, nome):
        # Mensagem clara quando o 2º argumento do gráfico não é o dict retornado
        # por p.tabela(...) — evita um TypeError opaco e ajuda a corrigir.
        if not isinstance(info, dict) or "cols" not in info:
            raise ValueError(
                "grafico_*: passe como 2º argumento o dict retornado por "
                "p.tabela(...) (o 'info'), não uma lista/tabela crua.")
        cols = info["cols"]
        if nome not in cols:
            raise ValueError(
                "grafico_*: coluna '%s' não existe no cabecalho %s" % (nome, cols))
        return cols.index(nome) + 1

    # ---------- aba-painel ----------
    def painel(self, titulo, kpis=None, nome="Resumo", atualizado=None, largura_cols=12):
        """Cria a aba-resumo na PRIMEIRA posição: título, carimbo do emissor,
        cartões de KPI e área livre para gráficos (`grafico_*(painel, info,
        ..., anchor="B10")`).

        Existe porque quem abre a planilha cai na primeira aba: sem o painel,
        isso é a base de dados crua. `kpis` = [(valor, rótulo), ...] — o valor
        pode ser texto já formatado ("R$ 2,41 mi") ou número."""
        limpo = re.sub(r"[:\\/?*\[\]]", "-", limpa_texto(str(nome))).strip() or "Resumo"
        ws = self.wb.create_sheet(title=limpo[:31], index=0)
        ws.sheet_view.showGridLines = False
        ws.column_dimensions["A"].width = 2.5
        ncols = max(8, largura_cols)
        for j in range(2, ncols + 2):
            ws.column_dimensions[get_column_letter(j)].width = 12
        c = ws.cell(row=2, column=2, value=limpa_texto(titulo))
        c.font = Font(name=self.fonte_titulo, size=17, bold=True, color=self.pal["tinta"])
        c.alignment = Alignment(horizontal="left", vertical="center")
        ws.merge_cells(start_row=2, start_column=2, end_row=2, end_column=ncols + 1)
        ws.row_dimensions[2].height = 30
        carimbo = " · ".join(x for x in (
            (self.emissor or "").upper(),
            ("ATUALIZADO EM " + str(atualizado)) if atualizado else "") if x)
        if carimbo:
            c3 = ws.cell(row=3, column=2, value=carimbo)
            c3.font = Font(name=self.fonte, size=8, bold=True, color=self.pal["latao"])
            ws.merge_cells(start_row=3, start_column=2, end_row=3, end_column=ncols + 1)
        filete = Side(style="medium", color=self.pal["tinta"])
        for j in range(2, ncols + 2):
            ws.cell(row=3, column=j).border = Border(bottom=filete)
        if kpis:
            r0, col = 5, 2
            fill = PatternFill("solid", fgColor=self.pal["suave"])
            topo = Side(style="thick", color=self.pal["latao"])
            for valor, rotulo in kpis:
                c0, c1 = col, col + 2
                for rr in range(r0, r0 + 3):
                    for cc in range(c0, c1 + 1):
                        cel = ws.cell(row=rr, column=cc)
                        cel.fill = fill
                        if rr == r0:
                            cel.border = Border(top=topo)
                ws.merge_cells(start_row=r0, start_column=c0, end_row=r0 + 1, end_column=c1)
                cv = ws.cell(row=r0, column=c0, value=limpa_texto(valor))
                cv.font = Font(name=self.fonte_titulo, size=16, bold=True, color=self.pal["tinta"])
                cv.alignment = Alignment(horizontal="left", vertical="center", indent=1)
                ws.merge_cells(start_row=r0 + 2, start_column=c0, end_row=r0 + 2, end_column=c1)
                cr = ws.cell(row=r0 + 2, column=c0, value=limpa_texto(str(rotulo)).upper())
                cr.font = Font(name=self.fonte, size=7.5, bold=True, color=self.pal["cinza"])
                cr.alignment = Alignment(horizontal="left", vertical="top", indent=1)
                col = c1 + 2  # uma coluna de respiro entre cartões
            ws.row_dimensions[r0].height = 20
            ws.row_dimensions[r0 + 1].height = 16
            ws.row_dimensions[r0 + 2].height = 16
        return ws

    # ---------- gráficos ----------
    def grafico_barras(self, ws, info, categoria, valor, titulo="", anchor=None):
        return self._grafico(BarChart(), ws, info, categoria, valor, titulo, anchor)

    def grafico_linhas(self, ws, info, categoria, valor, titulo="", anchor=None):
        return self._grafico(LineChart(), ws, info, categoria, valor, titulo, anchor)

    def grafico_pizza(self, ws, info, categoria, valor, titulo="", anchor=None):
        return self._grafico(PieChart(), ws, info, categoria, valor, titulo, anchor)

    def _tema(self, chart, npontos):
        """Pinta o gráfico com as cores da identidade.

        `DataPoint(graphicalProperties=...)` levanta TypeError — o argumento do
        construtor é `spPr`; `graphicalProperties` só existe como alias de
        LEITURA. Com o erro engolido em silêncio, a pizza saía com a paleta
        padrão do Excel e ninguém percebia."""
        try:
            if isinstance(chart, PieChart):
                pontos = []
                for i in range(max(0, npontos)):
                    gp = GraphicalProperties(solidFill=CORES_GRAF[i % len(CORES_GRAF)])
                    gp.line.solidFill = "FFFFFF"
                    pontos.append(DataPoint(idx=i, spPr=gp))
                if chart.series:
                    chart.series[0].data_points = pontos
            elif isinstance(chart, LineChart):
                for i, s in enumerate(chart.series):
                    s.graphicalProperties = GraphicalProperties()
                    s.graphicalProperties.line.solidFill = CORES_GRAF[i % len(CORES_GRAF)]
                    s.graphicalProperties.line.width = 28575  # ~2,25 pt
                    s.smooth = False
            else:
                for i, s in enumerate(chart.series):
                    s.graphicalProperties = GraphicalProperties(
                        solidFill=CORES_GRAF[i % len(CORES_GRAF)])
                if hasattr(chart, "gapWidth"):
                    chart.gapWidth = 60
        except Exception as e:
            # O estilo nunca derruba a geração do arquivo — mas o silêncio
            # total já escondeu um gráfico saindo com a cor padrão. Avisa.
            warnings.warn("xlspro: tema do gráfico não aplicado (%r)" % (e,))

    def _grafico(self, chart, ws, info, categoria, valor, titulo, anchor):
        """`ws` é a aba de DESTINO (pode ser o painel); os dados vêm sempre de
        `info["ws"]`, a aba onde a tabela foi escrita."""
        cat_c = self._idx(info, categoria)
        val_c = self._idx(info, valor)
        # Exclui a linha de TOTAL do gráfico: senão ela vira uma fatia/barra
        # gigante (= soma de todas as outras) que distorce a leitura. info["r1"]
        # é a última linha de dados; se a tabela tem TOTAL, ela é essa última.
        last = info["r1"] - (1 if info.get("total") else 0)
        dados = Reference(info["ws"], min_col=val_c, min_row=info["r0"],
                          max_row=last)
        cats = Reference(info["ws"], min_col=cat_c, min_row=info["r0"] + 1,
                         max_row=last)
        chart.add_data(dados, titles_from_data=True)
        chart.set_categories(cats)
        chart.title = titulo or valor
        chart.height = 8
        chart.width = 16
        self._tema(chart, last - info["r0"])
        if not anchor:
            anchor = get_column_letter(info["c1"] + 2) + str(info["r0"])
        ws.add_chart(chart, anchor)
        return chart

    def salvar(self, caminho):
        self.wb.save(caminho)
        return caminho
