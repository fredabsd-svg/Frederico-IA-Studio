import os
import tempfile
import unittest
import zipfile

try:
    from docx import Document
    from docx.oxml.ns import qn
    from docx.shared import Cm

    import docpro

    HAS_DOCX = True
except Exception:  # python-docx ausente no ambiente
    HAS_DOCX = False

try:
    import matplotlib  # noqa: F401

    HAS_MPL = True
except Exception:  # matplotlib ausente (CI enxuta) — só os gráficos dependem dele
    HAS_MPL = False

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

    def test_nenhuma_tabela_vaza_a_margem(self):
        """Duas estratégias legítimas: 100% da área útil (`_fit`) ou largura
        FIXA declarada em dxa (`_fixa`, dos KPIs/linha do tempo/assinaturas).
        O que não pode existir é tabela sem largura declarada — é ela que vaza
        para fora da margem quando o conteúdo cresce."""
        r = docpro.Relatorio("T", cliente="ACME", emissor="Escritório")
        r.capa()
        r.tabela(["A", "B"], [["1", "2"]])
        r.kpis([("R$ 5M", "Capital"), ("ATIVA", "Situação")])
        r.etapas([("Diagnóstico", "ago/2026"), ("Implantação", "out/2026")])
        r.citacao("Frase.", "Fonte")
        r.assinaturas(["Nome"], cargos=["Cargo"])
        r.contracapa(contatos=["contato@empresa.com.br"])
        r.salvar(self.path, pdf=False)
        doc = Document(self.path)
        util = Cm(21.0 - 2 * 2.0).twips
        self.assertGreaterEqual(len(doc.tables), 6)
        for t in doc.tables:
            tblW = t._tbl.tblPr.find(qn("w:tblW"))
            self.assertIsNotNone(tblW, "toda tabela deve ter largura preferida")
            tipo = tblW.get(qn("w:type"))
            self.assertIn(tipo, ("pct", "dxa"))
            if tipo == "pct":
                self.assertEqual(tblW.get(qn("w:w")), "5000")
            else:
                self.assertLessEqual(int(tblW.get(qn("w:w"))), util)

    def test_tabela_de_largura_fixa_traz_a_grade_coerente(self):
        """Em layout fixo o Word resolve as colunas pela <w:tblGrid>. Se ela
        ficar com a grade herdada do python-docx (colunas iguais, somando mais
        que a área útil), a tabela vaza mesmo com cada célula medida a uma.
        É o caso da linha do tempo e das assinaturas, que precisam de colunas
        de larguras diferentes."""
        r = docpro.Relatorio("T")
        r.etapas([("Diagnóstico", "ago/2026"), ("Implantação", "out/2026")])
        r.salvar(self.path, pdf=False)
        t = Document(self.path).tables[0]
        tblW = t._tbl.tblPr.find(qn("w:tblW"))
        self.assertEqual(tblW.get(qn("w:type")), "dxa")
        grid = t._tbl.find(qn("w:tblGrid"))
        soma = sum(int(g.get(qn("w:w"))) for g in grid.findall(qn("w:gridCol")))
        self.assertEqual(int(tblW.get(qn("w:w"))), soma)
        self.assertLessEqual(soma, Cm(17.0).twips)

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
        r.titulo("Seção")
        r.paragrafo("Um parágrafo do corpo.")
        r.lista(["item um", "item dois"])
        r.tabela(["Campo", "Valor"], [["CNPJ", "00.000.000/0001-00"]])
        r.callout("NOTA", "Um aviso.")
        r.salvar(self.path, pdf=False)
        doc = Document(self.path)

        esperado = docpro.RECUO_PT
        # Busca por texto, não por índice: o título de nível 1 emite ANTES o
        # kicker ("SEÇÃO 01"), e ele também tem de pousar na mesma aresta.
        def paragrafo(texto):
            return next(p for p in doc.paragraphs if p.text.strip() == texto)

        for texto in ("SEÇÃO 01", "Seção", "Um parágrafo do corpo."):
            self.assertEqual(paragrafo(texto).paragraph_format.left_indent.pt, esperado,
                             "fora da aresta: %r" % texto)
        # a lista pendura o marcador: recuo + 14, primeira linha -14 => RECUO_PT
        item = paragrafo("• item um")
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

    # ---------- identidade "Tinta & Latão" e blocos editoriais ----------
    def test_titulo_numera_a_secao_sozinho(self):
        """O prompt manda escrever só o texto do título: a numeração é do kit.
        Se ela parar de sair, o documento perde a hierarquia — e se sair EM
        DOBRO, o modelo volta a escrever "1." no texto."""
        r = docpro.Relatorio("T")
        r.titulo("Dados cadastrais")
        r.titulo("Indicadores")
        r.titulo("Detalhe", nivel=2)
        r.titulo("Anexo", kicker="ANEXO A")
        r.salvar(self.path, pdf=False)
        textos = [p.text for p in Document(self.path).paragraphs]
        self.assertIn("SEÇÃO 01", textos)
        self.assertIn("SEÇÃO 02", textos)
        self.assertIn("ANEXO A", textos)
        self.assertNotIn("SEÇÃO 03", textos)  # nível 2 não consome numeração

    def test_sumario_lista_as_entradas_com_a_pagina(self):
        r = docpro.Relatorio("T")
        r.sumario([("Sumário executivo", 3), ("Indicadores", 4)])
        r.salvar(self.path, pdf=False)
        textos = "\n".join(p.text for p in Document(self.path).paragraphs)
        self.assertIn("SUMÁRIO", textos)
        self.assertIn("Sumário executivo", textos)
        self.assertIn("01", textos)
        self.assertIn("3", textos)

    def test_confidencial_marca_o_rodape_e_pode_ser_desligado(self):
        for confidencial in (True, False):
            r = docpro.Relatorio("T", emissor="Escritório", confidencial=confidencial)
            r.capa()
            r.salvar(self.path, pdf=False)
            rodape = Document(self.path).sections[-1].footer.paragraphs[0].text
            if confidencial:
                self.assertIn("CONFIDENCIAL", rodape)
            else:
                self.assertNotIn("CONFIDENCIAL", rodape)

    def test_blocos_editoriais_novos_entram_no_documento(self):
        r = docpro.Relatorio("T", emissor="Escritório")
        r.citacao("Frase-chave do documento.", "Sumário executivo")
        r.etapas([("Diagnóstico", "ago/2026"), ("Implantação", "out/2026")])
        r.tabela(["A", "B"], [["1", "2"]], titulo="Investimento", fonte="Fonte: balancetes.")
        r.assinaturas(["João da Silva", "Maria Oliveira", "Carlos Souza"],
                      cargos=["Contador", "Sócia", "Sócio"],
                      local_data="Palmas/TO, 27 de julho de 2026.")
        r.contracapa(contatos=["contato@empresa.com.br"])
        r.salvar(self.path, pdf=False)
        doc = Document(self.path)
        texto = "\n".join(p.text for p in doc.paragraphs)
        texto += "\n".join(c.text for t in doc.tables for c in t.rows[0].cells)
        for esperado in ("Tabela 1 — Investimento", "Fonte: balancetes.",
                         "Frase-chave", "Diagnóstico", "João da Silva",
                         "contato@empresa.com.br", "Palmas/TO"):
            self.assertIn(esperado, texto)
        # 3 assinaturas => 2 tabelas de pares (2 + 1); nenhuma se perde
        self.assertGreaterEqual(len(doc.tables), 6)

    @unittest.skipUnless(HAS_MPL, "matplotlib não instalado")
    def test_graficos_entram_como_imagem_na_mesma_aresta(self):
        r = docpro.Relatorio("T")
        r.grafico_barras(["2024", "2025"], {"Receita": [5.2, 5.8]}, titulo="Receita")
        r.grafico_linhas(["Jan", "Fev"], {"Saldo": [1.2, 1.4]}, titulo="Saldo")
        r.grafico_pizza(["Serviços", "Produtos"], [62, 38], titulo="Participação")
        r.salvar(self.path, pdf=False)
        with zipfile.ZipFile(self.path) as z:
            imagens = [n for n in z.namelist() if n.startswith("word/media/")]
        self.assertEqual(len(imagens), 3)
        doc = Document(self.path)
        # A figura respeita a mesma aresta do corpo — senão cria uma 2ª margem.
        com_figura = [p for p in doc.paragraphs if p._p.findall(".//" + qn("w:drawing"))]
        self.assertEqual(len(com_figura), 3)
        for p in com_figura:
            self.assertEqual(p.paragraph_format.left_indent.pt, docpro.RECUO_PT)

    def test_sobrio_identifica_o_documento_e_assina_em_pares_sem_cor(self):
        a = docpro.Sobrio()
        a.identificacao("ATA DE REUNIÃO DE SÓCIOS",
                        "ACME LTDA — CNPJ 00.000.000/0001-00 — NIRE 17.2.0000000-1")
        a.secao("ORDEM DO DIA")
        a.item("1. Aprovação das contas do exercício.")
        a.fecho("Palmas/TO, 27 de julho de 2026.")
        a.assinaturas(["João da Silva", "Maria Oliveira"],
                      subtitulos=["Sócio-administrador", "Sócia"])
        a.salvar(self.path, pdf=False)
        doc = Document(self.path)
        texto = "\n".join(p.text for p in doc.paragraphs)
        texto += "\n".join(c.text for t in doc.tables for c in t.rows[0].cells)
        self.assertIn("ATA DE REUNIÃO DE SÓCIOS", texto)
        self.assertIn("NIRE 17.2.0000000-1", texto)
        self.assertIn("João da Silva", texto)
        # Um par por tabela: seis sócios empilhados um por linha viram três
        # páginas de espaço em branco numa folha registrável.
        self.assertEqual(len(doc.tables), 1)
        util = Cm(21.0 - 3.0 - 2.0).twips
        tblW = doc.tables[0]._tbl.tblPr.find(qn("w:tblW"))
        self.assertEqual(tblW.get(qn("w:type")), "dxa")
        self.assertLessEqual(int(tblW.get(qn("w:w"))), util)
        # documento registrável é 100% preto, inclusive dentro da tabela
        alvos = list(doc.paragraphs)
        for t in doc.tables:
            for row in t.rows:
                for cell in row.cells:
                    alvos.extend(cell.paragraphs)
        for p in alvos:
            for run in p.runs:
                cor = run.font.color
                if cor is not None and cor.rgb is not None:
                    self.assertEqual(str(cor.rgb), "000000")


if __name__ == "__main__":
    unittest.main()
