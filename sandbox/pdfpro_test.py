import os
import tempfile
import unittest

try:
    import pdfpro

    HAS_REPORTLAB = True
except Exception:  # reportlab ausente no ambiente
    HAS_REPORTLAB = False


@unittest.skipUnless(HAS_REPORTLAB, "reportlab não instalado")
class PdfProTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="frederico-pdf-")
        self.path = os.path.join(self.tmp.name, "proposta.pdf")

    def tearDown(self):
        self.tmp.cleanup()

    def _assert_pdf(self, minimo=1200):
        self.assertTrue(os.path.exists(self.path))
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(5), b"%PDF-")
        self.assertGreater(os.path.getsize(self.path), minimo)

    def test_gera_pdf_com_capa_tabela_e_callout(self):
        r = pdfpro.RelatorioPDF(self.path, titulo="Proposta Comercial",
                                cliente="ACME LTDA", emissor="Escritório",
                                subtitulo="Serviços contábeis", tipo="PROPOSTA")
        r.capa()
        r.titulo("1. Escopo")
        r.paragrafo("Texto de escopo do trabalho a ser realizado.")
        r.tabela(["Serviço", "Descrição longa do que será entregue", "Valor"],
                 [["A", "Escrituração completa mensal", "R$ 1.200,00"],
                  ["TOTAL", "", "R$ 1.200,00"]], total=True)
        r.callout("OBSERVAÇÃO", "Proposta válida por 30 dias.")
        r.salvar()
        self._assert_pdf()

    def test_larguras_proporcionais_nao_crasham_com_colunas_desiguais(self):
        r = pdfpro.RelatorioPDF(self.path, titulo="T")
        r.tabela(["Curto", "Coluna com um texto bem mais longo que as outras", "X"],
                 [["a", "conteúdo extenso para pesar a coluna do meio", "1"],
                  ["b", "outra linha comprida com bastante texto aqui", "2"]])
        r.salvar()
        self._assert_pdf(minimo=1000)

    def test_linha_com_menos_valores_que_o_cabecalho_nao_derruba(self):
        r = pdfpro.RelatorioPDF(self.path, titulo="T")
        r.tabela(["A", "B", "C"], [["só um"], ["um", "dois"]])
        r.salvar()
        self._assert_pdf(minimo=800)


if __name__ == "__main__":
    unittest.main()
