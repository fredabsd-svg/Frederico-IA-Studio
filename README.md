<div align="center">

# 🎨 Frederico IA Studio

**Seu estúdio de IA, em português.**

Converse com modelos de IA, analise arquivos, execute tarefas em um sandbox Docker isolado
e receba arquivos reais no chat — Excel, Word, PDF, gráficos e mais.

![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=white&labelColor=20232a)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white&labelColor=20232a)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white&labelColor=20232a)
![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?logo=docker&logoColor=white&labelColor=20232a)
![Status](https://img.shields.io/badge/Fase%203-em%20desenvolvimento-c67139)

<img src="docs/tela-chat.png" alt="Tela principal do chat" width="900">

</div>

Compatível com **OpenRouter**, **DeepSeek** e qualquer endpoint no padrão da API OpenAI.
Combina chat, ferramentas, memória de longo prazo, pesquisa na web, modo equipe e um
ambiente de execução para documentos, planilhas, PDFs, código e automações.

> 📌 Leia [CONTINUIDADE.md](CONTINUIDADE.md) antes de iniciar uma nova frente de trabalho —
> ele registra a arquitetura, decisões, riscos e próximos passos.

---

## ✨ Principais recursos

| | Recurso | Descrição |
|---|---|---|
| 🤖 | **Assistentes personalizados** | Instruções, modelos, ferramentas e personalidade próprios |
| 📄 | **Arquivos reais no chat** | Excel, Word, PDF, CSV, ZIP, imagens, gráficos e OCR |
| 🧠 | **Memória de longo prazo** | Recuperação semântica com painel de revisão |
| 👥 | **Modo Equipe** | Combina perspectivas de vários assistentes |
| 🖥️ | **Sandbox Docker** | Um container por conversa para Python, Bash e geração de arquivos |
| 🌐 | **Pesquisa na web** | Google Custom Search ou DuckDuckGo |
| 📁 | **Modo Desenvolvedor** | Trabalhe sobre uma pasta de projeto autorizada |
| 🎙️ | **Voz e segundo plano** | Ditado por voz, tarefas em background, histórico por cliente |

### Execução confiável

Chamadas de ferramenta são validadas antes da execução. Se um provedor devolver
como texto uma chamada que deveria vir no protocolo da API, o app a intercepta,
tenta convertê-la com segurança e nunca despeja o código interno no chat. Uma
tarefa que pediu arquivo só é considerada concluída quando o arquivo real existe;
nesse caso, o download aparece como cartão na própria resposta. Se a execução
falhar, a interface explica o resultado em linguagem simples e oferece **Reenviar**.

<div align="center">
<table>
<tr>
<td><img src="docs/painel-memoria.png" alt="Painel de memória" width="440"></td>
<td><img src="docs/tela-login.png" alt="Tela de login com Better Auth" width="330"></td>
</tr>
<tr>
<td align="center"><em>Painel de memória com busca semântica</em></td>
<td align="center"><em>Login com Better Auth: e-mail, GitHub e Google</em></td>
</tr>
</table>
</div>

---

## 🏗️ Arquitetura

```mermaid
flowchart TD
    A[🌍 Navegador] --> B[⚛️ React + Vite<br/>porta 5173]
    B -->|/api + SSE| C[🚀 Express + SSE<br/>porta 3001<br/>agente · ferramentas · tarefas]
    C --> D[(🗄️ PostgreSQL<br/>conversas, memória e auth)]
    C --> E[🐳 Sandbox Docker<br/>um por conversa · workspaces/]
    C --> F[🧠 API de IA<br/>OpenRouter · DeepSeek · compatíveis]
```

O frontend usa a mesma origem e o Vite repassa `/api` para o backend — o chat e o
streaming SSE funcionam também atrás de Tailscale ou de um proxy HTTPS.

---

## 🚀 Começar

**Pré-requisitos:** Docker Desktop em execução, uma chave de API compatível com OpenAI
e os segredos do Better Auth.

### 1️⃣ Configurar o ambiente

```powershell
Copy-Item .env.example .env
```

Preencha ao menos estes valores no `.env`:

```env
DEEPSEEK_API_KEY=sua_chave
DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1
DEEPSEEK_MODEL=deepseek/deepseek-chat

BETTER_AUTH_URL=http://localhost:5173
BETTER_AUTH_SECRET=gere_com_openssl_rand_hex_32
ENCRYPTION_KEY=gere_outro_com_openssl_rand_hex_32
```

> GitHub e Google são opcionais — deixe as credenciais OAuth vazias para usar só e-mail/senha.

### 2️⃣ Subir o aplicativo

```powershell
docker compose up --build
```

No Windows, o `iniciar.bat` prepara e inicia tudo. Abra [http://localhost:5173](http://localhost:5173).

### Acesso pelo celular via Tailscale

No celular, nunca abra `localhost:5173`: `localhost` aponta para o próprio
celular. Com o app e o Tailscale ligados no computador, publique a porta do
frontend e consulte o endereço HTTPS:

```powershell
tailscale serve --bg 5173
tailscale serve status
```

Use no celular a URL `https://...ts.net` exibida pelo segundo comando. Coloque
essa mesma origem em `BETTER_AUTH_URL` no `.env` e recrie o backend. Mantenha
`FRONTEND_URL=http://localhost:5173` para o acesso local continuar autorizado.

Para login social, registre também no provedor:

```text
https://SEU_HOST.ts.net/api/auth/callback/github
https://SEU_HOST.ts.net/api/auth/callback/google
```

O computador e o celular precisam aparecer conectados na mesma rede Tailscale.
O endereço HTTPS do Serve é privado para essa rede.

### 3️⃣ Atualizar uma instalação existente

```powershell
git pull
docker compose up --build -d
```

---

## ⚙️ Variáveis importantes

| Variável | Padrão | Finalidade |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Chave do provedor de IA |
| `DEEPSEEK_BASE_URL` | DeepSeek | Base compatível com OpenAI |
| `DEEPSEEK_MODEL` | deepseek-chat | Modelo principal |
| `OPENROUTER_PROVIDER_SORT` | automático | Ordenação opcional de provedores no OpenRouter |
| `BETTER_AUTH_URL` | http://localhost:5173 | Origem pública do app e callbacks OAuth |
| `BETTER_AUTH_SECRET` | — | Segredo de sessão do Better Auth |
| `ENCRYPTION_KEY` | — | Reservada para chaves por usuário (próxima fase) |
| `TOOL_TIMEOUT_MS` | 45000 | Tempo máximo de um comando de sandbox |
| `AGENT_MAX_STEPS` | conforme o esforço | Limite de etapas da tarefa |
| `SANDBOX_MEMORY / SANDBOX_CPUS` | 2048m / 1 | Recursos do sandbox |

Consulte o [.env.example](.env.example) para todas as opções.

---

## 🔒 Segurança e limites atuais

- ⚠️ O backend recebe o **socket Docker** — permissão privilegiada; não exponha sem proteção adequada.
- 🔐 A sandbox roda **sem privilégios** e com limites de CPU/memória, mas a rede fica habilitada para pesquisas e automações.
- 📋 Conteúdo enviado ao modelo pode ser transmitido ao provedor configurado — avalie **LGPD** e sigilo antes de enviar dados sensíveis.
- 🚧 O isolamento completo entre usuários está em desenvolvimento: não trate a instalação como SaaS multi-tenant até a conclusão da **Fase 3** ([CONTINUIDADE.md](CONTINUIDADE.md)).

---

## ✅ Validação local

```powershell
docker compose exec -T backend node --test src/agent.control.test.js src/agent.outputDelivery.test.js src/toolProtocol.test.js src/taskOutcome.test.js
docker compose exec -T frontend node --test src/authUrls.test.js src/sse.test.js
docker compose exec -T frontend npm run build
```

---

## 📚 Documentação complementar

| Documento | Conteúdo |
|---|---|
| [CONTINUIDADE.md](CONTINUIDADE.md) | Estado atual, decisões e handoff |
| [NOTEBOOK-SERVIDOR.md](NOTEBOOK-SERVIDOR.md) | Acesso remoto com notebook e Tailscale |
| [VPS-DEPLOY.md](VPS-DEPLOY.md) | Publicação em VPS com HTTPS |

## 🤝 Processo de contribuição

Toda mudança relevante precisa atualizar o `CONTINUIDADE.md`, passar por validação,
receber um commit descritivo em português e ser enviada ao GitHub na mesma sessão.

<div align="center">

Feito com ☕ por [fredabsd-svg](https://github.com/fredabsd-svg)

</div>
