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

    def test_corpo_titulo_e_tabela_usam_a_mesma_aresta_esquerda(self):
        """O mesmo contrato do pdfpro, agora no Word: título com barra, corpo,
        lista e primeira coluna da tabela começam todos em RECUO_PT. Antes o
        título nascia 10 pt à direita do corpo (que não tinha recuo) e a célula
        6 pt à esquerda dele — três arestas na mesma página."""
        r = docpro.Relatorio("T")
        r.titulo("1. Seção")
        r.paragrafo("Um parágrafo do corpo.")
        r.lista(["item um", "item dois"])
        r.tabela(["Campo", "Valor"], [["CNPJ", "00.000.000/0001-00"]])
        r.callout("NOTA", "Um aviso.")
        r.salvar(self.path, pdf=False)
        doc = Document(self.path)

        esperado = docpro.RECUO_PT
        titulo, corpo, item = doc.paragraphs[0], doc.paragraphs[1], doc.paragraphs[2]
        self.assertEqual(titulo.paragraph_format.left_indent.pt, esperado)
        self.assertEqual(corpo.paragraph_format.left_indent.pt, esperado)
        # a lista pendura o marcador: recuo + 14, primeira linha -14 => RECUO_PT
        self.assertEqual(item.paragraph_format.left_indent.pt
                         + item.paragraph_format.first_line_indent.pt, esperado)

        def margem_esquerda(cell):
            mar = cell._tc.tcPr.find(qn("w:tcMar"))
            return int(mar.find(qn("w:start")).get(qn("w:w"))) / 20.0

        tabela = doc.tables[0]
        self.assertEqual(margem_esquerda(tabela.rows[0].cells[0]), esperado)
        self.assertEqual(margem_esquerda(tabela.rows[1].cells[0]), esperado)
        callout = doc.tables[1]
        self.assertEqual(margem_esquerda(callout.rows[0].cells[0]), esperado)

    def test_caractere_de_controle_nao_corrompe_o_arquivo(self):
        """Caractere de controle é ilegal em XML 1.0: gravado cru, o Word
        recusa o arquivo. O kit remove antes de criar o run."""
        r = docpro.Relatorio("T")
        r.paragrafo("texto com \x07 sinal e \x00 nulo")
        r.tabela(["A"], [["valor \x1f estranho"]])
        r.salvar(self.path, pdf=False)
        doc = Document(self.path)  # reabre: prova que o XML é válido
        self.assertNotIn("\x07", doc.paragraphs[0].text)
        self.assertIn("texto com", doc.paragraphs[0].text)

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
