import os
import tempfile
import unittest
import zipfile

try:
    from docx import Document
    from docx.oxml.ns import qn

    import docpro

    HAS_DOCX = True
except Exception:  # python-docx ausente no ambiente
    HAS_DOCX = False

# Ordem canônica dos filhos de <w:tblPr> (subconjunto usado pelo kit). Serve para
# provar que a diagramação da tabela gera OOXML válido (fora de ordem, o Word abre
# "reparando" e às vezes perde o estilo).
_TBLPR_ORDER = [
    "tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize",
    "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing", "tblInd",
    "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook",
]


@unittest.skipUnless(HAS_DOCX, "python-docx não instalado")
class DocProTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="frederico-docx-")
        self.path = os.path.join(self.tmp.name, "relatorio.docx")

    def tearDown(self):
        self.tmp.cleanup()

    def _relatorio(self):
        r = docpro.Relatorio(
            "Título Longo do Relatório Gerencial de Situação Fiscal",
            cliente="ACME COMÉRCIO LTDA", emissor="Escritório",
            subtitulo="Exercício 2025", tipo="RELATÓRIO GERENCIAL")
        r.capa()
        r.titulo("1. Itens")
        r.tabela(
            ["Item", "Descrição bem longa do serviço prestado ao cliente", "Valor"],
            [["1", "Consultoria contábil mensal com apuração de tributos", "R$ 1.200,00"],
             ["TOTAL", "", "R$ 1.200,00"]],
            total=True)
        r.kpis([("R$ 5M", "Capital"), ("ATIVA", "Situação")])
        r.callout("RESUMO", "Empresa ativa e adimplente.")
        r.salvar(self.path, pdf=False)
        return self.path

    def test_gera_docx_valido_e_reabre(self):
        self._relatorio()
        self.assertTrue(zipfile.is_zipfile(self.path))
        doc = Document(self.path)  # reabre sem erro de XML
        self.assertGreaterEqual(len(doc.tables), 3)

    def test_tabelas_ocupam_100pct_e_nao_vazam_a_margem(self):
        self._relatorio()
        doc = Document(self.path)
        for t in doc.tables:
            tblW = t._tbl.tblPr.find(qn("w:tblW"))
            self.assertIsNotNone(tblW, "toda tabela deve ter largura preferida")
            self.assertEqual(tblW.get(qn("w:type")), "pct")
            self.assertEqual(tblW.get(qn("w:w")), "5000")

    def test_ordem_do_tblpr_e_valida(self):
        self._relatorio()
        doc = Document(self.path)
        for t in doc.tables:
            tags = [c.tag.split("}")[-1] for c in t._tbl.tblPr]
            idx = [_TBLPR_ORDER.index(x) for x in tags if x in _TBLPR_ORDER]
            self.assertEqual(idx, sorted(idx), tags)

    def test_capa_sem_rodape_na_primeira_pagina(self):
        self._relatorio()
        doc = Document(self.path)
        sec = doc.sections[0]
        self.assertTrue(sec.different_first_page_header_footer)
        self.assertEqual(sec.first_page_footer.paragraphs[0].text.strip(), "")

    def test_linha_com_menos_valores_que_o_cabecalho_nao_derruba(self):
        r = docpro.Relatorio("T")
        r.tabela(["A", "B", "C"], [["só um"], ["um", "dois"]])
        r.salvar(self.path, pdf=False)
        self.assertTrue(zipfile.is_zipfile(self.path))

    def test_sobrio_nasce_justificado_e_sem_cor(self):
        a = docpro.Sobrio()
        a.titulo("ATA DE REUNIÃO DE SÓCIOS")
        a.paragrafo("Aos vinte e cinco dias do mês de outubro ...")
        a.salvar(self.path, pdf=False)
        doc = Document(self.path)
        normal = doc.styles["Normal"].paragraph_format
        # 3 == WD_ALIGN_PARAGRAPH.JUSTIFY
        self.assertEqual(int(normal.alignment), 3)


if __name__ == "__main__":
    unittest.main()
