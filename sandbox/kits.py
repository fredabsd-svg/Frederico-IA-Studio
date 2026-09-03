"""kits — base COMUM dos três kits de documento (docpro, xlspro, pdfpro).

Antes deste módulo, a paleta, a escala tipográfica, a limpeza de texto, a
detecção de placeholder e a formatação de número viviam triplicadas — e
divergiam. Um "R$ 1,89 mi" saía do Word ao lado de um "R$ 613.500,00" do Excel
no mesmo pacote de entrega, porque cada kit formatava por conta própria.

O que mora aqui:

  * `PALETA` / `ESCALA`  — identidade "Tinta & Latão" e a escala tipográfica
    fechada, únicas para os três formatos;
  * `fmt`                — formatação pt-BR (moeda, percentual, milhar, data,
    valor por extenso, CNPJ, CPF). **Números pertencem ao kit**: o modelo passa
    `int`/`float`/`Decimal`/`date` e quem formata é a coluna;
  * `KitError`           — falha de auditoria grave (o arquivo NÃO deve ser
    entregue);
  * auditoria compartilhada — placeholder, linha fora do cabeçalho, célula de
    valor vazia;
  * gráficos matplotlib com a paleta e as regras de leitura (eixo em milhar,
    legenda só com 2+ séries, rótulo de valor até 8 barras).

Nada aqui depende de python-docx, openpyxl ou reportlab: o módulo é importável
sozinho, e é isso que permite testá-lo sem nenhum dos três.
"""
import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal

#: Geração dos kits. A v2 fechou os achados da revisão de design de ago/2026.
VERSAO = "2.0.0"

# ---------------------------------------------------------------------------
# 1. IDENTIDADE
# ---------------------------------------------------------------------------

#: Identidade "Tinta & Latão": verde-tinta profundo com acento em latão.
#: `primaria` continua existindo como ALIAS de `tinta` — os três kits a usam e
#: manter as duas evita reescrever cada bloco só para trocar de nome.
PALETA = {
    "tinta": "0C3A30", "apoio": "33705C", "latao": "A9812F",
    "latao_escuro": "8A6825", "latao_claro": "C9A75B",
    "corpo": "26241E", "cinza": "6B6459", "suave": "F5F2EA",
    "borda": "E2DCCB", "borda_leve": "F0EBDD", "branco": "FFFFFF",
    "creme": "C9C2AE",
    # Semânticos — nenhum bloco pode escrever hex solto.
    "positivo": "33705C", "negativo": "9C3D24",
    "alerta_bg": "FBF3DE", "alerta_bd": "A97614",
    "critico_bg": "F9ECE7", "critico_bd": "9C3D24",
    "sucesso_bg": "EAF3EC", "sucesso_bd": "1E7A46",
    "info_bg": "F5F2EA", "info_bd": "0C3A30",
    "primaria": "0C3A30",
}

#: Escala tipográfica FECHADA — uma só para os três kits. Fora dela, nenhum
#: bloco escolhe tamanho de fonte.
ESCALA = {
    "capa_titulo": 26, "capa_sub": 13, "capa_tipo": 11, "capa_meta": 9,
    "h1": 15, "h2": 12.5, "h3": 10.5,
    "corpo": 10.5, "apoio": 9.5, "pequeno": 9, "legenda": 8, "kicker": 8,
    "rodape": 8, "codigo": 8.5,
    # KPI adaptativo: o tamanho sai de `escala_kpi()`, pelo comprimento do valor.
    "kpi": 18, "kpi_medio": 15, "kpi_curto": 13, "kpi_rotulo": 8,
}
#: Entrelinha do corpo e grade de espaçamento (múltiplos de 4 pt).
ENTRELINHA = 1.15
GRADE_PT = 4

#: Cores dos gráficos, na ordem das séries/fatias (matplotlib usa "#RRGGBB").
CORES_GRAF = ["#0C3A30", "#A9812F", "#33705C", "#C9A75B"]

#: Tipografia padrão: existe em todo Office desde 2007 e, no Linux do sandbox,
#: o LibreOffice a substitui por Caladea/Carlito, **metricamente idênticas** —
#: o PDF gêmeo quebra a linha no mesmo lugar que o Word do cliente. É a única
#: forma de conferir o documento que o cliente realmente abre.
TIPOGRAFIA = {
    "office": {"serif": "Cambria", "sans": "Calibri"},
    # Editorial só para PDF, onde a fonte vai EMBUTIDA no arquivo.
    "editorial": {"serif": "Source Serif 4", "sans": "Source Sans 3"},
}


def paleta_para(cor_marca=None):
    """Paleta do documento. `cor_marca="RRGGBB"` substitui `tinta` e recalcula
    `apoio` (uma versão mais clara da própria marca), para o acento continuar
    coerente em vez de manter o verde original ao lado da cor do cliente."""
    pal = dict(PALETA)
    if not cor_marca:
        return pal
    hexa = str(cor_marca).lstrip("#").strip()
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", hexa):
        raise KitError("cor_marca deve ser um hex de 6 dígitos (ex.: \"0C3A30\"); recebi %r" % (cor_marca,))
    hexa = hexa.upper()
    pal["tinta"] = pal["primaria"] = pal["info_bd"] = hexa
    pal["apoio"] = pal["positivo"] = clareia(hexa, 0.32)
    return pal


def clareia(hexa, fracao):
    """Aproxima a cor do branco na fração dada (0 = igual, 1 = branco)."""
    hexa = str(hexa).lstrip("#")
    canais = [int(hexa[i:i + 2], 16) for i in (0, 2, 4)]
    return "".join("%02X" % min(255, int(c + (255 - c) * fracao)) for c in canais)


class KitError(ValueError):
    """Achado GRAVE de auditoria ou uso errado do kit: o arquivo não deve ser
    entregue como está.

    Herda de `ValueError` de propósito: os kits já levantavam `ValueError`
    para contrato inválido (coluna inexistente, `info` errado no gráfico), e
    quem tratava aquilo continua tratando isto."""


# ---------------------------------------------------------------------------
# 2. TEXTO
# ---------------------------------------------------------------------------

# Caractere de controle é ILEGAL em XML 1.0: escrevê-lo num .docx produz um
# arquivo que o Word recusa a abrir ("conteúdo ilegível"), e o openpyxl levanta
# IllegalCharacterError. Uma única célula com \x07 vinda de um PDF sujo
# derrubava a geração inteira.
_CONTROLES = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")

#: Hífen NÃO SEPARÁVEL (U+2011). Identificador quebrado no meio
#: ("17.3.0000000-\n1") é defeito visível numa ata que vai à Junta Comercial.
HIFEN_FIXO = "‑"


def limpa_texto(valor):
    """Normaliza e remove o que quebraria o XML do documento."""
    if valor is None:
        return ""
    return _CONTROLES.sub("", unicodedata.normalize("NFC", str(valor))).replace("\t", " ")


_IDENT = re.compile(
    r"\b(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}"          # CNPJ
    r"|\d{3}\.\d{3}\.\d{3}-\d{2}"                  # CPF
    r"|\d{2}\.\d\.\d{7}-\d"                        # NIRE
    r"|\d{5}-\d{3})\b")                            # CEP


def liga_identificadores(texto):
    """Troca o hífen de CNPJ/CPF/NIRE/CEP por hífen não separável.

    Só nesses padrões: trocar todo hífen do texto impediria a quebra normal de
    palavras compostas e alargaria a mancha justificada."""
    return _IDENT.sub(lambda m: m.group(0).replace("-", HIFEN_FIXO), limpa_texto(texto))


# ---------------------------------------------------------------------------
# 3. FORMATAÇÃO pt-BR — números pertencem ao KIT
# ---------------------------------------------------------------------------

_TIPOS_NUM = (int, float, Decimal)


def e_numero(valor):
    """O valor é um número DE VERDADE (não string formatada, não bool)?"""
    return isinstance(valor, _TIPOS_NUM) and not isinstance(valor, bool)


def _grupos(inteiro):
    s = str(inteiro)
    partes = []
    while len(s) > 3:
        partes.insert(0, s[-3:])
        s = s[:-3]
    partes.insert(0, s)
    return ".".join(partes)


def _decimal(valor, casas):
    """Arredonda meio-para-cima (o arredondamento contábil) e devolve
    `(sinal, parte inteira, parte decimal)` já como texto."""
    d = Decimal(str(valor))
    negativo = d < 0
    d = abs(d)
    fator = Decimal(10) ** casas
    # `int(x + Decimal("0.5"))` arredonda meio-para-cima; `round()` do Python usa
    # banker's rounding e devolveria 2 para 2,5, o que num total contábil vira
    # centavo faltando.
    inteiro_escalado = int((d * fator + Decimal("0.5")).to_integral_value(rounding="ROUND_FLOOR"))
    texto = str(inteiro_escalado).rjust(casas + 1, "0")
    return negativo, texto[:len(texto) - casas] if casas else texto, texto[len(texto) - casas:]


class _Fmt:
    """Formatação pt-BR. É a MESMA nos três kits — é o que impede um
    "R$ 1,89 mi" no Word ao lado de um "R$ 1.887.900,00" no Excel."""

    def moeda(self, valor, casas=2, simbolo="R$", parenteses=False):
        """`fmt.moeda(412300)` -> "R$ 412.300,00". `parenteses=True` escreve o
        negativo como "(R$ 1.234,56)", a convenção de demonstrativo contábil."""
        neg, inteiro, dec = _decimal(valor, casas)
        corpo = "%s %s" % (simbolo, _grupos(inteiro))
        if casas:
            corpo += "," + dec
        if not neg:
            return corpo
        return "(%s)" % corpo if parenteses else "-" + corpo

    def pct(self, valor, casas=1, ja_em_pct=False):
        """`fmt.pct(0.325)` -> "32,5%". `ja_em_pct=True` para quem passa 32.5."""
        v = Decimal(str(valor)) if ja_em_pct else Decimal(str(valor)) * 100
        neg, inteiro, dec = _decimal(v, casas)
        corpo = _grupos(inteiro) + ((("," + dec) if casas else "")) + "%"
        return ("-" + corpo) if neg else corpo

    def num(self, valor, casas=0):
        """`fmt.num(1284)` -> "1.284"."""
        neg, inteiro, dec = _decimal(valor, casas)
        corpo = _grupos(inteiro) + ((("," + dec) if casas else ""))
        return ("-" + corpo) if neg else corpo

    def data(self, valor=None):
        """`fmt.data(date(2026, 9, 2))` -> "02/09/2026". Sem argumento, HOJE."""
        if valor is None:
            valor = date.today()
        if isinstance(valor, datetime):
            valor = valor.date()
        if isinstance(valor, date):
            return valor.strftime("%d/%m/%Y")
        return limpa_texto(valor)

    _MESES = ("janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
              "agosto", "setembro", "outubro", "novembro", "dezembro")

    def data_extenso(self, valor=None):
        """`fmt.data_extenso(date(2026, 9, 2))` -> "02 de setembro de 2026"."""
        if valor is None:
            valor = date.today()
        if isinstance(valor, datetime):
            valor = valor.date()
        return "%02d de %s de %d" % (valor.day, self._MESES[valor.month - 1], valor.year)

    def cnpj(self, valor):
        d = re.sub(r"\D", "", str(valor))
        if len(d) != 14:
            return limpa_texto(valor)
        return "%s.%s.%s/%s-%s" % (d[:2], d[2:5], d[5:8], d[8:12], d[12:])

    def cpf(self, valor):
        d = re.sub(r"\D", "", str(valor))
        if len(d) != 11:
            return limpa_texto(valor)
        return "%s.%s.%s-%s" % (d[:3], d[3:6], d[6:9], d[9:])

    # ---- valor por extenso (pt-BR, sem dependência externa) ----
    _UNI = ("", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
            "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis",
            "dezessete", "dezoito", "dezenove")
    _DEZ = ("", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta",
            "setenta", "oitenta", "noventa")
    _CEM = ("", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos",
            "seiscentos", "setecentos", "oitocentos", "novecentos")

    def _ate_999(self, n):
        if n == 100:
            return "cem"
        partes = []
        c, resto = divmod(n, 100)
        if c:
            partes.append(self._CEM[c])
        if resto:
            if resto < 20:
                partes.append(self._UNI[resto])
            else:
                d, u = divmod(resto, 10)
                partes.append(self._DEZ[d] + (" e " + self._UNI[u] if u else ""))
        return " e ".join(partes)

    _ESCALAS = ((10 ** 9, "bilhão", "bilhões"), (10 ** 6, "milhão", "milhões"),
                (10 ** 3, "mil", "mil"))

    def _inteiro_extenso(self, n):
        if n == 0:
            return "zero"
        partes = []
        for valor, sing, plur in self._ESCALAS:
            quantos, n = divmod(n, valor)
            if not quantos:
                continue
            if valor == 10 ** 3:
                # "mil" não leva "um" na frente: 1.500 é "mil e quinhentos".
                partes.append(("mil" if quantos == 1 else self._inteiro_extenso(quantos) + " mil"))
            else:
                partes.append("%s %s" % (self._inteiro_extenso(quantos), sing if quantos == 1 else plur))
        if n:
            partes.append(self._ate_999(n))
        if len(partes) == 1:
            return partes[0]
        # Conjunção antes do ÚLTIMO grupo: "e" quando o resto final é menor que
        # 100 ou múltiplo de 100 ("mil e quinhentos", "dois milhões e quinhentos
        # mil"); espaço quando não é ("mil duzentos e trinta e quatro"). Os
        # grupos anteriores se separam por vírgula.
        juncao = " e " if (n < 100 or n % 100 == 0) else " "
        anteriores = ", ".join(partes[:-1])
        return anteriores + juncao + partes[-1]

    #: Escalas que pedem a preposição: "um milhão DE reais", nunca "um milhão reais".
    _PEDE_DE = ("milhão", "milhões", "bilhão", "bilhões")

    def extenso(self, valor, moeda_sing="real", moeda_plur="reais",
                cent_sing="centavo", cent_plur="centavos"):
        """`fmt.extenso(300000)` -> "trezentos mil reais"."""
        neg, inteiro, dec = _decimal(valor, 2)
        reais, centavos = int(inteiro), int(dec or 0)
        partes = []
        if reais or not centavos:
            texto_reais = self._inteiro_extenso(reais)
            unidade = moeda_sing if reais == 1 else moeda_plur
            ligacao = " de " if texto_reais.endswith(self._PEDE_DE) else " "
            partes.append(texto_reais + ligacao + unidade)
        if centavos:
            partes.append("%s %s" % (self._inteiro_extenso(centavos),
                                     cent_sing if centavos == 1 else cent_plur))
        texto = " e ".join(partes)
        return ("menos " + texto) if neg else texto


fmt = _Fmt()

#: Tipos de coluna aceitos por `tabela(...)` nos três kits.
TIPOS_COLUNA = ("moeda", "pct", "milhar", "data", "texto")


def formata_valor(valor, tipo=None, parenteses=False):
    """Formata UM valor conforme o tipo da coluna. Texto passa intacto — é o
    que permite "—" ou "n/d" numa coluna numérica sem quebrar a tabela."""
    if valor is None:
        return ""
    if tipo == "data":
        return fmt.data(valor)
    if not e_numero(valor):
        return limpa_texto(valor)
    if tipo == "moeda":
        return fmt.moeda(valor, parenteses=parenteses)
    if tipo == "pct":
        return fmt.pct(valor)
    if tipo == "milhar":
        return fmt.num(valor)
    # Número sem tipo declarado: milhar com as casas que ele tiver.
    casas = 0 if float(valor) == int(float(valor)) else 2
    return fmt.num(valor, casas)


def tipos_de_coluna(cabecalho, moeda=None, pct=None, milhar=None, data=None):
    """Mapa `índice da coluna -> tipo`, a partir das listas de NOMES de coluna.

    Nome que não existe no cabeçalho é erro do script, não silêncio: sem isto,
    um `moeda=["Valor"]` num cabeçalho que diz "Valor mensal" saía sem formato
    nenhum e ninguém percebia."""
    tipos = {}
    for lista, tipo in ((moeda, "moeda"), (pct, "pct"), (milhar, "milhar"), (data, "data")):
        for nome in (lista or []):
            if nome not in cabecalho:
                raise KitError(
                    "tabela: a coluna %r (%s=) não existe no cabeçalho %s"
                    % (nome, tipo, list(cabecalho)))
            tipos[list(cabecalho).index(nome)] = tipo
    return tipos


def normaliza_linhas(cabecalho, linhas):
    """Toda linha com EXATAMENTE o nº de colunas do cabeçalho.

    Devolve `(linhas normalizadas, achados)`: completar em silêncio esconde o
    erro do script, e derrubar com IndexError perde o documento inteiro. O kit
    faz as duas coisas certas — completa e ACUSA."""
    ncols = len(cabecalho)
    saida, achados = [], []
    for i, linha in enumerate(linhas):
        linha = list(linha)
        if len(linha) != ncols:
            achados.append(achado(
                "grave", "linha-fora-do-cabecalho",
                "linha %d tem %d valor(es) e o cabeçalho tem %d (%s)"
                % (i + 1, len(linha), ncols, list(cabecalho))))
        saida.append(linha[:ncols] + [""] * (ncols - len(linha)))
    return saida, achados


def linha_de_total(cabecalho, linhas, tipos, rotulo="TOTAL"):
    """Linha de TOTAL somando as colunas numéricas. O kit calcula — o modelo
    não escreve o total à mão (era de onde saíam somas que não fechavam)."""
    ncols = len(cabecalho)
    total = [""] * ncols
    total[0] = rotulo
    for j in range(ncols):
        if tipos.get(j) == "data":
            continue
        valores = [l[j] for l in linhas if j < len(l) and e_numero(l[j])]
        if not valores:
            continue
        if tipos.get(j) == "pct":
            # Somar percentuais dá um número sem significado. A linha fica vazia.
            continue
        soma = sum(Decimal(str(v)) for v in valores)
        total[j] = float(soma) if soma % 1 else int(soma)
    return total


# ---------------------------------------------------------------------------
# 4. REGRAS DE LEITURA (KPI, eixo de gráfico)
# ---------------------------------------------------------------------------

def escala_kpi(texto):
    """Tamanho do valor do cartão de KPI pelo COMPRIMENTO do texto exibido.

    Tamanho fixo é o que fazia "R$ 1.887.900,00" quebrar em duas linhas ao lado
    de "32,5%" — cartões da mesma fileira com alturas diferentes."""
    n = len(str(texto or ""))
    if n <= 9:
        return ESCALA["kpi"]
    if n <= 13:
        return ESCALA["kpi_medio"]
    return ESCALA["kpi_curto"]


def linhas_de_kpi(itens, por_linha=3):
    """5 ou 6 KPIs viram DUAS linhas de 3 — seis cartões numa fileira só ficam
    com 3 cm cada e nenhum valor cabe."""
    itens = list(itens)
    if len(itens) <= 4:
        return [itens]
    return [itens[i:i + por_linha] for i in range(0, len(itens), por_linha)]


def eixo_milhar(valores):
    """`(divisor, sufixo)` do eixo de valor. Acima de 100 mil o eixo vai em
    milhares: "R$ 600.000,00" em cada marca do eixo é ilegível e desalinha o
    gráfico inteiro."""
    planos = [abs(float(v)) for serie in valores for v in serie
              if isinstance(v, _TIPOS_NUM) and not isinstance(v, bool)]
    maximo = max(planos) if planos else 0
    if maximo >= 1_000_000:
        return 1_000_000, "milhões"
    if maximo > 100_000:
        return 1_000, "mil"
    return 1, ""


# ---------------------------------------------------------------------------
# 5. AUDITORIA COMPARTILHADA
# ---------------------------------------------------------------------------

#: Marcas de rascunho que NUNCA podem sair numa entrega. Todo `salvar()` varre o
#: arquivo pronto atrás delas.
PLACEHOLDER = re.compile(
    r"DD/MM|AAAA|\[[^\]]*\]|\bXX+\b|Seu Nome|Lorem|Cidade/Estado|00000-000",
    re.IGNORECASE)


def achado(gravidade, codigo, mensagem):
    return {"gravidade": gravidade, "codigo": codigo, "mensagem": mensagem}


def achados_de_placeholder(textos, onde="documento"):
    """Achados de placeholder num conjunto de textos já extraídos do arquivo."""
    encontrados = []
    for texto in textos:
        for m in PLACEHOLDER.finditer(str(texto or "")):
            encontrados.append(m.group(0))
    if not encontrados:
        return []
    unicos = sorted(set(encontrados))[:8]
    return [achado("grave", "placeholder",
                   "%d marca(s) de rascunho no %s: %s — substitua por dado real "
                   "ou omita o campo" % (len(encontrados), onde, unicos))]


#: Texto de serviço que aparece em toda página e NÃO conta como conteúdo.
_SERVICO = re.compile(r"Página\s*\d+\s*de\s*\d+|CONFIDENCIAL|CONTATO|TESTEMUNHAS",
                      re.IGNORECASE)
#: Abaixo disto a página não tem conteúdo nenhum (só serviço e fechamento).
MINIMO_DE_CONTEUDO = 40


def _resto_da_pagina(texto, descartar):
    """O que sobra da página depois de tirar o material de FECHAMENTO.

    Contar caracteres crus não serve: uma página que fecha o documento com um
    gráfico, o fecho, a assinatura e a faixa de contatos tem pouco texto e é
    perfeitamente legítima. O que caracteriza a assinatura órfã é não sobrar
    NADA quando se tira o fechamento."""
    resto = texto
    for trecho in descartar:
        if trecho:
            resto = resto.replace(str(trecho), " ")
    return re.sub(r"\s+", "", _SERVICO.sub(" ", resto))


def achados_de_paginacao(paginas, assinantes=(), fechamento=(), ultima_e_arte=False):
    """Página em branco e assinatura sozinha numa página.

    `assinantes` = `[(nome, cargo)]`; `fechamento` = as demais linhas do fecho
    (local/data, contatos, nota, emissor) — tudo que é material de encerramento
    e por isso não conta como conteúdo da página. `ultima_e_arte=True` quando o
    documento fecha com uma CONTRACAPA de página inteira: ela é mancha de tinta
    com o nome do emissor, e cobrar dela 40 caracteres de texto seria cobrar o
    que ela não tem por design."""
    descartar = [n for n, _ in assinantes] + [c for _, c in assinantes] + list(fechamento)
    nomes = [n for n, _ in assinantes if n]
    achados = []
    for i, texto in enumerate(paginas, start=1):
        if i == 1 or (ultima_e_arte and i == len(paginas)):
            continue                      # capa e contracapa são curtas por design
        cru = re.sub(r"\s+", "", texto)
        if len(cru) < MINIMO_DE_CONTEUDO:
            achados.append(achado("grave", "pagina-vazia",
                                  "a página %d tem menos de %d caracteres"
                                  % (i, MINIMO_DE_CONTEUDO)))
        elif nomes and any(n in texto for n in nomes) and \
                len(_resto_da_pagina(texto, descartar)) < MINIMO_DE_CONTEUDO:
            achados.append(achado(
                "grave", "assinatura-orfa",
                "a página %d contém praticamente só o bloco de assinatura — "
                "o fecho tem de viajar junto com o conteúdo anterior" % i))
    return achados


def relatorio(achados, **extra):
    """Formato ÚNICO de retorno de `salvar()` nos três kits."""
    achados = list(achados or [])
    saida = {"ok": not any(a["gravidade"] == "grave" for a in achados),
             "achados": achados}
    saida.update(extra)
    return saida


def falha_se_grave(rel, kit):
    """Levanta `KitError` quando a auditoria encontrou achado grave. O modelo lê
    a mensagem e corrige o SCRIPT — em vez de "lembrar de conferir"."""
    graves = [a for a in rel["achados"] if a["gravidade"] == "grave"]
    if graves:
        raise KitError("%s: o arquivo gerado não passou na auditoria — %s"
                       % (kit, "; ".join("[%s] %s" % (a["codigo"], a["mensagem"])
                                         for a in graves)))
    return rel


# ---------------------------------------------------------------------------
# 6. GRÁFICOS (matplotlib com a paleta e as regras de leitura)
# ---------------------------------------------------------------------------

def _plt(pal):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = "sans-serif"
    plt.rcParams["font.sans-serif"] = ["Carlito", "Calibri", "DejaVu Sans"]
    plt.rcParams["axes.edgecolor"] = "#" + pal["borda"]
    plt.rcParams["text.color"] = "#" + pal["corpo"]
    plt.rcParams["xtick.color"] = "#" + pal["cinza"]
    plt.rcParams["ytick.color"] = "#" + pal["cinza"]
    return plt


def _acaba(plt, fig, pal, caminho, largura_cm, altura_cm):
    for ax in fig.axes:
        for lado in ("top", "right", "left"):
            ax.spines[lado].set_visible(False)
        ax.spines["bottom"].set_color("#" + pal["borda"])
        ax.tick_params(length=0, labelsize=8)
        ax.set_axisbelow(True)
    fig.set_size_inches(largura_cm / 2.54, altura_cm / 2.54)
    fig.tight_layout()
    fig.savefig(caminho, dpi=200, facecolor="white", bbox_inches="tight")
    plt.close(fig)
    return caminho


def grafico_barras_png(caminho, categorias, series, pal=None, largura_cm=16.0,
                       altura_cm=7.0, sufixo_eixo=""):
    """Barras verticais. Aplica as regras de leitura: eixo em milhar quando o
    maior valor passa de 100.000, legenda só com 2+ séries e rótulo de valor
    quando há até 8 barras."""
    pal = pal or PALETA
    if not isinstance(series, dict):
        series = {"": list(series)}
    divisor, escala_nome = eixo_milhar(series.values())
    plt = _plt(pal)
    fig, ax = plt.subplots()
    ns = max(1, len(series))
    larg = 0.8 / ns
    x = range(len(categorias))
    total_barras = ns * len(list(categorias))
    for si, (nome, vals) in enumerate(series.items()):
        vals = [float(v) / divisor for v in vals]
        pos = [xi + si * larg - 0.4 + larg / 2 for xi in x]
        barras = ax.bar(pos, vals, width=larg * 0.9,
                        color=CORES_GRAF[si % len(CORES_GRAF)], label=nome or None)
        if total_barras <= 8:
            ax.bar_label(barras, fmt="%.0f" if divisor > 1 else "%g",
                         fontsize=7.5, padding=2,
                         color="#" + pal["cinza"])
    ax.set_xticks(list(x))
    ax.set_xticklabels([limpa_texto(c) for c in categorias])
    ax.grid(axis="y", color="#" + pal["borda"], linewidth=0.6)
    rotulo_eixo = (sufixo_eixo or "").strip()
    if escala_nome:
        rotulo_eixo = ("%s (em %s)" % (rotulo_eixo, escala_nome)).strip() if rotulo_eixo \
            else "em %s" % escala_nome
    if rotulo_eixo:
        ax.set_ylabel(rotulo_eixo, fontsize=8, color="#" + pal["cinza"])
    # Legenda só faz sentido com 2+ séries: com uma série ela repete o título.
    if len([n for n in series if n]) >= 2:
        ax.legend(frameon=False, fontsize=8, loc="upper left")
    return _acaba(plt, fig, pal, caminho, largura_cm, altura_cm)


def grafico_linhas_png(caminho, categorias, series, pal=None, largura_cm=16.0,
                       altura_cm=7.0, sufixo_eixo=""):
    pal = pal or PALETA
    if not isinstance(series, dict):
        series = {"": list(series)}
    divisor, escala_nome = eixo_milhar(series.values())
    plt = _plt(pal)
    fig, ax = plt.subplots()
    for si, (nome, vals) in enumerate(series.items()):
        ax.plot(range(len(categorias)), [float(v) / divisor for v in vals],
                linewidth=2.2, marker="o", markersize=4,
                color=CORES_GRAF[si % len(CORES_GRAF)], label=nome or None)
    ax.set_xticks(range(len(categorias)))
    ax.set_xticklabels([limpa_texto(c) for c in categorias])
    ax.grid(axis="y", color="#" + pal["borda"], linewidth=0.6)
    rotulo_eixo = (sufixo_eixo or "").strip()
    if escala_nome:
        rotulo_eixo = ("%s (em %s)" % (rotulo_eixo, escala_nome)).strip() if rotulo_eixo \
            else "em %s" % escala_nome
    if rotulo_eixo:
        ax.set_ylabel(rotulo_eixo, fontsize=8, color="#" + pal["cinza"])
    if len([n for n in series if n]) >= 2:
        ax.legend(frameon=False, fontsize=8, loc="upper left")
    return _acaba(plt, fig, pal, caminho, largura_cm, altura_cm)


def grafico_pizza_png(caminho, rotulos, valores, pal=None, largura_cm=11.0,
                      altura_cm=7.0):
    pal = pal or PALETA
    plt = _plt(pal)
    fig, ax = plt.subplots()
    cores = [CORES_GRAF[i % len(CORES_GRAF)] for i in range(len(valores))]
    ax.pie([float(v) for v in valores], labels=[limpa_texto(r) for r in rotulos],
           colors=cores, autopct="%1.0f%%", pctdistance=0.78,
           textprops={"fontsize": 8},
           wedgeprops={"width": 0.42, "edgecolor": "white", "linewidth": 2})
    return _acaba(plt, fig, pal, caminho, largura_cm, altura_cm)
