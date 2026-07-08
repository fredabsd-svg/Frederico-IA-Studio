# Frederico AI Studio

Plataforma de chat com IA para escritórios e profissionais: converse com assistentes
especializados que **executam código de verdade** em um sandbox Linux isolado e
**geram arquivos reais** — Excel, Word, PDF, CSV, ZIP — prontos para baixar no chat.

Conecta-se a qualquer provedor compatível com a API OpenAI (OpenRouter, DeepSeek,
vLLM/Ollama local), com interface 100% em português do Brasil.

## Principais recursos

| Recurso | Descrição |
|---|---|
| 🤖 **Assistant Studio** | Crie assistentes sem programar: nome, modelo, instruções (com templates de Contábil, Jurídico, RH, Marketing, Dev), ferramentas permitidas e sliders de personalidade |
| 📎 **Geração real de arquivos** | Excel (openpyxl/xlsxwriter), Word (python-docx), PDF (reportlab/weasyprint), gráficos (matplotlib), OCR (tesseract) — os arquivos aparecem como cartões no chat |
| 🧠 **Memória** | Global (todos os assistentes lembram: empresa, CNPJ, preferências) e por assistente |
| 🧑‍🤝‍🧑 **Modo Equipe** | Uma pergunta aciona todos os assistentes; um coordenador une as perspectivas numa resposta só |
| 🌐 **Pesquisa na internet** | Botão de globo liga a busca (Google via API oficial, ou DuckDuckGo sem cadastro) com citação de fontes |
| 🎤 **Ditado por voz** | Fale em vez de digitar (Chrome/Edge, pt-BR) |
| ⏯️ **Controles de execução** | Pausar, continuar e parar o processamento; streaming token a token; rastro vivo das ferramentas |
| 📊 **Análises** | Mensagens e tokens consumidos por assistente e por modelo |
| 🔒 **Sandbox isolado** | 1 container Docker por conversa: sem rede, sem privilégios, com limites de CPU/memória/processos |

## Arquitetura

```
┌─────────────┐  SSE/REST   ┌──────────────┐  API OpenAI-compat.  ┌────────────┐
│  Frontend    │ ──────────► │   Backend     │ ───────────────────► │ OpenRouter │
│ React + Vite │             │ Node/Express  │                      │ /DeepSeek/ │
│  (porta 5173)│             │  (porta 3001) │                      │ vLLM local │
└─────────────┘             └──────┬───────┘                      └────────────┘
                             SQLite │ dockerode
                            ┌──────▼───────┐
                            │   Sandbox     │  1 container por conversa
                            │ python:3.12   │  sem rede · uid 1000 · limites
                            └──────────────┘
```

```
frederico-ai-studio/
├── docker-compose.yml        # sobe tudo (sandbox-image + backend + frontend)
├── Dockerfile                # backend (node:20-slim)
├── sandbox/Dockerfile        # imagem do sandbox (python:3.12-slim + libs)
├── iniciar.bat / parar.bat   # atalhos Windows (duplo clique)
├── .env.example              # modelo de configuração
├── backend/src/
│   ├── server.js             # rotas HTTP + SSE
│   ├── agent.js              # loop agêntico, orquestrador, memória, controles
│   ├── tools.js              # ferramentas (sandbox + pesquisa web)
│   ├── sandbox.js            # ciclo de vida dos containers (dockerode)
│   └── db.js                 # SQLite (better-sqlite3, WAL)
└── frontend/src/
    ├── App.jsx               # aplicação
    ├── components.jsx        # componentes reutilizáveis
    ├── constants.js          # configuração e dados estáticos
    └── styles.css            # tema claro/escuro
```

## Como rodar

### Pré-requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado e rodando
- Uma chave de API: [OpenRouter](https://openrouter.ai) (recomendado — acesso a vários modelos) ou [DeepSeek](https://platform.deepseek.com)

### 1. Configurar o `.env`

```bash
cp .env.example .env
```

Edite o `.env`. Com **OpenRouter**:

```env
DEEPSEEK_API_KEY=sk-or-sua_chave
DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1
DEEPSEEK_MODEL=deepseek/deepseek-chat
```

Com **DeepSeek direto**: mantenha `DEEPSEEK_BASE_URL=https://api.deepseek.com` e `DEEPSEEK_MODEL=deepseek-chat`.

### 2. Subir o aplicativo

**Windows (mais fácil):** duplo clique em **`iniciar.bat`** — ele limpa execuções
anteriores, constrói o que for preciso e abre o navegador sozinho. Para desligar,
**`parar.bat`**.

**Linha de comando (qualquer sistema):**

```bash
docker build -t frederico-ai-sandbox:latest ./sandbox   # 1ª vez
docker compose up --build
```

Acesse **http://localhost:5173** (backend em `http://localhost:3001/api/health`).

### 3. Atualizar para uma versão nova

```bash
git pull
docker compose up --build
```

As conversas, assistentes e memórias ficam preservadas em `./data` (SQLite) e `./workspaces`.

## Configurações opcionais (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `TOOL_TIMEOUT_MS` | `45000` | Tempo máximo de cada comando no sandbox |
| `AGENT_MAX_STEPS` | `30` | Máximo de etapas (ferramentas) por resposta |
| `AGENT_HISTORY_LIMIT` | `60` | Mensagens recentes enviadas ao modelo |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | `1024m` / `1` | Limites do sandbox |
| `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` | — | Pesquisa via Google (sem elas, usa DuckDuckGo) |

## ⚠️ Avisos de segurança (leia antes de usar)

- **O socket do Docker (`/var/run/docker.sock`) é montado no backend.** Isso
  equivale a acesso **root no host**: quem controla o backend controla a
  máquina inteira. Trate o backend como um serviço privilegiado.
- **Não há autenticação.** Qualquer pessoa que alcance as portas `5173`/`3001`
  tem acesso total às conversas, uploads e à sandbox. **Use apenas em rede
  local/confiável** ou atrás de um proxy autenticado. Nunca exponha estas
  portas diretamente à internet.
- A sandbox reduz o risco (`NetworkDisabled`, `CapDrop: ALL`,
  `no-new-privileges`, limites de memória/CPU/PIDs), mas **não** substitui as
  precauções acima.
- Com a **pesquisa na internet ligada**, o conteúdo das páginas visitadas entra
  na conversa e é enviado ao provedor de IA. Mantenha desligada para assuntos
  sensíveis.

## 🇧🇷 LGPD e residência de dados

A API da **DeepSeek** é hospedada na **China**; o OpenRouter, nos **EUA**. Todo
texto enviado no chat (incluindo o conteúdo de arquivos que o modelo leia) é
transmitido para servidores fora do Brasil. **Para dados sensíveis ou sujeitos
à LGPD, não use endpoints públicos.**

Nesses casos, aponte `DEEPSEEK_BASE_URL` para um endpoint **local** compatível
com a API OpenAI — por exemplo **vLLM** ou **Ollama** — mantendo os dados na
sua infraestrutura:

```env
DEEPSEEK_BASE_URL=http://localhost:11434/v1
DEEPSEEK_MODEL=seu-modelo-local
DEEPSEEK_API_KEY=chave-qualquer
```

## Solução de problemas

| Sintoma | Causa provável / solução |
|---|---|
| "Não foi possível conectar ao servidor" | Docker Desktop fechado ou app desligado → abra o Docker e rode `iniciar.bat` |
| `port is already allocated` | Sobrou uma execução anterior → `parar.bat` (ou `docker compose down`) e suba de novo |
| Erro de chave / "Insufficient balance" | Confira a chave no `.env` e o crédito no provedor |
| Arquivo não gera / trava nos 45s | Tarefa pesada → peça em partes (extrair dados → depois gerar o arquivo) ou aumente `TOOL_TIMEOUT_MS` |
| Ditado por voz não funciona | Use Chrome/Edge e permita o microfone |

## Pontos para produção

Antes de usar com clientes reais: autenticação de usuários; HTTPS/proxy reverso;
PostgreSQL para múltiplos usuários; fila para tarefas longas; retenção/expurgo de
dados; antivírus nos uploads; isolamento mais forte (gVisor/Firecracker); RBAC e
logs de auditoria.
