# ⚙️ Configuração

Referência das variáveis de ambiente e dos cenários de acesso. Para a instalação
básica, veja o [README](../README.md#-começar-em-2-minutos) — aqui ficam os ajustes finos.

> Todas as opções estão comentadas no [.env.example](../.env.example).

---

## 🔑 Essenciais

| Variável | Padrão | Finalidade |
|---|---|---|
| `BETTER_AUTH_URL` | `http://localhost:5173` | Origem pública do app e callbacks OAuth |
| `BETTER_AUTH_SECRET` | — | Segredo de sessão do Better Auth (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | automática | Criptografa a chave de IA e o token do GitHub de cada usuário. Em branco, é gerada e salva em `data/encryption.key` na 1ª subida. Definida, tem prioridade. **Nunca troque depois de conectar contas.** |
| `FRONTEND_URL` | `http://localhost:5173` | Origem aceita pelo CORS (sem ela, nenhuma origem externa é aceita) |

## 🆓 Modo gratuito

| Variável | Padrão | Finalidade |
|---|---|---|
| `FREE_TIER_API_KEY` | — | Liga o modo gratuito: chave da plataforma (só no servidor) para novos usuários conversarem sem configurar nada |
| `FREE_TIER_BASE_URL` | OpenRouter | Base OpenAI-compatível do modo gratuito |
| `FREE_TIER_MODELS` | modelos `:free` | Allowlist em ordem de preferência (o 1º é o padrão; os demais são reserva) |
| `FREE_TIER_MSGS_PER_DAY` | 20 | Mensagens gratuitas por usuário/dia (admin ajusta pelo painel, sem reiniciar) |
| `FREE_TIER_MSGS_PER_MIN` | 4 | Freio anti-rajada |
| `FREE_TIER_CONCURRENCY` | 2 | Respostas gratuitas simultâneas (fila global protege a cota no provedor) |
| `FREE_TIER_QUEUE_MAX` | 30 | Tamanho máximo da fila |

**Como funciona por dentro:**

- **A chave gratuita fica só no servidor.** O navegador fala apenas com `/api`; só
  o backend fala com o provedor de IA. A chave nunca aparece no frontend, no app
  ou no repositório.
- **Allowlist de modelos:** só os modelos de `FREE_TIER_MODELS` são usados (padrão:
  modelos `:free` do OpenRouter). Se o escolhido falhar (429/queda), o app tenta o
  próximo da lista. A lista `:free` muda com frequência — confira em
  [openrouter.ai/collections/free-models](https://openrouter.ai/collections/free-models).
- **Limites com transparência:** o usuário vê no chat o chip "Modo gratuito" com o
  modelo, o provedor, as mensagens restantes, o horário de renovação e a posição na
  fila — e pode **cancelar** enquanto espera. Ao atingir o limite, aparece uma tela
  amigável com opções (aguardar, configurar chave própria, tutorial), não um erro
  técnico.
- **Painel do administrador** (Configurações → Modo gratuito, só para `ADMIN_EMAIL`):
  usuários ativos, consumo por usuário/modelo/dia, erros e indisponibilidades,
  limite global e individual, ativar/desativar modelos e **bloquear usuários por
  abuso** — tudo sem reiniciar.

**Termos dos provedores:** o OpenRouter permite servir seus usuários por um backend
próprio (proíbe revenda direta de acesso à API e multi-contas para burlar limites;
a cota é por conta: ~50 req/dia, ou ~1.000 req/dia após uma compra única de US$ 10).
Alguns provedores **proíbem** servir usuários finais no nível gratuito (ex.: NVIDIA
NIM, Cohere trial, GitHub Models) — não os use como `FREE_TIER_BASE_URL`. Modelos
locais (Ollama em `http://host:11434/v1`) também funcionam, sem termos de terceiros.

**Privacidade:** muitos modelos gratuitos registram/treinam com os prompts. Se
ativar o modo gratuito num site público, reflita isso na sua Política de Privacidade.

## 🧠 Modelos e roteamento

| Variável | Padrão | Finalidade |
|---|---|---|
| `OPENROUTER_QUANTIZATIONS` | `fp8,fp16,bf16,fp32,unknown` | Precisões de provedor aceitas. O padrão exclui só a compressão agressiva (`int4/int8/fp4/fp6`), onde a qualidade cai. Use `bf16,fp16,fp32` para exigir precisão cheia, ou `off` para desligar o filtro |
| `OPENROUTER_ALLOW_FALLBACKS` | ligado | Reroteia entre provedores da faixa de qualidade permitida se o preferido cair. `0` trava no preferido (erro em vez de troca silenciosa) |
| `OPENROUTER_PROVIDER_SORT` | automático | Ordenação opcional de provedores |
| `MODEL_FALLBACKS` | — | Modelos de reserva (em ordem) para failover automático; sem isso, cai para o modelo-base da conta |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | DeepSeek | Referência para tarefas internas legadas |

## ⏱️ Execução, limites e resiliência

| Variável | Padrão | Finalidade |
|---|---|---|
| `MAX_ACTIVE_RUNS_PER_USER` | 5 | Conversas do mesmo usuário processando ao mesmo tempo (multiconversa) |
| `MAX_SANDBOXES_PER_USER` | 2 | Sandboxes ativos ao mesmo tempo por usuário |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | `1024m` / `1` | Recursos do sandbox |
| `TOOL_TIMEOUT_MS` | 45000 | Tempo máximo de um comando de sandbox |
| `AGENT_MAX_STEPS` | conforme o esforço | Piso do orçamento de etapas (nunca reduz o esforço escolhido no menu) |
| `AGENT_MAX_AUTO_CONTINUES` | 6 | Fôlego automático: quantas vezes uma tarefa AINDA produtiva compacta o histórico e renova a janela de etapas em vez de parar no teto (`0` desliga) |
| `CHECKPOINT_MAX_BYTES` | 600000 | Tamanho máximo do estado salvo por conversa (retomada real) |
| `PIPELINE_STAGE_RESUME_LIMIT` | 2 | Multimodelo: retomadas automáticas de uma etapa interrompida antes de marcar erro |
| `STREAM_STALL_TIMEOUT_MS` | 180000 | Watchdog do streaming no backend (fonte de verdade): tempo sem dados do provedor antes de abortar e retomar/failover (piso 30000) |
| `PROVIDER_CONNECT_TIMEOUT_MS` | 180000 | Tempo até o provedor começar a responder (piso 30000) |
| `VALIDATE_RECALC` | `true` | Recalcula `.xlsx`/`.xlsm` com LibreOffice para detectar erros reais de fórmula (`#DIV/0!`, `#REF!`); `false` = validação parcial mais rápida |

## 🌐 Web, capturas e integrações

| Variável | Padrão | Finalidade |
|---|---|---|
| `WEB_FETCH_SCREENSHOTS` | 1 | Miniatura da página aberta pelo `web_fetch` (Chromium headless); `0` desliga |
| `SCREENSHOT_TIMEOUT_MS` | 9000 | Tempo máximo por captura (best-effort) |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | Caminho do Chromium do sistema (já definido no Dockerfile) |
| `DOCLING_ENABLED` | `false` | Liga a camada de compreensão documental — veja [DOCLING.md](DOCLING.md) |
| `ENABLE_PC_FOLDERS` | `false` | Permite liberar pastas reais do computador ao assistente |

## 🛡️ Limites de abuso e retenção

| Variável | Padrão | Finalidade |
|---|---|---|
| `RATE_MSGS_PER_DAY` | 0 (sem limite) | Máximo de mensagens por usuário por dia |
| `RATE_API_PER_MIN` | 600 | Rate limit HTTP geral por IP/minuto (0 desliga) |
| `RATE_AUTH_PER_15MIN` | 50 | Rate limit de login/cadastro por IP a cada 15 min (0 desliga) |
| `OUTPUT_RETENTION_DAYS` | 0 (desligado) | Remove arquivos de saída mais antigos que N dias |
| `CONVERSATION_RETENTION_DAYS` | 0 (desligado) | LGPD: apaga em definitivo conversas sem atividade há mais de N dias (mensagens, arquivos, memórias derivadas e workspace) |
| `USAGE_RETENTION_DAYS` | 365 | Retenção do registro de consumo de tokens; 0 mantém para sempre |

---

## 📱 Acesso pelo celular via Tailscale

No celular, nunca abra `localhost:5173` — `localhost` aponta para o próprio
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

---

## 🔄 Atualizar uma instalação existente

```powershell
git pull
docker compose up --build -d
```

No Windows, o `atualizar.bat` faz o mesmo com um clique.

---

## ✅ Validação local

```powershell
docker compose exec -T backend node --test "src/**/*.test.js"
docker compose exec -T frontend node --test src/authUrls.test.js src/sse.test.js
docker compose exec -T frontend npm run build
```

O mesmo conjunto roda automaticamente no **GitHub Actions**
(`.github/workflows/ci.yml`) a cada push/PR: testes do backend, testes do
frontend e build de produção.
