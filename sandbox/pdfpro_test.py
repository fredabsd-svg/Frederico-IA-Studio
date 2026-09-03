"""Testes do pdfpro.

O que estes testes protegem não é "o arquivo saiu": é o CONTRATO DE LAYOUT. O
relatório que motivou a reescrita do módulo tinha conteúdo certo e construção
errada — seis arestas de texto diferentes na mesma página, 320 marcadores de
lista sem glifo, numeração de página que andava ao passar de 9 para 10 e fonte
não embutida. Cada um desses defeitos tem um teste aqui.
"""
import os
import re
import tempfile
import unittest

try:
    import pdfpro
    from reportlab.pdfbase import pdfmetrics

    TEM_REPORTLAB = True
except Exception:  # reportlab ausente no ambiente
    TEM_REPORTLAB = False


def _posicoes(caminho):
    """Todas as posições (x, y) de texto desenhado no arquivo."""
    with open(caminho, "rb") as f:
        bruto = f.read()
    saida = []
    for conteudo in pdfpro._conteudos(bruto):
        saida.extend(pdfpro.posicoes_de_texto(conteudo))
    return saida


def _por_pagina(caminho):
    with open(caminho, "rb") as f:
        bruto = f.read()
    return [pdfpro.posicoes_de_texto(c) for c in pdfpro._conteudos(bruto)]


def _texto_das_paginas(caminho):
    """Texto de cada página do PDF PRONTO (o que o leitor vê de fato)."""
    from pypdf import PdfReader
    return [(p.extract_text() or "") for p in PdfReader(caminho).pages]


def _textos(flowables):
    """Texto de todo Paragraph da story, entrando nas tabelas (o título e os
    blocos de caixa são Tables com Paragraphs dentro).

    Ler o texto do PDF PRONTO não serve aqui: com a fonte TrueType embutida os
    bytes do stream são índices do subconjunto, não letras."""
    saida = []
    pilha = list(flowables)
    while pilha:
        f = pilha.pop(0)
        if isinstance(f, (list, tuple)):
            pilha = list(f) + pilha
            continue
        texto = getattr(f, "text", None)
        if isinstance(texto, str):
            saida.append(re.sub(r"<[^>]+>", "", texto))
        for atributo in ("_content", "_cellvalues"):
            filhos = getattr(f, atributo, None)
            if filhos:
                pilha = list(filhos) + pilha
    return "\n".join(saida)


@unittest.skipUnless(TEM_REPORTLAB, "reportlab não instalado")
class PdfProTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="frederico-pdf-")
        self.path = os.path.join(self.tmp.name, "doc.pdf")

    def tearDown(self):
        self.tmp.cleanup()

    def _novo(self, **kw):
        """Documento SEM capa, sumário e fechamento automáticos.

        Os presets da v2 acrescentam esses blocos sozinhos; num teste que mede
        UM bloco (a aresta do texto, a numeração da página) eles entrariam como
        páginas a mais e ruído na medição."""
        kw.setdefault("titulo", "Documento de Teste")
        kw.setdefault("capa", False)
        kw.setdefault("sumario", False)
        kw.setdefault("contracapa", False)
        return pdfpro.RelatorioPDF(self.path, **kw)

    def _assert_pdf(self, minimo=1200):
        self.assertTrue(os.path.exists(self.path))
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(5), b"%PDF-")
        self.assertGreater(os.path.getsize(self.path), minimo)

    def _graves(self):
        return [a for a in pdfpro.auditar_pdf(self.path) if a["gravidade"] == "grave"]

    def _bruto(self):
        with open(self.path, "rb") as f:
            return f.read()

    # ------------------------------------------------------------------
    # Documento completo
    # ------------------------------------------------------------------
    def test_documento_completo_passa_na_propria_auditoria(self):
        r = self._novo(titulo="Proposta Comercial", cliente="ACME LTDA",
                       emissor="Escritório", subtitulo="Serviços contábeis",
                       tipo="PROPOSTA")
        r.capa()
        r.titulo("1. Escopo")
        r.paragrafo("Texto de escopo do trabalho a ser realizado.")
        r.lista(["primeiro item", "segundo item"])
        r.kpis([("R$ 5M", "capital"), ("ATIVA", "situação")])
        r.tabela(["Serviço", "Descrição longa do que será entregue", "Valor"],
                 [["A", "Escrituração completa mensal", "R$ 1.200,00"],
                  ["TOTAL", "", "R$ 1.200,00"]], total=True)
        r.callout("OBSERVAÇÃO", "Proposta válida por 30 dias.")
        r.chave_valor([("CNPJ", "00.000.000/0001-00")])
        r.citacao("Uma citação qualquer.", autor="fulano")
        r.codigo("def f(x):\n    return x")
        r.assinaturas(["João da Silva"], subtitulos=["Sócio"])
        r.salvar()                     # salvar() audita por padrão
        self._assert_pdf()
        # "fonte-nao-embutida" é AVISO e só aparece em ambiente sem TTF
        # (a CI enxuta): o que nunca pode sobrar é achado grave.
        self.assertEqual([a for a in r.auditoria if a["gravidade"] == "grave"], [])

    # ------------------------------------------------------------------
    # O contrato de grade: TODO texto alinhado à esquerda começa em X_TEXTO
    # ------------------------------------------------------------------
    def test_cada_bloco_poe_o_texto_na_mesma_aresta(self):
        """O defeito original: título, parágrafo, célula e callout começavam em
        coordenadas diferentes (54,7 / 56,7 / 62,7 / 67,7 / 70,7 / 72,7 pt na
        mesma página). Aqui cada bloco é gerado sozinho e a aresta esquerda do
        seu texto tem de ser exatamente X_TEXTO."""
        blocos = {
            "titulo": lambda r: r.titulo("1. Um título"),
            "titulo_n2": lambda r: r.titulo("1.1 Subtítulo", nivel=2),
            "paragrafo": lambda r: r.paragrafo("Um parágrafo qualquer do corpo."),
            "lista": lambda r: r.lista(["item um", "item dois"]),
            "callout": lambda r: r.callout("NOTA", "Um aviso."),
            "tabela": lambda r: r.tabela(["Coluna", "Outra"], [["a", "b"]]),
            "chave_valor": lambda r: r.chave_valor([("CNPJ", "00.000.000/0001-00")]),
            "citacao": lambda r: r.citacao("Citada.", autor="alguém"),
            "codigo": lambda r: r.codigo("x = 1"),
        }
        for nome, montar in blocos.items():
            with self.subTest(bloco=nome):
                r = self._novo()
                montar(r)
                r.salvar()
                xs = [round(x, 2) for x, _ in _posicoes(self.path)]
                self.assertTrue(xs, "o bloco %s não desenhou texto" % nome)
                self.assertAlmostEqual(
                    min(xs), round(pdfpro.X_TEXTO, 2), places=1,
                    msg="o bloco %s começa em %s; a grade manda começar em %.2f"
                        % (nome, min(xs), pdfpro.X_TEXTO))

    def test_capa_e_rodape_usam_a_mesma_aresta_do_corpo(self):
        r = self._novo(titulo="Relatório", cliente="ACME", emissor="Escritório",
                       subtitulo="assunto", tipo="RELATÓRIO")
        r.capa()
        r.titulo("Escopo")
        r.paragrafo("Um parágrafo de corpo com texto suficiente para a página "
                    "não cair na regra de página em branco da auditoria.")
        r.salvar()
        paginas = _por_pagina(self.path)
        self.assertGreaterEqual(len(paginas), 2)
        capa = [round(x, 2) for x, _ in paginas[0]]
        self.assertAlmostEqual(min(capa), round(pdfpro.X_TEXTO, 2), places=1)
        # rodapé: o texto da faixa inferior também nasce em X_TEXTO
        rodape = [round(x, 2) for x, y in paginas[1] if y < pdfpro.MARGEM["inf"]]
        self.assertTrue(rodape, "a página 2 deveria ter rodapé")
        self.assertAlmostEqual(min(rodape), round(pdfpro.X_TEXTO, 2), places=1)

    def test_numeracao_de_pagina_fecha_sempre_na_mesma_aresta_direita(self):
        """"Página 9 de 12" e "Página 10 de 12" têm larguras diferentes. Com
        `drawString` a borda direita anda — foi o que aconteceu no relatório
        entregue (507,89 pt até a página 9, 503,45 daí em diante)."""
        r = self._novo()
        for i in range(12):
            r.titulo("Seção %d" % (i + 1))
            r.paragrafo("conteúdo")
            r.quebra()
        r.salvar()
        direita_esperada = pdfpro.X_CAIXA + pdfpro.LARGURA_CAIXA - pdfpro.RECUO
        bordas = set()
        for pagina, posicoes in enumerate(_por_pagina(self.path), start=1):
            if pagina == 1:
                continue
            rodape = [x for x, y in posicoes if y < pdfpro.MARGEM["inf"]]
            self.assertTrue(rodape, "página %d sem rodapé" % pagina)
            texto = "Página %d de %d" % (pagina, len(_por_pagina(self.path)))
            largura = pdfmetrics.stringWidth(texto, pdfpro.FONTE, pdfpro.ESCALA["rodape"])
            bordas.add(round(max(rodape) + largura, 1))
        self.assertEqual(len(bordas), 1,
                         "a borda direita da numeração variou: %s" % sorted(bordas))
        self.assertAlmostEqual(bordas.pop(), round(direita_esperada, 1), places=0)

    # ------------------------------------------------------------------
    # Tipografia: nenhum caractere sem glifo
    # ------------------------------------------------------------------
    def test_simbolo_fora_da_fonte_nunca_vira_glifo_invalido(self):
        """O relatório entregue tinha 320 marcadores emitidos como `\\177`
        (DEL) — quadrado preto ou vazio conforme o leitor."""
        r = self._novo()
        r.paragrafo("Internet → app · SVG ← PDF · ✓ pronto · 10 ≥ 5 · a ≠ b · 3 × 4")
        r.lista(["item com ▪ marcador exótico", "outro com ✅ emoji"])
        r.salvar()
        bruto = self._bruto()
        for conteudo in pdfpro._conteudos(bruto):
            for literal in pdfpro._LITERAL.findall(conteudo):
                self.assertNotIn(b"\\177", literal,
                                 "caractere sem glifo chegou ao PDF")

    def test_texto_seguro_troca_o_que_a_fonte_nao_tem(self):
        saida = pdfpro.texto_seguro("a → b")
        self.assertNotIn("\x7f", saida)
        # com fonte embutida a seta passa inteira; sem ela, vira "->".
        # sem fonte embutida a seta vira "->", e o ">" sai escapado como &gt;
        self.assertTrue("→" in saida or "-&gt;" in saida, saida)
        self.assertEqual(pdfpro.texto_seguro("linha1\nlinha2"), "linha1<br/>linha2")

    def test_base14_nao_recebe_caractere_que_o_reportlab_trocaria(self):
        """A checagem ingênua ("cabe em cp1252?") diria que Helvetica desenha o
        bullet — e o reportlab o codifica como \\x7f (DEL), que foi o defeito
        original. Quem responde é o próprio reportlab."""
        self.assertFalse(pdfpro._cobre("Helvetica", "\u2022"),
                         "o bullet em Helvetica sai como DEL")
        self.assertFalse(pdfpro._cobre("Helvetica", "\u2192"),
                         "a seta em Helvetica é redesenhada com ZapfDingbats")
        self.assertTrue(pdfpro._cobre("Helvetica", "\u00e7"))
        self.assertEqual(pdfpro._glifos("\u2022 item \u2192 fim", "Helvetica"),
                         "- item -> fim")

    def test_familia_so_com_regular_e_negrito_ainda_e_aceita(self):
        """fonts-dejavu-core não traz as variantes inclinadas. Exigir as quatro
        descartaria uma fonte utilizável e cairia para a base-14 sem
        necessidade."""
        candidata = [("LiberationSans",
                      "/usr/share/fonts/truetype/liberation/LiberationSans-{}.ttf",
                      {"": "Regular", "-Bold": "Bold"})]
        if not os.path.exists(candidata[0][1].format("Regular")):
            self.skipTest("Liberation Sans ausente neste ambiente")
        normal, negrito, italico = pdfpro._registra_familia(candidata, ("X", "Y", "Z"))
        self.assertEqual(normal, "LiberationSans")
        self.assertEqual(italico, negrito, "sem itálico, o negrito faz as vezes")

    def test_controle_e_marcacao_do_usuario_nao_derrubam_a_geracao(self):
        r = self._novo()
        r.paragrafo("Silva & Cia <precisa> de 3 < 5 & pronto\x07")
        r.tabela(["A & B", "<C>"], [["x & y", "1 < 2"]])
        r.callout("ATENÇÃO & CIA", "Dado com <tag> solta & e-comercial")
        r.salvar()
        self._assert_pdf()

    def test_marcacao_valida_continua_funcionando(self):
        self.assertIn("<b>", pdfpro.texto_seguro("um <b>negrito</b> aqui"))
        self.assertIn("&amp;", pdfpro.texto_seguro("Silva & Cia"))
        self.assertIn("&lt;", pdfpro.texto_seguro("a < b"))
        # entidade já escrita pelo modelo não pode ser escapada duas vezes
        self.assertEqual(pdfpro.texto_seguro("Silva &amp; Cia").count("amp"), 1)

    # ------------------------------------------------------------------
    # Fonte e metadados: compatibilidade em qualquer leitor
    # ------------------------------------------------------------------
    def test_fonte_embutida_com_tounicode_e_metadados(self):
        r = self._novo(titulo="Relatório", emissor="Escritório", assunto="teste")
        r.paragrafo("Ação, çedilha e acentuação.")
        r.salvar()
        bruto = self._bruto()
        if pdfpro.FONTE_EMBUTIDA:
            self.assertIn(b"/FontFile2", bruto, "a fonte deveria estar embutida")
            self.assertIn(b"/ToUnicode", bruto, "sem /ToUnicode não dá para copiar o texto")
        self.assertIn(b"/Title", bruto)
        self.assertIn(b"/Author", bruto)

    # ------------------------------------------------------------------
    # Tabela
    # ------------------------------------------------------------------
    def test_larguras_somam_exatamente_a_largura_util(self):
        r = self._novo()
        larguras = r._larguras(["Nº", "Descrição bem mais longa que as outras", "Valor"],
                               [["1", "conteúdo extenso para pesar a coluna", "R$ 1,00"],
                                ["2", "outra linha comprida", "R$ 2,00"]])
        self.assertAlmostEqual(sum(larguras), pdfpro.LARGURA_CAIXA, places=6)
        self.assertTrue(all(w > 0 for w in larguras))

    def test_cabecalho_curto_nao_quebra_no_meio_da_palavra(self):
        """A largura de uma coluna é a do texto MAIS o seu recuo. Ignorando o
        recuo, "Formato" quebrava em "Format/o" mesmo com espaço sobrando."""
        r = self._novo()
        cabecalho = ["Formato", "O que o kit entrega", "Extensão", "Peso"]
        larguras = r._larguras(cabecalho, [["Word", "Capa e tabelas", ".docx", "180 KB"]])
        recheios = r._recheios(len(cabecalho))
        for j, titulo in enumerate(cabecalho):
            texto = pdfmetrics.stringWidth(titulo, r.fonte_bold, pdfpro.ESCALA["corpo"])
            self.assertGreaterEqual(
                larguras[j] - recheios[j], texto,
                "a coluna %r não cabe seu próprio cabeçalho" % titulo)

    def test_kpis_tem_todos_os_cartoes_da_mesma_altura(self):
        """Cartões como tabelas separadas ficavam com alturas diferentes quando
        um valor era mais curto — ou sumia no saneamento."""
        r = self._novo()
        r.kpis([("806", "testes"), ("", "vazio"), ("R$ 5.000.000,00", "capital")])
        # o bloco vai embrulhado em KeepTogether (não parte entre páginas)
        planos = [g for f in r.story for g in getattr(f, "_content", [f])]
        tabela = [f for f in planos if hasattr(f, "_cellvalues")][0]
        self.assertEqual(len(tabela._cellvalues), 2, "os KPIs são UMA tabela de 2 linhas")
        self.assertEqual(len(set(tabela._colWidths)), 1, "as colunas têm a mesma largura")
        vazio = tabela._cellvalues[0][1].getPlainText().strip()
        self.assertTrue(vazio, "valor vazio deve virar travessão, não cartão em branco")

    def test_coluna_numerica_decidida_pela_maioria_nao_pela_primeira_linha(self):
        r = self._novo()
        # 1ª linha "-" (não numérica) e as demais numéricas: a coluna ainda é
        # de números e tem de ir para a direita.
        r.tabela(["Item", "Valor"], [["a", "-"], ["b", "10"], ["c", "20"], ["d", "30"]])
        r.salvar()
        self._assert_pdf()

    def test_linha_com_numero_de_colunas_diferente_reprova_na_auditoria(self):
        """A v1 completava/cortava a linha em SILÊNCIO. A v2 continua não
        derrubando a geração — o PDF sai — mas a auditoria REPROVA e diz qual
        linha está fora do cabeçalho."""
        r = self._novo()
        r.tabela(["A", "B", "C"], [["só um"], ["um", "dois"], ["um", "dois", "três", "extra"]])
        with self.assertRaises(pdfpro.KitError) as erro:
            r.salvar()
        self.assertIn("linha-fora-do-cabecalho", str(erro.exception))
        self._assert_pdf(minimo=800)

    def test_placeholder_de_rascunho_reprova_na_auditoria(self):
        """"DD/MM/AAAA" numa entrega é o defeito mais barato de evitar e o mais
        constrangedor de deixar passar."""
        r = self._novo()
        r.titulo("Prazo")
        r.paragrafo("O contrato vence em DD/MM/AAAA e será renovado por igual "
                    "período, salvo manifestação em contrário.")
        with self.assertRaises(pdfpro.KitError) as erro:
            r.salvar()
        self.assertIn("placeholder", str(erro.exception))

    def test_tabela_longa_nao_estoura_a_margem(self):
        r = self._novo()
        linhas = [["Item %d" % i, "Descrição razoavelmente longa da linha %d" % i,
                   "R$ %d.000,00" % i] for i in range(40)]
        r.tabela(["Item", "Descrição", "Valor"], linhas)
        r.salvar()
        self.assertEqual(self._graves(), [])

    # ------------------------------------------------------------------
    # Sumário, estilo sóbrio e imagem
    # ------------------------------------------------------------------
    def test_sumario_lista_os_titulos_com_pagina(self):
        r = self._novo()
        r.capa()
        r.sumario()
        for i in range(3):
            r.titulo("%d. Seção" % (i + 1))
            r.paragrafo("conteúdo da seção")
            r.titulo("%d.1 Subseção" % (i + 1), nivel=2)
            r.paragrafo("mais conteúdo")
        r.salvar()
        self._assert_pdf()
        self.assertEqual(self._graves(), [])

    def test_estilo_sobrio_nao_usa_cor(self):
        r = self._novo(estilo="sobrio", titulo="ATA DE REUNIÃO")
        r.titulo("ATA DE REUNIÃO DE SÓCIOS")
        r.paragrafo("Aos vinte e cinco dias do mês de outubro ...")
        r.assinaturas(["João da Silva"])
        r.salvar()
        for conteudo in pdfpro._conteudos(self._bruto()):
            for r_, g_, b_ in re.findall(rb"([\d.]+) ([\d.]+) ([\d.]+) rg", conteudo):
                self.assertEqual({float(r_), float(g_), float(b_)}.__len__(), 1,
                                 "documento sóbrio não pode ter cor")

    def test_codigo_preserva_linhas_e_recuo(self):
        """`_plano` troca quebra de linha por espaço (existe para medir texto):
        aplicá-lo antes de dividir colapsava o bloco inteiro numa linha."""
        r = self._novo()
        r.codigo("def somar(a, b):\n    resultado = a + b\n    return resultado")
        planos = [g for f in r.story for g in getattr(f, "_content", [f])]
        tabela = [f for f in planos if hasattr(f, "_cellvalues")][0]
        paragrafos = tabela._cellvalues[0][-1]
        self.assertEqual(len(paragrafos), 3, "cada linha do código é um parágrafo")
        self.assertIn("&nbsp;&nbsp;&nbsp;&nbsp;", paragrafos[1].text,
                      "o recuo do código tem de sobreviver")
        self.assertIn("return", paragrafos[2].text)

    def test_imagem_inexistente_avisa_com_clareza(self):
        r = self._novo()
        with self.assertRaises(ValueError):
            r.imagem("/caminho/que/nao/existe.png")

    # ------------------------------------------------------------------
    # A auditoria precisa REPROVAR o que é ruim
    # ------------------------------------------------------------------
    def test_auditoria_acusa_texto_fora_da_grade(self):
        from reportlab.pdfgen import canvas as _c
        c = _c.Canvas(self.path, pagesize=pdfpro.PAGINA)
        c.setFont("Helvetica", 10)
        c.drawString(10, 700, "texto colado na borda do papel")
        c.save()
        codigos = [a["codigo"] for a in pdfpro.auditar_pdf(self.path)]
        self.assertIn("texto-fora-da-grade", codigos)

    def test_auditoria_acusa_glifo_invalido_em_fonte_base14(self):
        from reportlab.pdfgen import canvas as _c
        c = _c.Canvas(self.path, pagesize=pdfpro.PAGINA)
        c.setFont("Helvetica", 10)
        c.drawString(pdfpro.X_TEXTO, 700, "marcador \x7f quebrado")
        c.save()
        codigos = [a["codigo"] for a in pdfpro.auditar_pdf(self.path)]
        self.assertIn("glifo-invalido", codigos)

    def test_auditoria_acusa_arquivo_que_nao_e_pdf(self):
        with open(self.path, "wb") as f:
            f.write(b"nao sou um pdf")
        self.assertEqual([a["codigo"] for a in pdfpro.auditar_pdf(self.path)], ["nao-e-pdf"])

    def test_verificar_pdf_devolve_verdadeiro_para_documento_do_kit(self):
        r = self._novo()
        r.paragrafo("ok")
        r.salvar()
        self.assertTrue(pdfpro.verificar_pdf(self.path))

    # ---------- identidade "Tinta & Latão" e blocos editoriais ----------
    def test_blocos_novos_passam_na_propria_auditoria(self):
        """Linha do tempo, gráficos e contracapa entraram DEPOIS da grade —
        a prova de que respeitam a mesma aresta é a auditoria do próprio kit
        não achar nada de grave no arquivo pronto."""
        r = self._novo(cliente="ACME LTDA", emissor="Escritório",
                       subtitulo="Exercício 2025", tipo="RELATÓRIO GERENCIAL")
        r.capa()
        r.titulo("Indicadores")
        r.kpis([("R$ 5,84 mi", "Receita"), ("18,4%", "Margem")])
        r.citacao("Frase-chave do documento.", "Sumário executivo")
        r.etapas([("Diagnóstico", "ago/2026"), ("Implantação", "out/2026")])
        r.grafico_barras(["2024", "2025"], {"Receita": [5.2, 5.8]}, titulo="Receita")
        r.grafico_linhas(["Jan", "Fev"], {"Saldo": [1.2, 1.4]}, titulo="Saldo")
        r.grafico_pizza(["Serviços", "Produtos"], [62, 38], titulo="Participação")
        r.fecho("Palmas/TO, 27 de julho de 2026.")
        r.assinaturas(["Frederico Barros"], subtitulos=["Contador"])
        r.contracapa(contatos=["contato@empresa.com.br", "+55 63 3000-0000"])
        r.salvar()   # levanta se a auditoria achar algo grave
        self.assertEqual(self._graves(), [])


    # ---------- v2: presets, tipografia, números e marcadores ----------
    def test_tipografia_padrao_e_metricamente_igual_a_do_word(self):
        """Carlito e Caladea têm as métricas do Calibri e do Cambria que o
        docpro pede: é o que faz este PDF quebrar a linha no MESMO lugar que o
        Word do cliente. Sem isso, conferir o PDF gêmeo é conferir outro
        documento."""
        self.assertIn("office", pdfpro.TIPOGRAFIAS)
        self.assertIn("editorial", pdfpro.TIPOGRAFIAS)
        r = self._novo()
        self.assertEqual(r.fonte, pdfpro.TIPOGRAFIAS["office"][0])
        editorial = self._novo(tipografia="editorial")
        self.assertEqual(editorial.fonte, pdfpro.TIPOGRAFIAS["editorial"][0])
        with self.assertRaises(pdfpro.KitError):
            self._novo(tipografia="inventada")

    def test_preset_decide_capa_sumario_e_numeracao(self):
        r = pdfpro.RelatorioPDF(self.path, titulo="Proposta", emissor="Escritório",
                                preset="proposta")
        r.titulo("Escopo")
        r.paragrafo("Conteúdo do escopo com tamanho suficiente para a página. " * 6)
        r.salvar()
        paginas = [t for t in _texto_das_paginas(self.path)]
        self.assertGreaterEqual(len(paginas), 2)
        # Proposta: capa sim, sumário nunca, sem numeração de seção.
        self.assertNotIn("Sumário", "\n".join(paginas))
        self.assertNotIn("SEÇÃO 01", "\n".join(paginas))

    def test_parecer_numera_em_decimal_e_o_gerencial_em_secao(self):
        r = pdfpro.RelatorioPDF(self.path, titulo="Parecer", emissor="Escritório",
                                preset="parecer", capa=False, contracapa=False)
        r.titulo("Fundamentação")
        r.titulo("Legislação", nivel=2)
        r.paragrafo("Conteúdo do parecer com tamanho suficiente. " * 8)
        r.salvar()
        texto = "\n".join(_texto_das_paginas(self.path))
        self.assertIn("1. Fundamentação", texto)
        self.assertIn("1.1 Legislação", texto)

    def test_preset_desconhecido_falha_cedo(self):
        with self.assertRaises(pdfpro.KitError):
            pdfpro.RelatorioPDF(self.path, preset="inventado")

    def test_tabela_recebe_numeros_e_o_kit_formata(self):
        r = self._novo()
        r.tabela(["Serviço", "Valor mensal"],
                 [["Contabilidade", 2200], ["Departamento pessoal", 800]],
                 moeda=["Valor mensal"], total="soma")
        r.salvar()
        texto = "\n".join(_texto_das_paginas(self.path))
        self.assertIn("R$ 2.200,00", texto)
        self.assertIn("R$ 3.000,00", texto)   # total CALCULADO pelo kit
        self.assertIn("TOTAL", texto)

    def test_kpi_adapta_o_corpo_e_seis_viram_duas_fileiras(self):
        r = self._novo()
        r.kpis([(1887900, "Receita", "moeda"), (0.325, "Margem", "pct")])
        r.salvar()
        texto = "\n".join(_texto_das_paginas(self.path))
        self.assertIn("R$ 1.887.900,00", texto)
        self.assertIn("32,5%", texto)
        with self.assertRaises(pdfpro.KitError):
            self._novo().kpis([(i, "R%d" % i) for i in range(7)])

    def test_titulos_viram_marcadores_do_pdf_na_pagina_certa(self):
        """Sem outline, um relatório de vinte páginas se lê rolando."""
        r = self._novo(emissor="Escritório")
        r.titulo("Primeira")
        r.paragrafo("Conteúdo. " * 40)
        r.quebra()
        r.titulo("Segunda")
        r.paragrafo("Conteúdo. " * 40)
        r.salvar()
        with open(self.path, "rb") as f:
            bruto = f.read()
        self.assertIn(b"/Outlines", bruto)

    def test_titulo_de_segundo_nivel_sozinho_nao_derruba_o_outline(self):
        """O reportlab RECUSA pular do nível -1 para o 1: um documento que
        começa por um subtítulo derrubava a geração inteira."""
        r = self._novo()
        r.titulo("Só um subtítulo", nivel=2)
        r.paragrafo("Conteúdo com tamanho suficiente para a página. " * 6)
        r.salvar()
        self.assertEqual(self._graves(), [])

    def test_citacao_aceita_fonte_e_o_alias_antigo(self):
        r = self._novo()
        r.citacao("Frase.", fonte="Sumário executivo")
        r.citacao("Outra.", autor="Autor antigo")
        r.paragrafo("Conteúdo com tamanho suficiente para a página. " * 6)
        r.salvar()
        texto = "\n".join(_texto_das_paginas(self.path))
        self.assertIn("SUMÁRIO EXECUTIVO", texto)
        self.assertIn("AUTOR ANTIGO", texto)

    def test_assinaturas_aceita_cargos_e_o_alias_antigo(self):
        for chave in ("cargos", "subtitulos"):
            r = self._novo(emissor="Escritório")
            r.titulo("Escopo")
            r.paragrafo("Conteúdo com tamanho suficiente para a página. " * 6)
            r.fecho("Palmas/TO, 02 de setembro de 2026.")
            r.assinaturas(["Nome Um"], **{chave: ["Contador"]})
            r.salvar()
            self.assertIn("Contador", "\n".join(_texto_das_paginas(self.path)))
            self.assertEqual(self._graves(), [])

    def test_callout_com_tipo_invalido_falha_cedo(self):
        with self.assertRaises(pdfpro.KitError):
            self._novo().callout("R", "texto", tipo="inventado")

    def test_titulo_numera_a_secao_sozinho(self):
        r = self._novo()
        r.titulo("Escopo")
        r.titulo("Investimento")
        r.titulo("Detalhe", nivel=2)
        r.titulo("Anexo", kicker="ANEXO A")
        texto = _textos(r.story)
        self.assertIn("SEÇÃO 01", texto)
        self.assertIn("SEÇÃO 02", texto)
        self.assertIn("ANEXO A", texto)
        self.assertNotIn("SEÇÃO 03", texto)  # nível 2 não consome numeração

    def test_pizza_le_a_participacao_na_legenda_em_pt_br(self):
        """Rótulo colado na fatia cai dentro da fatia escura e vaza a caixa (a
        auditoria reprovaria). A leitura vai para a legenda, em percentual com
        vírgula decimal — o valor bruto não substitui a participação."""
        from reportlab.graphics.charts.legends import Legend
        r = self._novo()
        d = r.grafico_pizza(["Contabilidade", "Fiscal", "Pessoal"], [1900, 1000, 500])
        legendas = [c for c in d.contents if isinstance(c, Legend)]
        self.assertEqual(len(legendas), 1)
        self.assertEqual([n for _, n in legendas[0].colorNamePairs],
                         ["Contabilidade — 55,9%", "Fiscal — 29,4%", "Pessoal — 14,7%"])

    def test_barra_parte_do_zero(self):
        """Com a base automática do reportlab, uma série de 4,1 a 5,8 vira
        quatro barras quase idênticas e a série menor some — o gráfico passa a
        mentir sobre a proporção."""
        from reportlab.graphics.charts.barcharts import VerticalBarChart
        r = self._novo()
        d = r.grafico_barras(["2023", "2024"], {"Receita": [4.1, 5.8]})
        ch = next(c for c in d.contents if isinstance(c, VerticalBarChart))
        self.assertEqual(ch.valueAxis.valueMin, 0)

    def test_confidencial_marca_a_capa_e_o_rodape_e_pode_ser_desligado(self):
        desenhos = {}
        for confidencial in (True, False):
            r = self._novo(emissor="Escritório", confidencial=confidencial)
            r.capa()
            r.titulo("Escopo")
            r.paragrafo("Um parágrafo de corpo com texto suficiente para a "
                        "página não cair na regra de página em branco.")
            # A capa da v2 é montada em `_capa` (para o preset poder gerá-la
            # sozinho no fim) e só entra na story em `salvar()`.
            na_capa = "CONFIDENCIAL" in _textos(r._capa)
            self.assertEqual(na_capa, confidencial)
            r.salvar()
            self.assertEqual(self._graves(), [])
            # O rodapé é desenhado no canvas, fora da story: a marca aparece
            # como UM trecho de texto a mais em cada página de conteúdo.
            desenhos[confidencial] = len(_por_pagina(self.path)[1])
        self.assertEqual(desenhos[True], desenhos[False] + 1)

    def test_documento_sobrio_nao_recebe_marca_de_sigilo(self):
        """Ata e contrato vão a registro público: `estilo="sobrio"` desliga a
        marca mesmo com `confidencial=True`."""
        r = self._novo(estilo="sobrio", confidencial=True, emissor="Escritório")
        self.assertFalse(r.confidencial)
        r.titulo("CLÁUSULA PRIMEIRA")
        r.paragrafo("texto")
        r.salvar()
        self.assertEqual(self._graves(), [])

    def test_contracapa_cabe_na_pagina_em_qualquer_variacao(self):
        """A mancha de tinta fecha perto do rodapé sem alcançá-lo: um
        centímetro a mais criaria uma página extra em branco."""
        for kw in ({}, {"contatos": ["a@b.c"]},
                   {"contatos": ["a@b.c", "x", "y", "z"], "nota": "nota curta"}):
            r = self._novo(emissor="Escritório", confidencial=False)
            r.titulo("Escopo")
            r.paragrafo("Um parágrafo de corpo com texto suficiente para a "
                        "página não cair na regra de página em branco.")
            r.contracapa(estilo="pagina", **kw)
            r.salvar()
            self.assertEqual(len(_por_pagina(self.path)), 2, kw)
            self.assertEqual(self._graves(), [])

    def test_fechamento_em_faixa_nao_cria_pagina_nova(self):
        """O padrão da v2 é a FAIXA no fim da última página. A contracapa de
        página inteira num documento de duas páginas é uma terceira folha verde
        e vazia — o documento fecha gritando o que a capa abriu discreto."""
        r = self._novo(emissor="Escritório", confidencial=False)
        r.titulo("Escopo")
        r.paragrafo("Um parágrafo de corpo com texto suficiente para a página "
                    "não cair na regra de página em branco da auditoria.")
        r.contracapa(contatos=["contato@empresa.com.br"])
        r.salvar()
        self.assertEqual(len(_por_pagina(self.path)), 1)
        self.assertEqual(self._graves(), [])


if __name__ == "__main__":
    unittest.main()
