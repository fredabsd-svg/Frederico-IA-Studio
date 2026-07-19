"""xlspro — kit de DESIGN profissional para planilhas Excel (.xlsx) com openpyxl.

Instalado no sandbox do Frederico AI Studio. Dá tabelas com cabeçalho colorido,
zebra, bordas horizontais discretas, formatos de número (R$, %, milhar), linha
de TOTAL, congelamento do cabeçalho, largura de coluna automática, título de
aba, múltiplas abas e gráficos — no mesmo padrão visual do docpro.

Uso mínimo:
    from xlspro import Planilha
    p = Planilha()
    ws = p.aba("Vendas")
    p.titulo(ws, "Relatório de Vendas — 2025")
    info = p.tabela(ws, ["Produto", "Qtd", "Preço", "Total"], linhas,
                    moeda=["Preço", "Total"], total=True)   # última linha = TOTAL
    p.grafico_barras(ws, info, categoria="Produto", valor="Total", titulo="Total por produto")
    p.salvar("/workspace/outputs/vendas.xlsx")
"""
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, LineChart, PieChart, Reference

PALETA = {
    "primaria": "1A3C6E", "apoio": "2E75B6", "corpo": "262626",
    "cinza": "595959", "suave": "F2F6FA", "borda": "D9E2EC", "branco": "FFFFFF",
}
MOEDA_FMT = 'R$ #,##0.00'
PCT_FMT = '0.0%'
MILHAR_FMT = '#,##0'


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class Planilha:
    def __init__(self, cor_marca=None):
        self.wb = Workbook()
        self.wb.remove(self.wb.active)  # começa sem abas; use .aba()
        self.pal = dict(PALETA)
        if cor_marca:
            self.pal["primaria"] = str(cor_marca).lstrip("#")
        self.fonte = "Calibri"

    def aba(self, nome):
        ws = self.wb.create_sheet(title=str(nome)[:31])
        ws.sheet_view.showGridLines = False
        return ws

    def titulo(self, ws, texto, colspan=6, linha=1):
        c = ws.cell(row=linha, column=1, value=texto)
        c.font = Font(name=self.fonte, size=16, bold=True, color=self.pal["primaria"])
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
        r0 = inicio or (ws.max_row + 1 if ws.max_row > 1 else (ws.max_row + 1))
        if ws.max_row == 1 and ws.cell(row=1, column=1).value is None:
            r0 = 1
        ncols = len(cabecalho)
        thin = Side(style="thin", color=self.pal["borda"])
        # cabeçalho
        head_fill = PatternFill("solid", fgColor=self.pal["primaria"])
        for j, nome in enumerate(cabecalho, start=1):
            c = ws.cell(row=r0, column=j, value=nome)
            c.font = Font(name=self.fonte, size=11, bold=True, color=self.pal["branco"])
            c.fill = head_fill
            c.alignment = Alignment(horizontal="center", vertical="center")
            c.border = Border(bottom=Side(style="medium", color=self.pal["primaria"]))
        ws.row_dimensions[r0].height = 20
        # dados
        n = len(linhas)
        zebra_fill = PatternFill("solid", fgColor=self.pal["suave"])
        for i, linha in enumerate(linhas):
            r = r0 + 1 + i
            eh_total = total and i == n - 1
            zebra = (not eh_total) and n >= 6 and (i % 2 == 1)
            for j, val in enumerate(linha, start=1):
                c = ws.cell(row=r, column=j, value=val)
                c.font = Font(name=self.fonte, size=11, bold=eh_total,
                              color=self.pal["corpo"])
                if eh_total:
                    c.fill = zebra_fill
                    c.border = Border(top=Side(style="medium", color=self.pal["primaria"]),
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
        # largura automática (aproximada)
        for j, nome in enumerate(cabecalho, start=1):
            largura = len(str(nome))
            for i, linha in enumerate(linhas):
                if j - 1 < len(linha):
                    largura = max(largura, len(str(linha[j - 1])))
            ws.column_dimensions[get_column_letter(j)].width = min(48, max(10, largura + 4))
        if congelar:
            ws.freeze_panes = ws.cell(row=r0 + 1, column=1)
        return {"ws": ws, "r0": r0, "r1": r0 + n, "c0": 1, "c1": ncols,
                "cols": list(cabecalho)}

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

    def grafico_barras(self, ws, info, categoria, valor, titulo="", anchor=None):
        self._grafico(BarChart(), ws, info, categoria, valor, titulo, anchor)

    def grafico_linhas(self, ws, info, categoria, valor, titulo="", anchor=None):
        self._grafico(LineChart(), ws, info, categoria, valor, titulo, anchor)

    def grafico_pizza(self, ws, info, categoria, valor, titulo="", anchor=None):
        self._grafico(PieChart(), ws, info, categoria, valor, titulo, anchor)

    def _grafico(self, chart, ws, info, categoria, valor, titulo, anchor):
        cat_c = self._idx(info, categoria)
        val_c = self._idx(info, valor)
        # exclui a linha de TOTAL do gráfico (min_row = primeira linha de dados)
        dados = Reference(info["ws"], min_col=val_c, min_row=info["r0"],
                          max_row=info["r1"])
        cats = Reference(info["ws"], min_col=cat_c, min_row=info["r0"] + 1,
                         max_row=info["r1"])
        chart.add_data(dados, titles_from_data=True)
        chart.set_categories(cats)
        chart.title = titulo or valor
        chart.height = 8
        chart.width = 16
        if not anchor:
            anchor = get_column_letter(info["c1"] + 2) + str(info["r0"])
        ws.add_chart(chart, anchor)
        return chart

    def salvar(self, caminho):
        self.wb.save(caminho)
        return caminho
