<div align="center">

# 🎨 Frederico IA Studio

### Seu estúdio de IA, em português.

**Converse, peça e receba o arquivo pronto.** Planilhas com fórmulas, documentos
Word diagramados, PDFs, gráficos e código — gerados de verdade num sandbox
isolado, não descritos em texto.

![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=white&labelColor=20232a)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white&labelColor=20232a)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white&labelColor=20232a)
![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?logo=docker&logoColor=white&labelColor=20232a)
![Status](https://img.shields.io/badge/SaaS%20multiusu%C3%A1rio-em%20produ%C3%A7%C3%A3o-2ea043)
![LGPD](https://img.shields.io/badge/LGPD-conformidade%20embutida-8957e5)

<img src="docs/tela-chat.png" alt="Tela principal do chat do Frederico IA Studio" width="900">

**[Começar](#-começar-em-2-minutos)** · **[Recursos](#-o-que-tem-dentro)** ·
**[Segurança](#-segurança-e-privacidade)** · **[Documentação](#-documentação)**

</div>

---

## 💡 O que você pede — e o que chega no chat

| Você escreve | Você recebe |
|---|---|
| *"Monte uma planilha de fluxo de caixa com estes lançamentos"* | `.xlsx` com fórmulas **recalculadas e conferidas** |
| *"Faça um relatório em Word a partir deste PDF"* | `.docx` com capa, tabelas estilizadas e rodapé paginado |
| *"Fotografei esta nota fiscal — extraia os dados"* | Leitura por **visão ou OCR**, sem você digitar nada |
| *"Consulte o CNPJ 00.000.000/0001-91"* | Razão social, situação, CNAE, endereço e sócios (dados oficiais) |
| *"Pesquise as mudanças da reforma tributária e resuma"* | Busca na web com **miniatura real** das páginas abertas |
| *"Clone meu repositório, corrija este bug e abra um PR"* | Commit e Pull Request no GitHub, direto pelo chat |

Compatível com **OpenRouter**, **DeepSeek** e qualquer endpoint no padrão da API
OpenAI. O modelo que você escolhe é enviado direto ao provedor, **sem
substituição silenciosa**.

---

## 🚀 Começar em 2 minutos

**Pré-requisitos:** Docker Desktop em execução.

```bash
# 1. Configure o ambiente
cp .env.example .env        # Windows: Copy-Item .env.example .env

# 2. Suba o aplicativo
docker compose up --build
```

No `.env`, preencha apenas estes dois valores:

```env
BETTER_AUTH_URL=http://localhost:5173
BETTER_AUTH_SECRET=gere_com_openssl_rand_hex_32
```

Abra **[http://localhost:5173](http://localhost:5173)**, crie sua conta e pronto.
No Windows, o `iniciar.bat` faz tudo com um clique.

> 🆓 **Sem chave de API?** Se o administrador ligou o **modo gratuito**, você
> conversa na hora. Senão, um assistente passo a passo guia a criação da sua chave
> em OpenRouter, DeepSeek, Groq, Gemini ou Mistral.

<details>
<summary><b>🔐 Chaves e criptografia (opcional)</b></summary>

<br>

A `ENCRYPTION_KEY` — que cifra suas chaves de IA e o token do GitHub no banco —
é **gerada automaticamente** na primeira subida e salva em `data/encryption.key`.
Você só precisa defini-la manualmente se quiser controlar a chave você mesmo
(SaaS / gerenciador de segredos). **Nunca a troque depois de conectar contas.**

GitHub e Google são opcionais — deixe as credenciais OAuth vazias para usar só
e-mail/senha.

</details>

📱 **Acesso pelo celular, VPS com HTTPS e todas as variáveis:**
veja **[docs/CONFIGURACAO.md](docs/CONFIGURACAO.md)**.

---

## ✨ O que tem dentro

### 💬 Conversa que produz resultado

- **Arquivos reais no chat** — Excel, Word, PDF, CSV, ZIP, imagens, gráficos e OCR.
- **Documentos com design de agência** — kits prontos e testados (capa, tabelas
  estilizadas, gráficos, callouts, rodapé paginado), com modo **sóbrio/registrável**
  para ata e contrato.
- **Câmera e imagens** — fotografe um documento pelo celular ou pela webcam; a IA
  lê sozinha (visão nos modelos com visão, OCR nos demais).
- **Consulta de CNPJ** — dados cadastrais oficiais (BrasilAPI/ReceitaWS).
- **Voz** — ditado por voz para escrever sem digitar.
- **Multiconversa** — várias conversas processando **ao mesmo tempo**; trocar de
  conversa não interrompe nem mistura nada.
- **Retomada real** — tarefa interrompida salva o estado no banco; **Continuar de
  onde parei** retoma do ponto exato, mesmo após reiniciar o servidor.

### 🌱 Nino, o copiloto

O personagem que acompanha o Studio — e explica o que está acontecendo.

- **Estados ao vivo**: pensando, analisando, digitando, sugestão, dúvida — lidos
  da atividade real do app, nunca inventados.
- **Painel próprio** com conversa e documentos, separado do chat principal.
- **Proatividade transparente**: cada alerta registra origem, horário, dados
  enviados e a autorização necessária. Você define o modo (silencioso, auxiliar,
  proativo, foco, apresentação) e o nível de permissão.
- **Diagnósticos, saúde e permissões** em painel dedicado, com base de incidentes
  e log de auditoria.

### 🧠 Memória e contexto

- **Memória de longo prazo** com recuperação semântica (pgvector) e painel de
  revisão — o assistente lembra do que importa, com isolamento por cliente.
- **Continuidade por projeto** — a recuperação é **em camadas, por prioridade**:
  primeiro o projeto ativo e as suas últimas conversas, depois as decisões e
  correções já registradas, depois o que se liga ao assunto e, por último, o
  perfil geral. Um **chat novo dentro de um projeto continua de onde parou** em
  vez de começar do zero: `dev_projects` guarda o projeto no servidor e
  `project_id` carimba conversas, trechos e memórias, então o vínculo é real e
  não um palpite por semelhança de texto. O rastro abaixo de cada resposta
  mostra o projeto reconhecido e o motivo de cada item recuperado.
- **Assistentes personalizados** — instruções, modelos, ferramentas e
  personalidade próprios.
- **Compreensão documental (Docling)** — PDFs processados **uma vez** (layout,
  tabelas, OCR) e reaproveitados por todos os modelos, com referência de página.

### 🧩 Vários modelos, uma resposta

- **Sistema Multimodelo** — 2+ IAs na mesma mensagem: comparação lado a lado,
  conselho de IAs, debate em rodadas e especialistas em sequência.
- **Custo sob controle** — função por modelo, estimativa de custo, orçamento
  máximo, interrupção por modelo e equipes salvas (presets).
- **Catálogo com logos oficiais** (servidos localmente, sem CDN), filtro por
  fornecedor e selo de **classificação de referência** (S+ a B).
- **Modo Equipe** — combina perspectivas de vários assistentes.

### 💻 Desenvolvimento e automação

- **Sandbox Docker** — um container por conversa para Python, Bash e geração de
  arquivos, com a caixa de ferramentas já montada: planilhas e dados (pandas,
  polars, duckdb), documentos e PDF (python-docx, reportlab, PyMuPDF, OCR),
  compiladores (C/C++, Go, Rust, Java, C#, Kotlin), Node e Chromium headless com
  Playwright, e APIs **REST e GraphQL** (Flask, FastAPI e strawberry-graphql).
- **Ambiente de Trabalho da IA** — terminal, código, arquivos, pesquisa e
  navegador agrupados em **uma sessão ao vivo**, com passo a passo e miniatura
  real das páginas abertas.
- **Modo Desenvolvedor** — projetos com memória permanente, explorador de
  arquivos e seis modos de trabalho (Perguntar, Planejar, Implementar, Corrigir
  erro, Revisar e Agente autônomo).
- **Conector GitHub** — clone, alteração e **push ou Pull Request em 1 clique**;
  o token fica cifrado e nunca entra no sandbox.
- **Sub-agentes** — o próprio agente delega uma subtarefa a um `runAgent` completo,
  com ferramentas e uma janela de contexto **própria e descartável** (sem histórico
  nem memória da conversa); os arquivos gerados aparecem normalmente em `outputs/`.
  Delegar **não amplia acesso**: o sub-agente nunca recebe mais ferramentas, rede ou
  escrita do que o agente que o chamou. Você escolhe o especialista entre os
  assistentes que já cadastrou — e vê no cartão quem executou e com qual modelo.
- **Rotinas** — tarefas que rodam sozinhas em horários marcados.
- **Tarefas em segundo plano**, caixa de entrada por cliente e templates de pedido.

### ⚙️ Administração

- **Central de Configurações** — tudo em um só lugar: aparência, copiloto,
  provedores, assistentes, desenvolvimento, sandbox e rede, privacidade e avançado.
- **Análises de uso** — tokens, custos e consumo por modelo.
- **Painel do modo gratuito** — usuários, limites, modelos e bloqueio por abuso,
  sem reiniciar.
- **Backup completo** (banco + workspaces) e **Pastas do PC** liberadas sob demanda.

<div align="center">
<table>
<tr>
<td><img src="docs/painel-memoria.png" alt="Painel de memória" width="440"></td>
<td><img src="docs/tela-login.png" alt="Tela de login com Better Auth" width="330"></td>
</tr>
<tr>
<td align="center"><em>Memória de longo prazo com busca semântica</em></td>
<td align="center"><em>Login com Better Auth: e-mail, GitHub e Google</em></td>
</tr>
</table>
</div>

---

## 🔒 Segurança e privacidade

**Multiusuário de verdade:** cada pessoa cria a própria conta (Better Auth) e só
enxerga os próprios dados — posse verificada em cada consulta. Suporte **BYOK**:
cada usuário usa a **própria chave** de IA (ideal para um site público), ou uma
chave única do servidor para uso pessoal/de equipe.

| | |
|---|---|
| 🔐 **Segredos cifrados** | Chaves de IA e token do GitHub em AES-256-GCM; senhas com hash (scrypt) |
| 🐳 **Backend sem o socket do Docker** | Quem o detém é o serviço `docker-guard`, que valida cada requisição ao daemon (allowlist de rotas, inspeção do corpo de `/containers/create`, posse por label) |
| 🛡️ **Antivírus honesto nos uploads** | Todo arquivo é escaneado (ClamAV) antes de ser salvo, e a resposta diz se foi `verificado`, `degradado` ou `sem-antivirus` — **nada é apresentado como verificado sem ter sido analisado** |
| 🧱 **Camada HTTP endurecida** | `helmet`, CORS restrito à própria origem, rate limiting por IP e validação `zod` |
| 🛰️ **Anti-SSRF no `web_fetch`** | Bloqueia IPs internos e **resolve o DNS validando cada IP** antes de conectar, revalidando a cada redirect |
| 🖥️ **Guarda de execução** | `bash` e `run_python` passam pela mesma validação; alterar arquivos reais do PC exige pedido explícito e fica registrado em auditoria |
| 📄 **Conteúdo externo é dado, não ordem** | Página lida, README de repositório, documento, memória, saída de ferramenta e resposta de outro modelo entram marcados como **dado não confiável** — e a marcação estrutural é neutralizada, para que texto de terceiro não consiga se passar por instrução do aplicativo nem virar chamada de ferramenta. Coberto por uma **bateria adversarial de 33 casos** |
| 🤝 **Delegação não escala privilégio** | O sub-agente herda um contrato **congelado** do agente que o chamou — ferramentas (interseção com o especialista), rede, escrita nas Pastas do PC e política do sandbox. Nada disso é recalculado a partir da subtarefa, que é texto escrito pelo próprio modelo |
| 🩺 **Healthcheck com métricas** | `GET /api/health` expõe uptime, política do antivírus, sandboxes ativos/órfãos e os limites de upload vigentes |
| 📋 **LGPD embutida** | Consentimento registrado (art. 8º), exportar tudo em JSON, apagar histórico e excluir conta — **hard delete** |

<details>
<summary><b>⚠️ Limites que você precisa conhecer antes de publicar</b></summary>

<br>

- A sandbox roda **sem privilégios** (`CapDrop: ALL`, `no-new-privileges`, uid 1000),
  com limites de CPU/memória/processos e **rede desligada por padrão** — abrir a rede
  exige autorização do próprio pedido e recria o container. Com a rede aberta ainda
  **não há allowlist de destino** (risco F-05b em [docs/AUDITORIA_2026-07.md](docs/AUDITORIA_2026-07.md)).
- Máquina **dedicada** segue recomendada como defesa em profundidade, mesmo com o
  `docker-guard` no lugar do acesso direto ao socket.
- **Site público:** qualquer pessoa pode se cadastrar. Para uso amplo/indexado,
  considere confirmação de e-mail e/ou aprovação de conta; enquanto isso, prefira
  divulgar "por link" e mantenha os limites de uso ativos.
- Conteúdo enviado ao modelo pode ser transmitido ao provedor configurado —
  avalie **LGPD** e sigilo antes de enviar dados sensíveis.
- **Regra da casa:** só anunciar o que está de fato ativo. Se desativar o ClamAV,
  remova os selos de segurança correspondentes da interface.

</details>

<details>
<summary><b>🛡️ Conformidade LGPD em detalhe (Lei 13.709/2018)</b></summary>

<br>

- **Documentos publicados:** Política de Privacidade em `/privacidade` e Termos de
  Uso em `/termos` (públicos, sem login), com links na landing, no cadastro e
  dentro do app. Ao alterar os textos de forma relevante, atualize a
  `TERMS_VERSION` em `backend/src/privacy.js` — todos os usuários verão o pedido
  de aceite de novo.
- **Consentimento (art. 8º):** checkbox opt-in (desmarcado por padrão) no
  cadastro; para login social e contas antigas, um modal bloqueante pede o aceite
  na primeira entrada. Cada aceite fica registrado em `user_consents` com versão,
  data, IP e navegador.
- **Direitos do titular (art. 18)** em **Privacidade e dados**: exportar tudo em
  JSON (portabilidade), apagar todo o histórico e excluir a conta — tudo **hard
  delete** (banco + workspaces em disco). Apagar o histórico remove também as
  memórias e sugestões derivadas das conversas (as manuais e importadas são
  preservadas).
- **Minimização:** o cadastro pede só nome, e-mail e senha; retenção automática
  opcional (`CONVERSATION_RETENTION_DAYS`); os logs do servidor não gravam o
  conteúdo das conversas.

</details>

---

## 📚 Documentação

| Documento | Conteúdo |
|---|---|
| [CONTINUIDADE.md](CONTINUIDADE.md) | 📌 **Leia antes de iniciar uma frente** — estado atual, riscos abertos e como retomar (curto) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitetura real: serviços, fluxos, persistência, lacunas |
| [docs/SECURITY.md](docs/SECURITY.md) | Modelo de ameaça, isolamento, sandbox, segredos, LGPD |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook: monitoramento, limites, procedimentos, rollback |
| [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md) | Primeira configuração, modo gratuito, Docling e acesso pelo celular |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | Backup completo e restauração passo a passo |
| [docs/TESTING.md](docs/TESTING.md) | Como rodar os testes, convenções e lacunas conhecidas |
| [docs/AUDITORIA_2026-07.md](docs/AUDITORIA_2026-07.md) | Auditoria de produção: achados, correções e prontidão |
| [docs/MULTIMODEL.md](docs/MULTIMODEL.md) | Modos multimodelo e o que ainda falta |
| [docs/MEMORY.md](docs/MEMORY.md) | Memória semântica e recuperação de contexto |
| [docs/DOCLING.md](docs/DOCLING.md) | Camada de compreensão documental |
| [VPS-DEPLOY.md](VPS-DEPLOY.md) | Publicação em VPS com HTTPS |
| [NOTEBOOK-SERVIDOR.md](NOTEBOOK-SERVIDOR.md) | Acesso remoto com notebook e Tailscale |
| [docs/CHANGELOG_HISTORY.md](docs/CHANGELOG_HISTORY.md) | Histórico completo do projeto |
| [VPS-DEPLOY.md](VPS-DEPLOY.md) | Publicação em VPS com HTTPS |
| [NOTEBOOK-SERVIDOR.md](NOTEBOOK-SERVIDOR.md) | Acesso remoto com notebook e Tailscale |
| [docs/DOCLING.md](docs/DOCLING.md) | Camada de compreensão documental |
| [docs/FREDERICO_COMPANION.md](docs/FREDERICO_COMPANION.md) | O copiloto Nino em detalhe |

## 🤝 Contribuir

Toda mudança relevante precisa: atualizar o `CONTINUIDADE.md` (que é **curto** — o
histórico vai para `docs/CHANGELOG_HISTORY.md`), passar por `npm run check` nos dois
lados, receber um commit descritivo em português e ser enviada ao GitHub na mesma sessão.

<div align="center">

Feito com ☕ por [fredabsd-svg](https://github.com/fredabsd-svg)

</div>
