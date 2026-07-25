<div align="center">

# 🎨 Frederico IA Studio

**Seu estúdio de IA, em português.**

Converse com modelos de IA, analise arquivos, execute tarefas em um sandbox Docker isolado
e receba arquivos reais no chat — Excel, Word, PDF, gráficos e mais.

![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=white&labelColor=20232a)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=nodedotjs&logoColor=white&labelColor=20232a)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white&labelColor=20232a)
![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?logo=docker&logoColor=white&labelColor=20232a)
![Status](https://img.shields.io/badge/SaaS%20multiusu%C3%A1rio-em%20produ%C3%A7%C3%A3o-2ea043)

<img src="docs/tela-chat.png" alt="Tela principal do chat" width="900">

</div>

Compatível com **OpenRouter**, **DeepSeek** e qualquer endpoint no padrão da API OpenAI.
Combina chat, ferramentas, memória de longo prazo, pesquisa na web, modo equipe e um
ambiente de execução para documentos, planilhas, PDFs, código e automações.

É **multiusuário**: cada pessoa cria a própria conta (Better Auth) e só enxerga os
próprios dados. Suporta **BYOK** — cada usuário usa a **própria chave** de IA (ideal para
um site público), ou uma chave única do servidor para uso pessoal/de equipe. O modelo que
você escolhe é enviado direto ao provedor, sem substituição.

> 📌 Leia [CONTINUIDADE.md](CONTINUIDADE.md) antes de iniciar uma nova frente de trabalho —
> ele registra a arquitetura, decisões, riscos e próximos passos.

---

## ✨ Principais recursos

| | Recurso | Descrição |
|---|---|---|
| 👤 | **Multiusuário isolado** | Login por conta (Better Auth); cada pessoa só vê os próprios dados, conversas e arquivos |
| 🔑 | **Múltiplos provedores por pessoa** | Cada usuário cadastra e valida suas próprias chaves; OpenRouter, NVIDIA, DeepSeek, Alibaba e outros catálogos ficam isolados |
| 🤖 | **Assistentes personalizados** | Instruções, modelos, ferramentas e personalidade próprios |
| 📄 | **Arquivos reais no chat** | Excel, Word, PDF, CSV, ZIP, imagens, gráficos e OCR |
| 🎨 | **Documentos com design de agência** | O assistente "Documentos profissionais" usa kits prontos e testados (Word, Excel e PDF) — capa, tabelas estilizadas, gráficos, callouts e rodapé paginado; modo **sóbrio/registrável** (ata, contrato) justificado e sem cor para a Junta Comercial |
| 📷 | **Câmera e imagens** | Fotografe um documento (webcam no PC, câmera no celular) ou anexe uma imagem — a IA lê sozinha (**visão** nos modelos com visão; **OCR** nos demais) |
| 🏢 | **Consulta de CNPJ** | Dados cadastrais oficiais (BrasilAPI/ReceitaWS): razão social, situação, CNAE, endereço e sócios |
| 🧠 | **Memória de longo prazo** | Recuperação semântica com painel de revisão |
| 🔀 | **Multiconversa** | Várias conversas processando AO MESMO TEMPO (teto configurável); indicador girando na barra lateral mostra quais estão ativas, e trocar de conversa não interrompe nem mistura nada — ao voltar, o andamento reconecta ao vivo |
| ⏭️ | **Retomada real (checkpoint)** | Tarefa interrompida por limite de ciclos, queda do provedor ou watchdog salva o estado no banco; o botão **Continuar de onde parei** retoma do ponto exato (sem refazer ferramentas nem arquivos já prontos) e sobrevive a reinício do backend |
| 👥 | **Modo Equipe** | Combina perspectivas de vários assistentes |
| 🧩 | **Sistema Multimodelo** | 2+ modelos de IA na mesma mensagem: Comparação lado a lado, Conselho de IAs (coordenador consolida), Debate em rodadas e Especialistas em sequência — com função por modelo, estimativa de custo, orçamento máximo, interrupção por modelo e equipes salvas (presets) |
| 🖥️ | **Sandbox Docker** | Um container por conversa para Python, Bash e geração de arquivos |
| 🛠️ | **Ambiente de Trabalho da IA** | As ações da IA (terminal, código, arquivos, pesquisa, navegador) ficam agrupadas em **uma sessão ao vivo** — cartão compacto no chat que expande numa janela com o passo a passo, o detalhe de cada ação e a **miniatura real** das páginas abertas |
| 🌐 | **Pesquisa na web** | Google Custom Search, ou DuckDuckGo grátis (com dois endpoints de reserva); ao abrir uma página, um **Chromium headless** captura a miniatura |
| 📁 | **Modo Desenvolvedor** | Ambiente dedicado de programação: projetos com memória permanente, explorador de arquivos e painel de atividade ao redor do chat, com seis modos de trabalho (Perguntar, Planejar, Implementar, Corrigir erro, Revisar e Agente autônomo). Painel direito em **abas** — Atividade (passos agrupados e expansíveis), Arquivos (analisados), Alterações (criados/editados, com selo A/M) e Memória; barra lateral com **tarefas recentes** do projeto; pill de status honesto no cabeçalho (sem fingir etapas que o backend não expõe); chip **Permissões** mostra o que a IA pode fazer agora |
| 🔌 | **Conector GitHub** | Conecte a sua conta (token) e a IA clona um repositório, altera o código e envia de volta — push e Pull Request direto pelo chat ou pelo modo desenvolvedor; o token fica cifrado e nunca entra no sandbox |
| 🎙️ | **Voz e segundo plano** | Ditado por voz, tarefas em background, histórico por cliente |
| 🛡️ | **Privacidade (LGPD)** | Consentimento registrado, Política de Privacidade e Termos publicados, e painel "Privacidade e dados": exportar tudo em JSON, apagar o histórico ou excluir a conta — hard delete, sem soft delete |
| 🏷️ | **Seletor de modelos com logos** | Catálogo e filtro por fornecedor com o logo oficial de cada provedor, servido localmente (sem CDN); selo opcional de **classificação de referência** (S+ a B) ao lado do nome, quando o modelo bate com a curadoria em `frontend/src/modelRanking.js` — some sozinho para os demais, e dá para ordenar o catálogo por essa classificação |

A arquitetura, o inventário versionado de prompts, os estados de execução e os critérios de recuperação estão documentados em [docs/AUDITORIA_DEV_MULTIMODELO_PROMPTS.md](docs/AUDITORIA_DEV_MULTIMODELO_PROMPTS.md).

### Execução confiável

Chamadas de ferramenta são validadas antes da execução. Se um provedor devolver
como texto uma chamada que deveria vir no protocolo da API, o app a intercepta,
tenta convertê-la com segurança e **nunca despeja o código interno no chat**
(mesmo quando o modelo não tem ferramentas). Uma tarefa que pediu arquivo só é
considerada concluída quando o arquivo real existe; nesse caso, o download
aparece como cartão na própria resposta. Se a execução falhar, a interface
explica o resultado em linguagem simples e oferece **Reenviar**.

Os arquivos gerados são **checados de verdade** antes de entregar: os `.xlsx`
são **recalculados** (LibreOffice) para detectar erros reais de fórmula
(`#DIV/0!`, `#REF!` etc.) e têm os **gráficos verificados** (referências de
dados inválidas, como intervalos invertidos, são apontadas); os `.docx` são
inspecionados (documento vazio é sinalizado) e os `.pdf` têm as páginas
conferidas. Se o modelo travar repetindo o mesmo trecho, o app corta a saída em
vez de despejar um muro de texto; se o provedor cair no meio, há **failover**
automático para um modelo de reserva sem perder o trabalho.

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
    C --> D[(🗄️ PostgreSQL + pgvector<br/>conversas, memória e auth)]
    C --> E[🐳 Sandbox Docker<br/>um por conversa · workspaces/]
    C --> F[🧠 API de IA<br/>OpenRouter · DeepSeek · compatíveis]
```

O frontend usa a mesma origem e o Vite repassa `/api` para o backend — o chat e o
streaming SSE funcionam também atrás de Tailscale ou de um proxy HTTPS.

**Backend modular:** `backend/src/server.js` só cuida de middlewares e boot; as
rotas vivem em `backend/src/routes/*` (um arquivo por domínio — conversas,
memória, tarefas, rotinas etc.) e o loop do agente em `backend/src/agent/*` e métricas de saúde em `backend/src/healthMetrics.js`
(orquestrador, ferramentas, reparos, visão). A busca semântica roda no próprio
Postgres via `pgvector` (índice HNSW), com fallback automático em JS quando a
extensão não está disponível. **Frontend modular:** `frontend/src/App.jsx` é a
casca de UI; a lógica de chat, conversas, tarefas e assistentes vive em
`frontend/src/hooks/*`.

Nenhum recurso visual vem de CDN: imagens e logos ficam em `frontend/public/` e
são servidos pelo próprio app. Assim a interface não depende de um terceiro para
carregar, e o IP de quem usa o site não é entregue a nenhuma CDN externa.

**Ambiente de Trabalho da IA.** As chamadas de ferramenta de uma resposta são
agrupadas em uma única sessão de execução (`frontend/src/components/ExecutionSession.jsx`)
em vez de dezenas de cartões soltos: um cartão compacto que abre uma janela ao
vivo com o passo a passo humanizado e o detalhe (entrada/resultado) de cada ação.
Quando a IA abre uma página com o `web_fetch`, o backend a renderiza num
**Chromium headless** (`backend/src/agent/pageShot.js`, via `puppeteer-core` +
Chromium do sistema, embutido na imagem Docker) e salva um screenshot exibido na
janela. A captura é *best-effort* e desligável (`WEB_FETCH_SCREENSHOTS=0`), e cada
requisição do navegador é filtrada pela mesma regra anti-SSRF do `web_fetch`.

**Memória + cache.** A **memória de longo prazo** (perfil, notas, fatos e
recuperação semântica de conversas antigas) preserva o contexto entre mensagens:
o `contextBuilder` monta, a cada resposta, um contexto por modelo com perfil,
notas, resumo do início da conversa (quando ela sai da janela) e os trechos
relevantes — com isolamento por cliente. Sobre isso, uma **camada de cache**
(`backend/src/cache.js`, TTL + LRU, sem dependências) reduz custo de tokens e
latência em quatro frentes: **(1) prompt caching** do LLM — o preâmbulo estável
(prompt-base, contrato de qualidade, notas de sistema) é marcado com
`cache_control` e reaproveitado pelo provedor entre mensagens/etapas (via
OpenRouter para Anthropic/Gemini; a DeepSeek direta já cacheia sozinha); **(2)
embeddings** — vetores determinísticos memoizados por hash, evitando recomputar a
mesma pergunta a cada mensagem; **(3) consultas de CNPJ** — TTL longo, pois
dados cadastrais mudam raramente e a base grátis é limitada; **(4) busca web** —
TTL curto contra a repetição imediata. A economia é observável em
`GET /api/cache/stats` e em `usage.cached_tokens` das respostas. Tudo é
configurável/desligável por variáveis de ambiente (ver `.env.example`).

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
BETTER_AUTH_URL=http://localhost:5173
BETTER_AUTH_SECRET=gere_com_openssl_rand_hex_32
# ENCRYPTION_KEY é OPCIONAL: se ficar em branco, o backend gera uma chave sozinho
# na primeira subida e a guarda em data/encryption.key (sem precisar de terminal).
# Defina um valor só se quiser controlar a chave você mesmo.
ENCRYPTION_KEY=
```

Depois de entrar no aplicativo, abra **Provedores de IA** e cadastre uma ou
mais chaves. Os modelos só aparecem após a validação da respectiva chave.

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
| `DEEPSEEK_BASE_URL` | DeepSeek | Base usada como referência para tarefas internas legadas |
| `DEEPSEEK_MODEL` | deepseek-chat | Modelo de referência para tarefas internas legadas |
| `OPENROUTER_PROVIDER_SORT` | automático | Ordenação opcional de provedores no OpenRouter |
| `OPENROUTER_QUANTIZATIONS` | `fp8,fp16,bf16,fp32,unknown` | Precisões de provedor aceitas no OpenRouter. O padrão exclui só a compressão agressiva (`int4/int8/fp4/fp6`), onde a qualidade cai, mantendo `fp8`+ e `unknown`. Use `bf16,fp16,fp32` para exigir precisão cheia onde existir, ou `off` para desligar o filtro |
| `OPENROUTER_ALLOW_FALLBACKS` | ligado | Mantém a resiliência: reroteia entre provedores da faixa de qualidade permitida se o preferido cair. Defina `0` para travar no provedor preferido (erro em vez de troca silenciosa) |
| `BETTER_AUTH_URL` | http://localhost:5173 | Origem pública do app e callbacks OAuth |
| `BETTER_AUTH_SECRET` | — | Segredo de sessão do Better Auth |
| `ENCRYPTION_KEY` | auto | Criptografa a chave de IA e o token do GitHub de cada usuário no banco. Opcional: em branco, é gerada e salva em `data/encryption.key` na 1ª subida. Definida, tem prioridade. Nunca troque depois de conectar contas. |
| `FREE_TIER_API_KEY` | — | Liga o **modo gratuito**: chave da plataforma (só no servidor) para novos usuários conversarem sem configurar nada |
| `FREE_TIER_BASE_URL` | OpenRouter | Base OpenAI-compatível do modo gratuito |
| `FREE_TIER_MODELS` | modelos `:free` | Allowlist de modelos gratuitos, em ordem de preferência (o 1º é o padrão; os demais são reserva) |
| `FREE_TIER_MSGS_PER_DAY` | 20 | Mensagens gratuitas por usuário/dia (admin ajusta pelo painel sem reiniciar) |
| `FREE_TIER_MSGS_PER_MIN` | 4 | Freio anti-rajada do modo gratuito |
| `FREE_TIER_CONCURRENCY` | 2 | Respostas gratuitas simultâneas (fila global protege a cota no provedor) |
| `FREE_TIER_QUEUE_MAX` | 30 | Tamanho máximo da fila do modo gratuito |
| `RATE_MSGS_PER_DAY` | 0 (sem limite) | Máximo de mensagens por usuário por dia |
| `RATE_API_PER_MIN` | 600 | Rate limit HTTP geral da API por IP/minuto (0 desliga) |
| `RATE_AUTH_PER_15MIN` | 50 | Rate limit de login/cadastro por IP a cada 15 min (0 desliga) |
| `MAX_SANDBOXES_PER_USER` | 2 | Sandboxes ativos ao mesmo tempo por usuário |
| `MAX_ACTIVE_RUNS_PER_USER` | 5 | Conversas do mesmo usuário processando ao mesmo tempo (multiconversa); conversas que executam código também disputam `MAX_SANDBOXES_PER_USER` |
| `CHECKPOINT_MAX_BYTES` | 600000 | Tamanho máximo do estado de execução salvo por conversa (retomada real); array aparado preservando objetivo + resultados recentes |
| `TOOL_TIMEOUT_MS` | 45000 | Tempo máximo de um comando de sandbox |
| `AGENT_MAX_STEPS` | conforme o esforço | Piso do orçamento de etapas da tarefa (nunca reduz o esforço do menu) |
| `AGENT_MAX_AUTO_CONTINUES` | 6 | Fôlego automático: quantas vezes uma tarefa AINDA produtiva pode compactar o histórico e renovar a janela de etapas em vez de parar no teto (`0` desliga) |
| `PIPELINE_STAGE_RESUME_LIMIT` | 2 | Pipeline multimodelo: retomadas automáticas de uma etapa interrompida por limite de etapas (a partir do checkpoint) antes de marcar erro |
| `SANDBOX_MEMORY / SANDBOX_CPUS` | 1024m / 1 | Recursos do sandbox |
| `WEB_FETCH_SCREENSHOTS` | 1 | Miniatura da página aberta pelo `web_fetch` (Chromium headless); `0` desliga (só o texto) |
| `SCREENSHOT_TIMEOUT_MS` | 9000 | Tempo máximo por captura de miniatura (best-effort) |
| `CHROMIUM_PATH` | /usr/bin/chromium | Caminho do Chromium do sistema (já definido no Dockerfile) |
| `MODEL_FALLBACKS` | — | Modelos de reserva (ordem) para failover automático quando o provedor cai; sem isso, cai para o modelo-base da conta |
| `STREAM_STALL_TIMEOUT_MS` | 180000 | Watchdog do streaming no backend (fonte de verdade): tempo máximo sem receber nenhum dado do provedor antes de abortar e retomar/failover (piso 30000). O frontend tem um timeout separado de 5 min como fallback de conexão TCP perdida |
| `PROVIDER_CONNECT_TIMEOUT_MS` | 180000 | Tempo máximo até o provedor começar a responder a chamada de streaming (piso 30000) |
| `VALIDATE_RECALC` | true | Recalcula .xlsx/.xlsm com LibreOffice para detectar erros reais de fórmula (#DIV/0!, #REF!); `false` = validação parcial mais rápida |
| `OUTPUT_RETENTION_DAYS` | 0 (desligado) | Remove arquivos de saída mais antigos que N dias (útil em uso público/soak) |
| `CONVERSATION_RETENTION_DAYS` | 0 (desligado) | LGPD: apaga em definitivo conversas sem atividade há mais de N dias (mensagens, arquivos, memórias derivadas e workspace) |
| `USAGE_RETENTION_DAYS` | 365 | Retenção do registro de consumo de tokens (usage/usage_daily); 0 mantém para sempre |

Consulte o [.env.example](.env.example) para todas as opções.

---

## 🆓 Modo gratuito (primeiro acesso sem chave)

Para eliminar a barreira inicial de configuração, o app tem um **modo gratuito**: no primeiro
acesso, quem ainda não tem chave escolhe entre **"Começar gratuitamente"** (conversa na hora,
usando modelos gratuitos pagos/limitados pela plataforma) e **"Configurar minha própria chave"**
(um assistente passo a passo guia a criação da chave em provedores como OpenRouter, DeepSeek,
Groq, Google Gemini e Mistral).

Como funciona por dentro:

- **A chave gratuita fica só no servidor** (`FREE_TIER_API_KEY` no `.env`/secret do backend).
  O navegador fala apenas com `/api`; **só o backend** fala com o provedor de IA. A chave nunca
  aparece no frontend, no app ou no repositório.
- **Allowlist de modelos:** no modo gratuito só os modelos de `FREE_TIER_MODELS` são usados
  (padrão: modelos `:free` do OpenRouter). Se o modelo escolhido falhar (429/queda), o app tenta
  automaticamente o próximo da lista. A lista `:free` do OpenRouter muda com frequência —
  confira em [openrouter.ai/collections/free-models](https://openrouter.ai/collections/free-models).
- **Limites e fila com transparência:** limite diário por usuário (com renovação à meia-noite no
  fuso do app), freio por minuto e fila global de concorrência limitada. O usuário vê no chat o
  chip "Modo gratuito" com o modelo, o provedor, as mensagens restantes, o horário de renovação e
  a posição na fila — e pode **cancelar** enquanto espera. Ao atingir o limite, aparece uma tela
  amigável com opções (aguardar, configurar chave própria, tutorial), não um erro técnico.
- **Painel do administrador** (menu Administração → Modo gratuito, só para `ADMIN_EMAIL`):
  usuários ativos, consumo por usuário/modelo/dia, erros e indisponibilidades, limite global e
  individual, ativar/desativar modelos e **bloquear usuários por abuso** — tudo sem reiniciar.
- **Termos dos provedores:** o OpenRouter permite servir seus usuários por um backend próprio
  (proíbe revenda direta de acesso à API e multi-contas para burlar limites; a cota é por conta:
  ~50 req/dia, ou ~1.000 req/dia após uma compra única de US$ 10). Alguns provedores **proíbem**
  servir usuários finais no nível gratuito (ex.: NVIDIA NIM, Cohere trial, GitHub Models) — não
  os use como `FREE_TIER_BASE_URL`. Modelos locais (Ollama em `http://host:11434/v1`) também
  funcionam como modo gratuito, sem termos de terceiros.
- **Privacidade (LGPD):** muitos modelos gratuitos registram/treinam com os prompts. Se ativar o
  modo gratuito num site público, reflita isso na sua Política de Privacidade.

---

## 🔒 Segurança e limites atuais

- ✅ **Isolamento por usuário em três camadas:** posse verificada em cada consulta ao banco; **workspace físico escopado pelo dono** (`WORKSPACE_ROOT/users/<usuário>/<conversa>`); mapa de sandboxes indexado por (usuário, conversa) — mexer nas próprias pastas do PC não derruba o sandbox de terceiros. As chaves de IA são guardadas **criptografadas** (AES-256-GCM). Provas em `backend/src/sandbox.isolation.test.js`.
- 🧱 **Camada HTTP endurecida:** headers de segurança via `helmet` (X-Frame-Options, nosniff, HSTS), CORS restrito à própria origem (sem `FRONTEND_URL` nenhuma origem externa é aceita — o antigo fallback `*` foi removido), rate limiting geral por IP (`RATE_API_PER_MIN`) e janela apertada para login/cadastro (`RATE_AUTH_PER_15MIN`), além de validação estruturada de entrada com `zod` nas rotas de escrita.
- 🩺 **Healthcheck com métricas:** `GET /api/health` expõe `bootAt`, `unhandledRejections`, a **política do antivírus** (e se ele está degradado), **sandboxes ativos e órfãos recolhidos** e os limites de upload vigentes. Monitores externos (Uptime Kuma, Healthchecks.io, Grafana) alertam a partir daí — ver [docs/OPERATIONS.md](docs/OPERATIONS.md) §2.
- 🛡️ **Antivírus nos uploads (ClamAV):** todo arquivo enviado (anexos, caixa de entrada, importação de memória) é escaneado antes de ser salvo; infectado é recusado e apagado na hora. A resposta da API traz `scanStatus`: `verificado`, `degradado` (clamd fora do ar, arquivo aceito **sem** análise) ou `sem-antivirus`. **Nada é apresentado como verificado sem ter sido analisado.** Em ambiente público, use `CLAMAV_REQUIRED=true` (recusa o envio em vez de aceitar sem verificar) — ver [docs/SECURITY.md](docs/SECURITY.md) §7 e o Passo 8 do [VPS-DEPLOY.md](VPS-DEPLOY.md).
- 🪧 **Segurança visível ao usuário:** a tela de login exibe selos (arquivos verificados por antivírus, conexão criptografada, compromisso com a LGPD — com link para `/privacidade`) e a página de apresentação tem um bloco de confiança com 6 cartões (dados isolados, chave própria/BYOK, credenciais protegidas, arquivos verificados, HTTPS, LGPD). Regra: só anunciar o que está de fato ativo — se desativar o ClamAV, remova os selos correspondentes.
- 🛡️ **O backend NÃO recebe o socket do Docker.** Quem o detém é o serviço `docker-guard`, que valida cada requisição ao daemon: allowlist de rotas, inspeção do **corpo** de `/containers/create` (bloqueia `Privileged`, bind de `/`, bind do próprio socket, `CapAdd`, GPU, rede do host, imagem estranha) e posse por label — um backend comprometido não derruba o Postgres nem cria container privilegiado. Fecha o achado **F-04**. Ver [docs/SECURITY.md](docs/SECURITY.md) §4.3. Máquina dedicada segue recomendada como defesa em profundidade.
- 🔐 A sandbox roda **sem privilégios** (`CapDrop: ALL`, `no-new-privileges`, uid 1000), com limites de CPU/memória/processos e **rede desligada por padrão** — abrir a rede exige autorização do próprio pedido e recria o container, para a permissão não vazar entre turnos. Com a rede aberta ainda não há allowlist de destino (risco F-05b em [docs/AUDITORIA_2026-07.md](docs/AUDITORIA_2026-07.md)).
- 🛰️ **Proteção contra SSRF no `web_fetch`:** o backend bloqueia hostnames/IPs internos (loopback, faixas privadas IPv4, metadados de nuvem `169.254.169.254`, IPv6 loopback/ULA/link-local, incluindo a forma IPv4-mapeada) **e resolve o DNS validando cada IP antes de conectar** (defesa contra DNS rebinding), revalidando a cada redirect. Cobertura verificada em `backend/src/tools.ssrf.test.js`.
- 👑 **Administração persistida:** o papel de administrador vive em `user_roles`, preso ao **ID** do usuário. `ADMIN_EMAIL` serve só de bootstrap do primeiro admin — depois disso, cadastrar-se com aquele e-mail não concede nada. Toda ação administrativa (e cada recusa) fica em `admin_audit`.
- 🌍 **Site público:** qualquer pessoa pode se cadastrar. Para uso amplo/indexado, considere adicionar confirmação de e-mail e/ou aprovação de conta; enquanto isso, prefira divulgar "por link" e mantenha os limites (`RATE_MSGS_PER_DAY`, `MAX_SANDBOXES_PER_USER`).
- 📋 Conteúdo enviado ao modelo pode ser transmitido ao provedor configurado — avalie **LGPD** e sigilo antes de enviar dados sensíveis.

### 🛡️ LGPD (Lei 13.709/2018) — conformidade embutida

- **Documentos legais publicados:** Política de Privacidade em `/privacidade` e Termos de Uso em `/termos` (públicos, sem login), com links na landing, no cadastro e dentro do app. Ao alterar os textos de forma relevante, atualize a `TERMS_VERSION` em `backend/src/privacy.js` (fonte única — o frontend lê a versão de `/api/health`) — todos os usuários verão o pedido de aceite de novo.
- **Consentimento registrado (art. 8º):** checkbox opt-in (desmarcado por padrão) no cadastro; para login social e contas antigas, um modal bloqueante pede o aceite na primeira entrada. Cada aceite fica registrado em `user_consents` com versão, data, IP e navegador (evidência).
- **Direitos do titular (art. 18)** no menu **Privacidade e dados**: exportar todos os dados em JSON (portabilidade), apagar todo o histórico de conversas e **excluir a conta** — tudo **hard delete** (banco + workspaces em disco), sem soft delete. Apagar o histórico remove também as memórias **e as sugestões de memória** extraídas das conversas (memórias manuais e importadas são preservadas); o diálogo de excluir conta exige digitar o e-mail **sem exibi-lo**.
- **Minimização:** cadastro pede só nome, e-mail e senha; aviso fixo no chat lembra de não enviar dados sensíveis; retenção automática opcional (`CONVERSATION_RETENTION_DAYS`); logs do servidor não gravam o conteúdo das conversas.
- **Segurança:** senhas com hash (Better Auth/scrypt), chaves de API e tokens cifrados (AES-256-GCM), isolamento por usuário verificado em cada consulta.

---

## ✅ Validação local

```bash
cd backend  && npm run check            # lint + suíte completa
cd frontend && npm run check            # lint + todos os testes + build
cd backend  && npm run test:integration # exige Postgres: migrações do zero + suíte
cd backend  && npm run test:count       # contagem REAL de todas as suítes
```

> A contagem de testes **não** é escrita à mão nesta documentação: use `npm run test:count`.
> O CI publica o mesmo número no resumo de cada execução.

O **GitHub Actions** (`.github/workflows/ci.yml`) roda a cada push/PR: sintaxe, testes do
backend em Node 20 e 22, **integração com PostgreSQL real** (migrações do zero,
idempotência, suíte sem `skip`, boot do backend, portão de autenticação), **todos** os
testes do frontend + build + catraca de bundle, testes Python e validação do docker compose.
Detalhes em [docs/TESTING.md](docs/TESTING.md).

---

## 📚 Documentação complementar

| Documento | Conteúdo |
|---|---|
| [CONTINUIDADE.md](CONTINUIDADE.md) | **Estado atual, riscos abertos e como retomar** (curto) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitetura real: serviços, fluxos, persistência, lacunas |
| [docs/SECURITY.md](docs/SECURITY.md) | Modelo de ameaça, isolamento, sandbox, segredos, LGPD |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook: monitoramento, limites, procedimentos, rollback |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | Backup completo e restauração passo a passo |
| [docs/TESTING.md](docs/TESTING.md) | Como rodar os testes, convenções e lacunas conhecidas |
| [docs/AUDITORIA_2026-07.md](docs/AUDITORIA_2026-07.md) | Auditoria de produção: achados, correções e prontidão |
| [docs/MULTIMODEL.md](docs/MULTIMODEL.md) | Modos multimodelo e o que ainda falta |
| [docs/MEMORY.md](docs/MEMORY.md) | Memória semântica e recuperação de contexto |
| [docs/DOCLING.md](docs/DOCLING.md) | Camada de compreensão documental |
| [docs/CHANGELOG_HISTORY.md](docs/CHANGELOG_HISTORY.md) | Histórico completo do projeto (antigo CONTINUIDADE) |
| [NOTEBOOK-SERVIDOR.md](NOTEBOOK-SERVIDOR.md) | Acesso remoto com notebook e Tailscale |
| [VPS-DEPLOY.md](VPS-DEPLOY.md) | Publicação em VPS com HTTPS |

## 🤝 Processo de contribuição

Toda mudança relevante precisa: atualizar o `CONTINUIDADE.md` (que é **curto** — o
histórico vai para `docs/CHANGELOG_HISTORY.md`), passar por `npm run check` nos dois
lados, receber um commit descritivo em português e ser enviada ao GitHub na mesma sessão.

<div align="center">

Feito com ☕ por [fredabsd-svg](https://github.com/fredabsd-svg)

</div>
