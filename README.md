<div align="center">

# 🎨 Frederico IA Studio

### Seu estúdio de IA, em português — com arquivo de verdade no final.

Peça no chat e receba **planilha, Word, PDF, gráfico ou código** gerados num
sandbox Docker isolado. Não é “texto que descreve o arquivo”: é o arquivo.

![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=white&labelColor=20232a)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white&labelColor=20232a)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white&labelColor=20232a)
![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?logo=docker&logoColor=white&labelColor=20232a)
![Status](https://img.shields.io/badge/Produ%C3%A7%C3%A3o-amarelo%20%C2%B7%20apto%20com%20restri%C3%A7%C3%B5es-e3b341)
![LGPD](https://img.shields.io/badge/LGPD-exportar%20%C2%B7%20apagar%20%C2%B7%20consentimento-8957e5)

<img src="docs/tela-chat.png" alt="Tela principal do chat do Frederico IA Studio" width="900">

**[Começar](#-começar-em-2-minutos)** · **[Recursos](#-recursos)** ·
**[Limites conhecidos](#-limites-conhecidos)** · **[Documentação](#-documentação)**

</div>

---

## 💡 O que você pede — e o que chega no chat

| Você escreve | Você recebe |
|---|---|
| “Monte uma planilha de fluxo de caixa” | `.xlsx` com fórmulas recalculadas e conferidas |
| “Faça um relatório em Word a partir deste PDF” | `.docx` diagramado com tabelas e paginação |
| “Transforme isto numa proposta para o cliente” | `.pdf` com capa, sumário e auditoria de formatação |
| “Fotografei esta nota fiscal — extraia os dados” | Leitura por visão ou OCR |
| “Clone meu repositório, corrija este bug e abra um PR” | Fluxo de desenvolvimento com GitHub |

Compatível com **OpenRouter**, **DeepSeek** e endpoints no padrão da API OpenAI.
O modelo escolhido é enviado diretamente ao provedor, sem substituição silenciosa.

---

## 🚀 Começar em 2 minutos

**Pré-requisito:** Docker Desktop em execução.

```bash
cp .env.example .env        # Windows: Copy-Item .env.example .env
docker compose up --build
```

No `.env`, configure pelo menos:

```env
BETTER_AUTH_URL=http://localhost:5173
BETTER_AUTH_SECRET=gere_com_openssl_rand_hex_32
```

Abra [http://localhost:5173](http://localhost:5173), crie sua conta e pronto.
Consulte [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md) para VPS, HTTPS e demais variáveis.

---

## ✨ Recursos

- **Arquivos reais no chat:** Excel, Word, PDF, CSV, ZIP, imagens, gráficos e OCR.
- **Documentos com design:** kits para documentos com capa, sumário, tabelas,
  indicadores, assinaturas e rodapé paginado.
- **Modo Design:** protótipos HTML, apresentações 16:9 e documentos A4, com
  versões, prévia isolada e exportação.
- **Nino, o copiloto:** estados ligados à atividade real, memória própria,
  ações explícitas e botão para ocultar/mostrar.
- **Memória e continuidade:** recuperação semântica com pgvector e contexto por projeto.
- **Vários modelos:** comparação, debate, especialistas em sequência e controle de custo.
- **Modo Desenvolvedor:** projetos com memória, modos de trabalho, sessão semeada
  no chat, explorador, sandbox e permissões de GitHub por branch.
- **Execução isolada:** sandbox Docker para Python, Bash, documentos, PDF, OCR e Node.
- **Multiusuário e LGPD:** Better Auth, isolamento por conta, consentimento,
  exportação e exclusão de dados.

---

## 🔒 Segurança e privacidade

O Studio separa conta, projeto, conversa e arquivos por usuário. Chaves de IA e
tokens do GitHub ficam cifrados no banco. O backend não entrega o socket do Docker
ao usuário: requisições passam pelo serviço `docker-guard` e por validações de
posse e allowlist.

Uploads reportam o estado real do antivírus (`verificado`, `degradado` ou
`sem-antivirus`). A sandbox roda sem privilégios, com limites de CPU, memória e
processos; rede fica desligada por padrão. Conteúdo enviado ao modelo pode ser
transmitido ao provedor configurado, então não envie dados sensíveis sem avaliar
LGPD e sigilo.

---

## ⚠️ Limites conhecidos

**Prontidão para produção: 🟡 amarelo — apto com restrições.** Este repositório
contém um Studio funcional e exercitado, mas não deve ser anunciado como SaaS
público sem operação responsável.

- A sandbox com rede liberada ainda não possui allowlist completa de destinos;
  máquina dedicada continua recomendada como defesa em profundidade.
- Qualquer pessoa pode se cadastrar quando o serviço está público; considere
  confirmação/aprovação de conta e mantenha limites de uso ativos.
- Disponibilidade de modelos, preços, OCR, ClamAV e exportações depende da
  configuração dos serviços e provedores usados na implantação.
- O pré-voo do GitHub não substitui a validação de escopos do PAT no momento do push.
- Só anuncie uma proteção quando ela estiver ativa na implantação; consulte o
  healthcheck e o estado do antivírus.

---

## 📚 Documentação

| Documento | Conteúdo |
|---|---|
| [REGRAS-DO-PROJETO.md](REGRAS-DO-PROJETO.md) | Constituição de engenharia |
| [CONTINUIDADE.md](CONTINUIDADE.md) | Estado atual, riscos e retomada |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitetura e fluxos reais |
| [docs/SECURITY.md](docs/SECURITY.md) | Modelo de ameaça e isolamento |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook de operação |
| [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md) | Configuração e implantação |
| [docs/TESTING.md](docs/TESTING.md) | Testes e lacunas conhecidas |
| [docs/AUDITORIA_2026-07.md](docs/AUDITORIA_2026-07.md) | Auditoria e prontidão |
| [docs/DESIGN_STUDIO.md](docs/DESIGN_STUDIO.md) | Modo Design |
| [docs/FREDERICO_COMPANION.md](docs/FREDERICO_COMPANION.md) | Copiloto Nino |
| [VPS-DEPLOY.md](VPS-DEPLOY.md) | Publicação em VPS com HTTPS |

## 🤝 Contribuir

Antes de abrir um PR, leia o [REGRAS-DO-PROJETO.md](REGRAS-DO-PROJETO.md). Toda
mudança relevante deve atualizar `CONTINUIDADE.md`, passar por `npm run check` nos
lados afetados e registrar honestamente o que foi exercitado e o que permanece
limitado.

<div align="center">

Feito com ☕ por [fredabsd-svg](https://github.com/fredabsd-svg)

</div>
