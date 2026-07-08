# Frederico AI Studio

Aplicativo de chat com IA inspirado em ChatGPT/Claude, conectado à API da DeepSeek e a uma sandbox Linux via Docker para gerar arquivos reais: Word, Excel, PDF, CSV, TXT, ZIP e relatórios.

## Principais melhorias desta versão

- Interface com sidebar de conversas.
- Painel lateral de arquivos/artifacts.
- Upload de documentos.
- Streaming via Server-Sent Events.
- Renderização Markdown no chat.
- Histórico persistente em SQLite.
- Sandbox Docker por sessão.
- Pasta isolada por conversa: `uploads` e `outputs`.
- Ferramentas: `run_python`, `bash`, `read_file`, `write_file`, `list_files`, `zip_outputs`.
- Bibliotecas prontas para gerar Excel, Word, PDF, PowerPoint, gráficos e OCR.

## Estrutura

```txt
frederico-ai-studio/
├─ backend/
│  ├─ src/
│  │  ├─ agent.js
│  │  ├─ db.js
│  │  ├─ sandbox.js
│  │  ├─ server.js
│  │  └─ tools.js
│  └─ package.json
├─ frontend/
│  ├─ src/
│  │  ├─ App.jsx
│  │  ├─ main.jsx
│  │  └─ styles.css
│  └─ package.json
├─ sandbox/
│  └─ Dockerfile
├─ docker-compose.yml
├─ Dockerfile
└─ .env.example
```

## Como rodar

### 1. Criar arquivo `.env`

Copie:

```bash
cp .env.example .env
```

Edite a chave:

```env
DEEPSEEK_API_KEY=sua_chave_deepseek
```

### 2. Construir a imagem da sandbox

```bash
docker build -t frederico-ai-sandbox:latest ./sandbox
```

### 3. Rodar tudo com Docker Compose

```bash
docker compose up --build
```

Acesse:

```txt
http://localhost:5173
```

Backend:

```txt
http://localhost:3001/api/health
```

## Exemplo de uso

Envie no chat:

```txt
Crie um arquivo Excel em outputs/relatorio.xlsx com uma aba chamada Dashboard, três KPIs e formatação profissional em azul escuro.
```

Ou:

```txt
Gere um documento Word em outputs/proposta.docx com uma proposta profissional de serviços contábeis.
```

## Segurança implementada

- Um container Docker por sessão.
- `NetworkDisabled: true` na sandbox.
- Sem chave de API dentro da sandbox.
- Limites de memória, CPU e PIDs.
- Bloqueio básico de comandos perigosos.
- Workspace isolado por conversa.
- Downloads restritos ao workspace da sessão.

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

## 🇧🇷 LGPD e residência de dados (DeepSeek)

A API da **DeepSeek** é hospedada na **China**. Todo texto enviado no chat
(incluindo o conteúdo de arquivos que o modelo leia) é transmitido para
servidores fora do Brasil. **Para dados sensíveis ou sujeitos à LGPD, não use
o endpoint público da DeepSeek.**

Nesses casos, aponte `DEEPSEEK_BASE_URL` no `.env` para um endpoint **local**
compatível com a API OpenAI — por exemplo **vLLM** ou **Ollama** — mantendo os
dados dentro da sua infraestrutura:

```env
# Exemplo com um servidor local compatível (vLLM, Ollama, etc.)
DEEPSEEK_BASE_URL=http://localhost:11434/v1
DEEPSEEK_MODEL=seu-modelo-local
DEEPSEEK_API_KEY=chave-qualquer
```

## Pontos para produção

Antes de usar com clientes reais:

1. Adicionar autenticação de usuários.
2. Trocar SQLite por PostgreSQL se houver múltiplos usuários.
3. Adicionar fila de execução para tarefas longas.
4. Melhorar preview de DOCX/XLSX/PDF no navegador.
5. Criar política de retenção e exclusão de dados.
6. Adicionar antivírus/scan nos uploads.
7. Usar gVisor ou Firecracker para isolamento mais forte.
8. Implementar RBAC e logs de auditoria.
9. Adicionar MCP para ferramentas externas.
10. Criar agentes especializados: Contábil, Fiscal, Excel, Jurídico e Auditoria.

## Observação importante

Este projeto é uma base funcional e profissional para desenvolvimento local. Para ambiente de produção com documentos de clientes, revise LGPD, segurança da infraestrutura, retenção de arquivos, controle de acesso e residência de dados da API utilizada.
