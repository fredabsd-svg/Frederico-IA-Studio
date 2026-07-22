import os
import tempfile
import unittest
import zipfile

from openpyxl import load_workbook

from xlspro import MOEDA_FMT, Planilha


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


if __name__ == "__main__":
    unittest.main()
