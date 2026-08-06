# ADR 0001 — Adoção das Regras do Projeto

Data: 2026-08-05

## Contexto

O repositório operava com um checklist operacional curto (`CLAUDE.md`), escrito
para uma ferramenta de IA específica. As práticas de engenharia — documentação
como parte do produto, fronteiras de arquitetura, banco e migrations, contratos e
SSE, agentes e menor privilégio, segurança e segredos, sandbox e kits de
documento, frontend e acessibilidade, testes e portões, Git e PRs, operação e
release — eram seguidas na prática, mas não estavam codificadas em lugar nenhum.

Quem abrisse o repositório por fora daquela ferramenta (uma pessoa, outro agente,
uma automação) não tinha onde ler as fronteiras que o projeto já respeitava. Isso
criava dois riscos:

1. **Divergência silenciosa:** uma mudança feita por alguém que não conhece as
   convenções poderia violar uma fronteira sem que houvesse um documento para
   apontar a violação.
2. **Dependência de ferramenta:** as regras moravam num arquivo cujo formato e
   localização são específicos de um produto; trocar de ferramenta ou adicionar
   uma segunda queimaria a governança.

## Decisão

Criar o arquivo `REGRAS-DO-PROJETO.md` como a constituição de engenharia do
repositório — um documento autônomo, em português, com treze regras numeradas que
codificam as fronteiras e os portões de qualidade do projeto.

O `CLAUDE.md` permanece como checklist operacional do dia a dia, explicitamente
subordinado às regras: onde os dois divergirem, as regras prevalecem. Um ponteiro
no topo do `CLAUDE.md` garante que toda sessão de IA carregue as regras antes de
qualquer mudança.

As regras cobrem:

| Regra | Domínio |
| --- | --- |
| 0 | Precedência e forma de adoção |
| 1 | Documentação é parte do produto |
| 2 | Fronteiras de arquitetura |
| 3 | Banco de dados e migrations |
| 4 | APIs, SSE e contratos |
| 5 | Agentes, modelos e ferramentas |
| 6 | Segurança, privacidade e segredos |
| 7 | Sandbox, Docling e kits de documento |
| 8 | Frontend, UX e acessibilidade |
| 9 | Testes e portões de qualidade |
| 10 | Git, commits e Pull Requests |
| 11 | Decisões e ADRs |
| 12 | Operação e release |
| 13 | Adoção sem criar caos |

A Regra 13 reconhece dívida legada (README acumulado, ausência de cabeçalho de
estado nos docs, diretório de ADRs inexistente, verificações documentais não
automatizadas) e estabelece o princípio de não criar dívida nova: novo subsistema
já nasce documentado, nova decisão estrutural já nasce com ADR, novo contrato já
nasce testado.

## Alternativas descartadas

### Manter só o `CLAUDE.md`

Rejeitada porque o arquivo é curto por definição (checklist), depende de uma
ferramenta específica e não cobre quem chega por outro caminho. As regras
precisam ser encontráveis por qualquer pessoa que leia o repositório.

### Criar regras separadas por ferramenta

Rejeitada porque fragmentaria a governança. A mesma fronteira de segurança não
pode ter duas interpretações dependendo de qual ferramenta a está lendo.

### Não fazer nada

Rejeitada porque a dívida de governança cresceria com cada novo contribuidor ou
agente. As práticas existiam, mas eram invisíveis — e o que é invisível não é
verificável.

## Consequências

**Positivas:**

- As fronteiras do projeto passam a ser verificáveis por qualquer pessoa ou
  agente, independentemente da ferramenta que estiver usando.
- O `CLAUDE.md` fica mais enxuto, remetendo às regras para os detalhes.
- A Regra 13 cria um caminho de adoção progressiva: as lacunas conhecidas são
  reconhecidas como dívida legada, e o princípio "sem dívida nova" impede que
  elas cresçam.
- O template de Pull Request (`.github/pull_request_template.md`) e este ADR
  são os primeiros artefatos criados sob as novas regras, provando o ciclo.

**Negativas:**

- As regras são extensas (760 linhas). Quem chega precisa lê-las antes de
  qualquer mudança (a Regra 10.1 exige isso), o que adiciona atrito inicial.
- A dívida legada listada na Regra 13.1 continua existindo e exigirá frentes
  próprias para ser reduzida — o arquivo não a elimina, só a reconhece.

**Riscos:**

- Se as regras não forem mantidas atualizadas conforme o produto evolui, elas
  passam a descrever um projeto que não existe mais, criando o problema inverso
  ao que pretendem resolver. O cabeçalho de estado (Regra 1.5) e a regra do
  toque (Regra 13.3) existem para mitigar isso.
- A extensão pode desestimular a leitura completa. O `CLAUDE.md` como checklist
  curto mitiga esse risco para o uso diário.

**Artefatos relacionados:**

- `REGRAS-DO-PROJETO.md` — a constituição (publicada).
- `CLAUDE.md` — checklist operacional subordinado (atualizado).
- `docs/RELATORIO_ADAPTACAO_REGRAS.md` — relatório histórico da adaptação.
- `.github/pull_request_template.md` — template de PR alinhado à Regra 10.3
  (criado junto com este ADR).