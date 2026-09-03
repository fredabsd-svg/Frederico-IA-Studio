"""Testes da base comum dos kits (`kits.py`).

Este módulo não depende de python-docx, openpyxl nem reportlab: é exatamente
por isso que a formatação pt-BR, a detecção de placeholder e as regras de
leitura (KPI, eixo, total) podem ser cobradas aqui, uma vez, em vez de três.
"""
import unittest
from datetime import date
from decimal import Decimal

import kits
from kits import (KitError, achados_de_paginacao, achados_de_placeholder,
                  escala_kpi, eixo_milhar, fmt, formata_valor,
                  liga_identificadores, linha_de_total, linhas_de_kpi,
                  normaliza_linhas, paleta_para, tipos_de_coluna)


class FormatacaoTests(unittest.TestCase):
    """Números pertencem ao KIT: o modelo passa o número, o kit formata."""

    def test_moeda_em_pt_br(self):
        self.assertEqual(fmt.moeda(412300), "R$ 412.300,00")
        self.assertEqual(fmt.moeda(0), "R$ 0,00")
        self.assertEqual(fmt.moeda(Decimal("1234.5")), "R$ 1.234,50")
        self.assertEqual(fmt.moeda(-1234.56), "-R$ 1.234,56")

    def test_negativo_entre_parenteses_e_a_convencao_contabil(self):
        self.assertEqual(fmt.moeda(-1234.56, parenteses=True), "(R$ 1.234,56)")

    def test_arredonda_meio_para_cima_e_nao_como_o_round_do_python(self):
        """`round()` do Python usa banker's rounding: `round(2.5)` é 2. Num
        total contábil isso vira centavo faltando."""
        self.assertEqual(fmt.num(2.5, casas=0), "3")
        self.assertEqual(fmt.moeda(0.005), "R$ 0,01")

    def test_percentual_milhar_e_data(self):
        self.assertEqual(fmt.pct(0.325), "32,5%")
        self.assertEqual(fmt.pct(32.5, ja_em_pct=True), "32,5%")
        self.assertEqual(fmt.num(1284), "1.284")
        self.assertEqual(fmt.num(1887900), "1.887.900")
        self.assertEqual(fmt.data(date(2026, 9, 2)), "02/09/2026")
        self.assertEqual(fmt.data_extenso(date(2026, 9, 2)), "02 de setembro de 2026")

    def test_cnpj_e_cpf(self):
        self.assertEqual(fmt.cnpj("00000000000100"), "00.000.000/0001-00")
        self.assertEqual(fmt.cpf("12345678901"), "123.456.789-01")
        # Entrada que não é um documento volta intacta, sem inventar máscara.
        self.assertEqual(fmt.cnpj("não é cnpj"), "não é cnpj")

    def test_valor_por_extenso(self):
        self.assertEqual(fmt.extenso(300000), "trezentos mil reais")
        self.assertEqual(fmt.extenso(1), "um real")
        self.assertEqual(fmt.extenso(1500), "mil e quinhentos reais")
        self.assertEqual(fmt.extenso(1234), "mil duzentos e trinta e quatro reais")
        self.assertEqual(fmt.extenso(613500),
                         "seiscentos e treze mil e quinhentos reais")
        # "um milhão DE reais" — sem a preposição sai errado em português.
        self.assertEqual(fmt.extenso(1000000), "um milhão de reais")
        self.assertEqual(fmt.extenso(2500000), "dois milhões e quinhentos mil reais")
        self.assertEqual(fmt.extenso(1234.56),
                         "mil duzentos e trinta e quatro reais e cinquenta e seis centavos")

    def test_formata_valor_respeita_o_tipo_da_coluna(self):
        self.assertEqual(formata_valor(412300, "moeda"), "R$ 412.300,00")
        self.assertEqual(formata_valor(0.325, "pct"), "32,5%")
        self.assertEqual(formata_valor(1284, "milhar"), "1.284")
        self.assertEqual(formata_valor(date(2026, 9, 2), "data"), "02/09/2026")
        # Texto passa intacto: é o que permite "—" ou "n/d" numa coluna numérica
        # sem quebrar a tabela.
        self.assertEqual(formata_valor("—", "moeda"), "—")
        self.assertEqual(formata_valor(None, "moeda"), "")


class TabelaTests(unittest.TestCase):
    def test_coluna_inexistente_e_erro_e_nao_silencio(self):
        """`moeda=["Valor"]` num cabeçalho que diz "Valor mensal" saía sem
        formato nenhum na v1, e ninguém percebia."""
        with self.assertRaises(KitError) as erro:
            tipos_de_coluna(["Serviço", "Valor mensal"], moeda=["Valor"])
        self.assertIn("Valor", str(erro.exception))

    def test_linha_fora_do_cabecalho_e_completada_E_acusada(self):
        linhas, achados = normaliza_linhas(["A", "B", "C"], [["x"], ["a", "b", "c", "d"]])
        self.assertEqual(linhas, [["x", "", ""], ["a", "b", "c"]])
        self.assertEqual([a["codigo"] for a in achados],
                         ["linha-fora-do-cabecalho"] * 2)
        self.assertTrue(all(a["gravidade"] == "grave" for a in achados))

    def test_total_soma_as_colunas_numericas_e_ignora_percentual(self):
        cab = ["Trimestre", "Receita", "Margem"]
        tipos = tipos_de_coluna(cab, moeda=["Receita"], pct=["Margem"])
        total = linha_de_total(cab, [["1T", 100, 0.2], ["2T", 200, 0.3]], tipos)
        # Somar percentuais dá um número sem significado: a célula fica vazia.
        self.assertEqual(total, ["TOTAL", 300, ""])


class LeituraTests(unittest.TestCase):
    def test_kpi_reduz_de_corpo_em_vez_de_quebrar_em_duas_linhas(self):
        self.assertEqual(escala_kpi("32,5%"), kits.ESCALA["kpi"])
        self.assertEqual(escala_kpi("R$ 613.500"), kits.ESCALA["kpi_medio"])
        self.assertEqual(escala_kpi("R$ 1.887.900,00"), kits.ESCALA["kpi_curto"])

    def test_cinco_ou_seis_kpis_viram_duas_fileiras_de_tres(self):
        self.assertEqual([len(f) for f in linhas_de_kpi([1, 2, 3, 4])], [4])
        self.assertEqual([len(f) for f in linhas_de_kpi([1, 2, 3, 4, 5])], [3, 2])
        self.assertEqual([len(f) for f in linhas_de_kpi([1, 2, 3, 4, 5, 6])], [3, 3])

    def test_eixo_vai_para_milhar_acima_de_cem_mil(self):
        self.assertEqual(eixo_milhar([[5.2, 5.8]]), (1, ""))
        self.assertEqual(eixo_milhar([[412300, 521000]]), (1000, "mil"))
        self.assertEqual(eixo_milhar([[1887900, 2000000]]), (1000000, "milhões"))


class IdentidadeTests(unittest.TestCase):
    def test_cor_da_marca_substitui_a_tinta_e_recalcula_o_apoio(self):
        pal = paleta_para("AA3355")
        self.assertEqual(pal["tinta"], "AA3355")
        self.assertEqual(pal["primaria"], "AA3355")
        self.assertNotEqual(pal["apoio"], kits.PALETA["apoio"])
        self.assertEqual(pal["latao"], kits.PALETA["latao"])  # o acento não muda

    def test_cor_invalida_falha_com_mensagem_util(self):
        with self.assertRaises(KitError):
            paleta_para("verde")

    def test_identificador_recebe_hifen_nao_separavel(self):
        saida = liga_identificadores("CNPJ 00.000.000/0001-00 e NIRE 17.3.0000000-1")
        self.assertIn("00.000.000/0001" + kits.HIFEN_FIXO + "00", saida)
        self.assertIn("17.3.0000000" + kits.HIFEN_FIXO + "1", saida)
        # Hífen comum, em palavra composta, continua comum (senão a mancha
        # justificada perde a quebra normal do texto).
        self.assertIn("guarda-chuva", liga_identificadores("guarda-chuva"))


class AuditoriaTests(unittest.TestCase):
    def test_placeholder_de_rascunho_e_achado_grave(self):
        achados = achados_de_placeholder(["Vence em DD/MM/AAAA", "Seu Nome"])
        self.assertEqual(len(achados), 1)
        self.assertEqual(achados[0]["gravidade"], "grave")
        self.assertEqual(achados[0]["codigo"], "placeholder")

    def test_texto_limpo_nao_gera_achado(self):
        self.assertEqual(achados_de_placeholder(["Vence em 10/09/2026"]), [])

    def test_pagina_em_branco_e_grave(self):
        achados = achados_de_paginacao(["capa", "x" * 200, "  "])
        self.assertEqual([a["codigo"] for a in achados], ["pagina-vazia"])

    def test_assinatura_sozinha_numa_pagina_e_grave(self):
        paginas = ["capa", "conteúdo de verdade " * 20,
                   "Palmas/TO, 02 de setembro de 2026.\nFrederico Barros\n"
                   "Contador\nPágina 3 de 3"]
        achados = achados_de_paginacao(
            paginas, assinantes=[("Frederico Barros", "Contador")],
            fechamento=["Palmas/TO, 02 de setembro de 2026."])
        self.assertEqual([a["codigo"] for a in achados], ["assinatura-orfa"])

    def test_pagina_de_fechamento_com_conteudo_nao_e_assinatura_orfa(self):
        """Uma página que fecha o documento com um gráfico, o fecho, a
        assinatura e a faixa de contatos tem pouco texto e é legítima. O que
        caracteriza a órfã é não sobrar NADA quando se tira o fechamento."""
        paginas = ["capa", "conteúdo " * 30,
                   "Gráfico 3 — Participação por linha de serviço\n"
                   "Serviços 62,0% Produtos 38,0%\n"
                   "Palmas/TO, 02 de setembro de 2026.\nFrederico Barros\nContador"]
        self.assertEqual(
            achados_de_paginacao(paginas, assinantes=[("Frederico Barros", "Contador")],
                                 fechamento=["Palmas/TO, 02 de setembro de 2026."]),
            [])

    def test_contracapa_de_pagina_inteira_nao_conta_como_pagina_vazia(self):
        paginas = ["capa", "conteúdo " * 30, "Escritório"]
        self.assertEqual(achados_de_paginacao(paginas, ultima_e_arte=True), [])
        self.assertEqual([a["codigo"] for a in achados_de_paginacao(paginas)],
                         ["pagina-vazia"])


if __name__ == "__main__":
    unittest.main()
