# ⚙️ Primeira configuração e acesso

O que preencher para subir o app pela primeira vez, o modo gratuito por dentro e
o acesso pelo celular. Para a instalação em VPS veja [VPS-DEPLOY.md](../VPS-DEPLOY.md).

> **Limites, cotas e o restante das variáveis de ambiente** (uploads, execução,
> sandbox, retenção, rate limiting) estão em
> [OPERATIONS.md §3](OPERATIONS.md#3-limites-e-cotas-variáveis-de-ambiente) —
> a referência de operação. Aqui ficam só as opções de primeira configuração,
> para não manter duas listas que divergem.
>
> Todas as opções estão comentadas no [.env.example](../.env.example).

---

## 🔑 O mínimo para subir

| Variável | Padrão | Finalidade |
|---|---|---|
| `BETTER_AUTH_URL` | `http://localhost:5173` | Origem pública do app e callbacks OAuth |
| `BETTER_AUTH_SECRET` | — | Segredo de sessão do Better Auth (`openssl rand -hex 32`) |
| `FRONTEND_URL` | `http://localhost:5173` | Origem aceita pelo CORS (sem ela, nenhuma origem externa é aceita) |
| `ENCRYPTION_KEY` | automática | Criptografa a chave de IA e o token do GitHub de cada usuário. Em branco, é gerada e salva em `data/encryption.key` na 1ª subida. Definida, tem prioridade. **Nunca troque depois de conectar contas.** |

GitHub e Google são opcionais — deixe as credenciais OAuth vazias para usar só
e-mail/senha.

---

## 🆓 Modo gratuito (primeiro acesso sem chave)

| Variável | Padrão | Finalidade |
|---|---|---|
| `FREE_TIER_API_KEY` | — | Liga o modo gratuito: chave da plataforma (só no servidor) |
| `FREE_TIER_BASE_URL` | OpenRouter | Base OpenAI-compatível |
| `FREE_TIER_MODELS` | modelos `:free` | Allowlist em ordem de preferência (o 1º é o padrão; os demais são reserva) |
| `FREE_TIER_MSGS_PER_DAY` | 20 | Mensagens por usuário/dia (o admin ajusta pelo painel, sem reiniciar) |
| `FREE_TIER_MSGS_PER_MIN` | 4 | Freio anti-rajada |
| `FREE_TIER_CONCURRENCY` | 2 | Respostas simultâneas (fila global protege a cota no provedor) |
| `FREE_TIER_QUEUE_MAX` | 30 | Tamanho máximo da fila |

**Como funciona por dentro:**

- **A chave gratuita fica só no servidor.** O navegador fala apenas com `/api`; só
  o backend fala com o provedor de IA. A chave nunca aparece no frontend, no app
  ou no repositório.
- **Allowlist de modelos:** só os de `FREE_TIER_MODELS` são usados. Se o escolhido
  falhar (429/queda), o app tenta o próximo. A lista `:free` do OpenRouter muda com
  frequência — confira em
  [openrouter.ai/collections/free-models](https://openrouter.ai/collections/free-models).
- **Limites com transparência:** o usuário vê no chat o chip "Modo gratuito" com o
  modelo, o provedor, as mensagens restantes, o horário de renovação e a posição na
  fila — e pode **cancelar** enquanto espera. Ao atingir o limite, aparece uma tela
  amigável com opções, não um erro técnico.
- **Painel do administrador** (Configurações → Modo gratuito, só para `ADMIN_EMAIL`):
  usuários ativos, consumo por usuário/modelo/dia, erros, limite global e individual,
  ativar/desativar modelos e **bloquear usuários por abuso** — tudo sem reiniciar.

**Termos dos provedores:** o OpenRouter permite servir seus usuários por um backend
próprio (proíbe revenda direta de acesso à API e multi-contas para burlar limites;
a cota é por conta: ~50 req/dia, ou ~1.000 req/dia após uma compra única de US$ 10).
Alguns provedores **proíbem** servir usuários finais no nível gratuito (ex.: NVIDIA
NIM, Cohere trial, GitHub Models) — não os use como `FREE_TIER_BASE_URL`. Modelos
locais (Ollama em `http://host:11434/v1`) também funcionam, sem termos de terceiros.

**Privacidade:** muitos modelos gratuitos registram/treinam com os prompts. Se
ativar o modo gratuito num site público, reflita isso na sua Política de Privacidade.

---

## 🧠 Roteamento dos modelos

| Variável | Padrão | Finalidade |
|---|---|---|
| `OPENROUTER_QUANTIZATIONS` | `fp8,fp16,bf16,fp32,unknown` | Precisões aceitas. O padrão exclui só a compressão agressiva (`int4/int8/fp4/fp6`), onde a qualidade cai. Use `bf16,fp16,fp32` para exigir precisão cheia, ou `off` para desligar o filtro |
| `OPENROUTER_ALLOW_FALLBACKS` | ligado | Reroteia entre provedores da faixa permitida se o preferido cair. `0` trava no preferido (erro em vez de troca silenciosa) |
| `MODEL_FALLBACKS` | — | Modelos de reserva (em ordem) para failover automático |

---

## 📄 Camada documental (Docling)

Desligada por padrão. A flag do backend (`DOCLING_ENABLED`) e o serviço (perfil
`docling` do compose) são ligados **separadamente** — se divergirem, o backend
avisa no boot com o comando a rodar.

```bash
docker compose --profile docling up -d --build
```

| Variável | Padrão | Finalidade |
|---|---|---|
| `DOCLING_ENABLED` | `false` | Liga a camada |
| `DOCLING_INTERNAL_TOKEN` | — | Token entre backend e serviço. **Defina em produção** — vazio, o serviço aceita qualquer container da mesma rede |
| `DOCLING_OCR` / `DOCLING_OCR_LANG` | `auto` / `por` | Modo e idioma do OCR |
| `DOCLING_TIMEOUT_MS` | 240000 | Tempo máximo por documento |
| `DOCLING_RESULT_CACHE_MB` | 256 | Teto de memória do cache de resultados no serviço |
| `DOCLING_RETENTION_DAYS` | 0 (desligado) | LGPD: apaga os derivados mais antigos que N dias |

Arquitetura e detalhes em [DOCLING.md](DOCLING.md); o fluxo no
[ARCHITECTURE.md §10](ARCHITECTURE.md).

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

## ✅ Validação local

```bash
cd backend  && npm run check
cd frontend && npm run check
```

Convenções, cobertura e lacunas conhecidas em [TESTING.md](TESTING.md).
