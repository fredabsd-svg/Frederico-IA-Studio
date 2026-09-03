#!/usr/bin/env python3
"""Regenera os QUATRO documentos da revisão de design dos kits.

São os mesmos quatro artefatos que a revisão gerou com os kits v1, olhou página
a página e reprovou: relatório gerencial em Word, ata em Word sóbrio, planilha
com painel em Excel e proposta em PDF. Regerá-los com a v2 é o critério de
aceite — cada um sai com a `CONFERÊNCIA` limpa e sem os defeitos apontados:

    relatório  sumário com as páginas REAIS · tabela de 5 linhas inteira numa
               página · KPIs em UMA linha · PDF gêmeo com marcadores
    proposta   3 páginas (capa, conteúdo, conteúdo + faixa) — sem página só de
               sumário nem só de assinatura
    ata        NIRE inteiro numa linha · corpo justificado · zero cor
    planilha   impressão em UMA página de largura · filtro no cabeçalho · eixo
               do gráfico sem centavos · aba Notas por último

Os arquivos NÃO ficam versionados de propósito: binário no repositório envelhece
em silêncio e passa a "documentar" uma versão do kit que não existe mais. Rode
o script quando quiser conferir o resultado com os próprios olhos:

    python sandbox/exemplos/gerar_exemplos.py [pasta-de-saida]

Ele imprime a `CONFERÊNCIA` de cada arquivo e termina com código 1 se algum
deles reprovar.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import kits                                                    # noqa: E402
from docpro import Relatorio, Sobrio                           # noqa: E402
from kits import KitError, fmt                                 # noqa: E402
from pdfpro import RelatorioPDF                                # noqa: E402
from xlspro import Planilha                                    # noqa: E402

EMISSOR = "Frederico Assessoria Contábil e Fiscal"
CONTATO = "contabil@fredericoassessoria.com.br"

TRIMESTRES = [
    ["1T25", 412300, 298100, 114200],
    ["2T25", 455900, 310400, 145500],
    ["3T25", 498700, 325000, 173700],
    ["4T25", 521000, 340900, 180100],
]


def relatorio_gerencial(pasta):
    r = Relatorio("Análise Econômico-Financeira 2025",
                  cliente="NEWCODE Soluções Tecnológicas S/A", emissor=EMISSOR,
                  subtitulo="Exercício encerrado em 31/12/2025",
                  preset="gerencial")
    r.titulo("Sumário executivo")
    r.paragrafo(
        "A NEWCODE encerrou 2025 com receita líquida de R$ 1,89 milhão, crescimento "
        "de 26,4% frente a 2024. A margem líquida manteve-se estável em torno de "
        "32,5%, sustentada pela redução proporcional dos custos de infraestrutura e "
        "pela renegociação dos contratos de data center no segundo semestre.")
    r.kpis([(1887900, "Receita líquida", "moeda"),
            (0.325, "Margem líquida", "pct"),
            ("+26,4%", "Crescimento a/a"),
            (613500, "Resultado", "moeda")])
    r.callout("PONTO DE ATENÇÃO",
              "Os lançamentos de dezembro ainda estão provisórios. O fechamento "
              "definitivo pode alterar o resultado do quarto trimestre em até 3%.",
              tipo="alerta")

    r.titulo("Resultado por trimestre")
    r.tabela(["Trimestre", "Receita", "Custos", "Resultado"], TRIMESTRES,
             moeda=["Receita", "Custos", "Resultado"], total="soma",
             titulo="Resultado trimestral 2025",
             fonte="Fonte: balancetes conciliados, dez/2025.")
    r.grafico_barras([l[0] for l in TRIMESTRES],
                     {"Receita": [l[1] for l in TRIMESTRES],
                      "Custos": [l[2] for l in TRIMESTRES]},
                     titulo="Receita × Custos por trimestre", sufixo_eixo="R$")

    r.titulo("Indicadores")
    r.titulo("Liquidez e endividamento", nivel=2)
    r.paragrafo("A liquidez corrente subiu de 1,42 para 1,68, e o endividamento "
                "geral caiu para 38% do ativo total. O capital de giro líquido "
                "positivo cobre 2,3 meses de despesas operacionais.")
    r.lista(["Liquidez corrente: 1,68 (meta: acima de 1,50)",
             "Endividamento geral: 38% do ativo",
             "Prazo médio de recebimento: 41 dias"])
    r.citacao("O segundo semestre confirmou a virada operacional iniciada em 2024.",
              fonte="Sumário executivo")

    r.titulo("Recomendações")
    r.etapas([("Fechamento definitivo de dezembro", "até 15/01/2026"),
              ("Revisão do regime tributário", "fev/2026"),
              ("Planejamento orçamentário 2026", "mar/2026")])
    r.assinaturas(["Frederico Barros Almeida"],
                  cargos=["Contador · CRC/TO 006157/O-8"],
                  local_data="Palmas/TO, %s." % fmt.data_extenso())
    r.contracapa(contatos=[CONTATO, "Palmas/TO"])
    return r.salvar(os.path.join(pasta, "relatorio-analise-2025-newcode.docx"))


def proposta_pdf(pasta):
    q = RelatorioPDF(os.path.join(pasta, "proposta-assessoria-tmk-net.pdf"),
                     titulo="Proposta de Assessoria Contábil", cliente="TMK NET LTDA",
                     emissor=EMISSOR,
                     subtitulo="Contabilidade, fiscal e departamento pessoal",
                     preset="proposta")
    q.titulo("Escopo dos serviços")
    q.paragrafo("A proposta contempla a escrituração contábil e fiscal completa, o "
                "departamento pessoal e o atendimento consultivo mensal, com entrega "
                "das obrigações acessórias dentro dos prazos legais.")
    q.lista(["Escrituração contábil e conciliações mensais",
             "Apuração de tributos e obrigações acessórias (SPED, DCTFWeb, EFD)",
             "Folha de pagamento e eSocial",
             "Reunião mensal de resultados"])
    q.kpis([(3400, "Honorário mensal", "moeda"),
            ("12 meses", "Vigência"),
            ("5 dias úteis", "Prazo de fechamento")])

    q.titulo("Investimento")
    q.tabela(["Serviço", "Valor mensal"],
             [["Contabilidade e fiscal", 2200],
              ["Departamento pessoal (até 10 vínculos)", 800],
              ["Consultoria mensal", 400]],
             moeda=["Valor mensal"], total="soma")
    q.callout("CONDIÇÕES",
              "Reajuste anual pelo IPCA. Serviços fora do escopo são orçados à "
              "parte mediante aprovação prévia.", tipo="info")

    q.titulo("Cronograma de implantação")
    q.etapas([("Assinatura do contrato", "até 10/09/2026"),
              ("Migração dos dados", "set/2026"),
              ("Primeiro fechamento", "out/2026")])
    q.fecho("Palmas/TO, %s." % fmt.data_extenso())
    q.assinaturas(["Frederico Barros Almeida"],
                  cargos=["Contador · CRC/TO 006157/O-8"])
    q.contracapa(contatos=[CONTATO])
    return q.salvar()


def ata_sobria(pasta):
    a = Sobrio("ATA DE REUNIÃO DE SÓCIOS",
               identificacao="NEWCODE SOLUÇÕES TECNOLÓGICAS LTDA — "
                             "CNPJ 00.000.000/0001-00 — NIRE 17.3.0000000-1")
    a.paragrafo("Aos três dias do mês de setembro de dois mil e vinte e seis, às dez "
                "horas, na sede social, reuniram-se os sócios representando a "
                "totalidade do capital social, dispensadas as formalidades de "
                "convocação na forma da lei.")
    a.secao("ORDEM DO DIA")
    a.item("Aprovação das contas do exercício de 2025;")
    a.item("Destinação do resultado do exercício;")
    a.item("Fixação da remuneração da administração.")
    a.secao("DELIBERAÇÕES")
    a.paragrafo("Postas as matérias em discussão e votação, foram aprovadas por "
                "unanimidade as contas do exercício encerrado em 31 de dezembro de "
                "2025, com resultado positivo de R$ 613.500,00 (%s)."
                % fmt.extenso(613500))
    a.fecho("Palmas/TO, %s." % fmt.data_extenso())
    a.assinaturas(["Frederico Barros Almeida", "Maria Oliveira Souza"],
                  cargos=["Sócio-administrador — CPF 123.456.789-01",
                          "Sócia — CPF 987.654.321-09"])
    a.testemunhas(["João Pereira Lima", "Ana Clara Ribeiro"])
    return a.salvar(os.path.join(pasta, "ata-reuniao-socios-newcode.docx"))


def planilha_dre(pasta):
    p = Planilha(emissor=EMISSOR, cliente="NEWCODE Soluções Tecnológicas S/A",
                 titulo="DRE 2025")
    ws = p.aba("DRE 2025")
    linhas = [linha + [round(linha[3] / linha[1], 4)] for linha in TRIMESTRES]
    info = p.tabela(ws, ["Trimestre", "Receita", "Custos", "Resultado", "Margem"],
                    linhas, moeda=["Receita", "Custos", "Resultado"],
                    pct=["Margem"], total="soma", filtro=True,
                    titulo="Resultado trimestral 2025")
    p.painel(kpis=[(1887900, "Receita líquida", "moeda"),
                   (0.325, "Margem líquida", "pct"),
                   (613500, "Resultado", "moeda")],
             graficos=[("barras", info, "Trimestre", "Receita", "Receita por trimestre"),
                       ("linhas", info, "Trimestre", "Resultado", "Resultado por trimestre")])
    p.notas(["Fonte: balancetes conciliados, dez/2025",
             "Valores em reais",
             "Os lançamentos de dezembro ainda estão provisórios"])
    return p.salvar(os.path.join(pasta, "dre-2025-newcode.xlsx"))


def main(argv):
    pasta = argv[1] if len(argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(pasta, exist_ok=True)
    print("kits v%s — gerando em %s" % (getattr(kits, "VERSAO", "2"), pasta))
    falhou = False
    for nome, gerar in (("relatório gerencial (Word)", relatorio_gerencial),
                        ("proposta comercial (PDF)", proposta_pdf),
                        ("ata de reunião (Word sóbrio)", ata_sobria),
                        ("DRE com painel (Excel)", planilha_dre)):
        try:
            print("CONFERÊNCIA — %s: %s" % (nome, gerar(pasta)))
        except KitError as erro:
            falhou = True
            print("REPROVADO — %s: %s" % (nome, erro))
    return 1 if falhou else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
