import os
import tempfile
import unittest
import zipfile

try:
    from openpyxl import load_workbook

    from xlspro import CORES_GRAF, MOEDA_FMT, Planilha

    TEM_OPENPYXL = True
except Exception:  # openpyxl ausente no ambiente — o CI e o sandbox o instalam
    TEM_OPENPYXL = False


@unittest.skipUnless(TEM_OPENPYXL, "openpyxl não instalado")
class XlsProArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="frederico-xlsx-")
        self.path = os.path.join(self.tmp.name, "fluxo_caixa.xlsx")

    def tearDown(self):
        self.tmp.cleanup()

    def _create_workbook(self):
        planilha = Planilha()
        ws = planilha.aba("Fluxo de Caixa")
        planilha.titulo(ws, "Fluxo de Caixa — Auditoria")
        rows = [
            ["Jan", 12500.0, 7100.0, "=B4-C4"],
            ["Fev", 13800.0, 7650.0, "=B5-C5"],
            ["Mar", 14250.0, 8000.0, "=B6-C6"],
            ["TOTAL", "=SUM(B4:B6)", "=SUM(C4:C6)", "=SUM(D4:D6)"],
        ]
        info = planilha.tabela(
            ws,
            ["Mês", "Entradas", "Saídas", "Saldo"],
            rows,
            inicio=3,
            moeda=["Entradas", "Saídas", "Saldo"],
            total=True,
        )
        planilha.grafico_barras(ws, info, "Mês", "Saldo", "Saldo mensal")
        planilha.salvar(self.path)

    def test_cria_xlsx_real_com_formula_estilo_congelamento_e_grafico(self):
        self._create_workbook()
        self.assertTrue(zipfile.is_zipfile(self.path))
        workbook = load_workbook(self.path, data_only=False)
        ws = workbook["Fluxo de Caixa"]
        self.assertEqual(ws["D4"].value, "=B4-C4")
        self.assertEqual(ws["D7"].value, "=SUM(D4:D6)")
        self.assertEqual(ws["B4"].number_format, MOEDA_FMT)
        self.assertEqual(ws.freeze_panes, "A4")
        self.assertFalse(ws.sheet_view.showGridLines)
        self.assertEqual(len(ws._charts), 1)

    def test_cinco_etapas_reabrem_e_preservam_o_mesmo_artefato(self):
        self._create_workbook()
        for stage in range(1, 6):
            workbook = load_workbook(self.path, data_only=False)
            audit = workbook.create_sheet(f"Revisão {stage}")
            audit["A1"] = "Etapa"
            audit["B1"] = stage
            audit["A2"] = "Artefato preservado"
            audit["B2"] = True
            workbook.save(self.path)

            reopened = load_workbook(self.path, data_only=False)
            self.assertEqual(reopened["Fluxo de Caixa"]["D4"].value, "=B4-C4")
            self.assertEqual(len(reopened["Fluxo de Caixa"]._charts), 1)
            for previous in range(1, stage + 1):
                self.assertIn(f"Revisão {previous}", reopened.sheetnames)

    def test_linha_maior_que_cabecalho_nao_corrompe_a_geracao(self):
        planilha = Planilha()
        ws = planilha.aba("Dados")
        planilha.tabela(ws, ["A", "B"], [[1, 2, 3], [4, 5, 6]])
        planilha.salvar(self.path)
        workbook = load_workbook(self.path)
        self.assertEqual(workbook["Dados"]["C2"].value, 3)

    def test_grafico_rejeita_contrato_invalido_com_erro_claro(self):
        planilha = Planilha()
        ws = planilha.aba("Dados")
        with self.assertRaisesRegex(ValueError, "dict retornado"):
            planilha.grafico_barras(ws, [["A", "B"]], "A", "B")

    def test_coluna_de_moeda_larga_o_suficiente_para_o_valor_formatado(self):
        # "R$ 15.015,00" tem 12 caracteres; a largura da coluna precisa comportar
        # o TEXTO EXIBIDO (não o valor bruto 15015.0), senão o Excel mostra ######.
        planilha = Planilha()
        ws = planilha.aba("V")
        planilha.tabela(ws, ["Item", "Total"],
                        [["Serviço A", 15015.0], ["Serviço B", 2670.0]],
                        moeda=["Total"])
        planilha.salvar(self.path)
        wb = load_workbook(self.path)
        self.assertGreaterEqual(wb["V"].column_dimensions["B"].width, 12)

    def test_segunda_tabela_respira_e_nao_rouba_o_congelamento(self):
        planilha = Planilha()
        ws = planilha.aba("V")
        planilha.titulo(ws, "Título")
        i1 = planilha.tabela(ws, ["A", "B"], [["x", 1.0]])
        i2 = planilha.tabela(ws, ["A", "B"], [["y", 2.0]])
        planilha.salvar(self.path)
        wb = load_workbook(self.path)
        ws2 = wb["V"]
        # título na linha 1 → 1ª tabela respira até a linha 3 (linha 2 em branco)
        self.assertEqual(i1["r0"], 3)
        # 2ª tabela deixa 1 linha em branco depois da 1ª (não cola no conteúdo)
        self.assertGreater(i2["r0"], i1["r1"] + 1)
        # congelamento permanece no cabeçalho da 1ª tabela (não pula p/ a 2ª)
        self.assertEqual(ws2.freeze_panes, "A4")

    def test_largura_de_coluna_compartilhada_pega_a_maior(self):
        # Duas tabelas empilhadas nas mesmas colunas: a coluna tem UMA largura;
        # ela deve caber o maior conteúdo das duas, não encolher para a última.
        planilha = Planilha()
        ws = planilha.aba("V")
        planilha.tabela(ws, ["A", "B"], [["Mesa de escritório grande", 1.0]])
        planilha.tabela(ws, ["A", "B"], [["curto", 2.0]])
        planilha.salvar(self.path)
        wb = load_workbook(self.path)
        self.assertGreaterEqual(wb["V"].column_dimensions["A"].width, len("Mesa de escritório grande"))


    def test_caractere_de_controle_nao_derruba_a_planilha(self):
        """O openpyxl levanta IllegalCharacterError ao gravar caractere de
        controle. Uma célula suja vinda de PDF ou CSV derrubava a geração
        inteira — agora ela é limpa antes de ser escrita."""
        p = Planilha()
        ws = p.aba("Da\x07dos")
        p.titulo(ws, "T\x00ítulo")
        p.tabela(ws, ["Produto", "Qtd"], [["A\x1fB", 3], ["C", 4]])
        p.salvar(self.path)
        from openpyxl import load_workbook
        wb = load_workbook(self.path)
        aba = wb[wb.sheetnames[0]]
        self.assertNotIn("\x07", wb.sheetnames[0])
        textos = [c.value for row in aba.iter_rows() for c in row if isinstance(c.value, str)]
        self.assertTrue(any("AB" == t for t in textos), textos)

    def test_nome_de_aba_invalido_e_corrigido(self):
        p = Planilha()
        ws = p.aba("Vendas/2025: resumo [final]")
        self.assertNotIn("/", ws.title)
        self.assertNotIn(":", ws.title)
        self.assertLessEqual(len(ws.title), 31)

    # ---------- aba-painel e identidade "Tinta & Latão" ----------
    def test_painel_vira_a_primeira_aba_com_os_kpis_e_o_carimbo(self):
        """Quem abre a planilha cai na PRIMEIRA aba: sem o painel, isso é a
        base de dados crua."""
        p = Planilha(emissor="Frederico Assessoria Contábil")
        ws = p.aba("Vendas")
        p.tabela(ws, ["Produto", "Total"], [["Malha", 5400.0], ["Oxford", 6000.0]],
                 moeda=["Total"])
        p.painel("Painel — Vendas 2025",
                 kpis=[("R$ 11,4 mil", "Faturamento"), (2, "Produtos")],
                 atualizado="27/07/2026")
        p.salvar(self.path)
        wb = load_workbook(self.path)
        self.assertEqual(wb.sheetnames[0], "Resumo")
        textos = [c.value for row in wb["Resumo"].iter_rows()
                  for c in row if c.value is not None]
        self.assertIn("Painel — Vendas 2025", textos)
        self.assertIn("R$ 11,4 mil", textos)
        self.assertIn("FATURAMENTO", textos)
        carimbo = [t for t in textos if isinstance(t, str) and "ATUALIZADO EM" in t]
        self.assertEqual(len(carimbo), 1)
        self.assertIn("FREDERICO ASSESSORIA CONTÁBIL", carimbo[0])

    def test_grafico_no_painel_le_os_dados_da_aba_de_origem(self):
        """O gráfico mora no painel, mas as células referenciadas têm de ser as
        da aba de dados — senão sai vazio."""
        p = Planilha()
        ws = p.aba("Vendas")
        info = p.tabela(ws, ["Produto", "Total"],
                        [["Malha", 5400.0], ["Oxford", 6000.0], ["TOTAL", 11400.0]],
                        moeda=["Total"], total=True)
        painel = p.painel("Painel", kpis=[("R$ 11,4 mil", "Faturamento")])
        p.grafico_barras(painel, info, "Produto", "Total", "Total por produto",
                         anchor="B10")
        p.salvar(self.path)
        wb = load_workbook(self.path)
        self.assertEqual(len(wb["Resumo"]._charts), 1)
        self.assertEqual(len(wb["Vendas"]._charts), 0)
        ref = str(wb["Resumo"]._charts[0].series[0].val.numRef.f)
        self.assertIn("Vendas", ref)
        # a linha de TOTAL fica FORA do gráfico (senão achata as outras barras)
        self.assertTrue(ref.endswith("$3"), ref)

    def test_graficos_saem_com_as_cores_do_tema(self):
        """Regressão silenciosa: `DataPoint(graphicalProperties=...)` levanta
        TypeError (o argumento é `spPr`) e, com o erro engolido, a pizza saía
        com a paleta padrão do Excel."""
        p = Planilha()
        ws = p.aba("Vendas")
        info = p.tabela(ws, ["Produto", "Total"],
                        [["Malha", 5400.0], ["Oxford", 6000.0], ["Linho", 4700.0]],
                        moeda=["Total"])
        p.grafico_pizza(ws, info, "Produto", "Total", "Participação", anchor="E2")
        p.grafico_barras(ws, info, "Produto", "Total", "Total", anchor="E20")
        p.salvar(self.path)
        wb = load_workbook(self.path)
        pizza, barras = wb["Vendas"]._charts[0], wb["Vendas"]._charts[1]

        def cor(spPr):  # openpyxl devolve str ou ColorChoice conforme o caminho
            fill = spPr.solidFill
            if not isinstance(fill, str):
                fill = fill.srgbClr
            return fill if isinstance(fill, str) else fill.value

        pontos = pizza.series[0].data_points
        self.assertEqual(len(pontos), 3)
        self.assertEqual([cor(d.graphicalProperties) for d in pontos], CORES_GRAF[:3])
        self.assertEqual(cor(barras.series[0].graphicalProperties), CORES_GRAF[0])


if __name__ == "__main__":
    unittest.main()
