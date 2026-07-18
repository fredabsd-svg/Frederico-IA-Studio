# Publicar o Frederico AI Studio numa VPS (acessar de qualquer lugar)

Guia passo a passo para colocar o app num servidor na nuvem, com **domínio
próprio e HTTPS**. Agora o acesso é por **conta de usuário** (cada pessoa cria
o próprio login) — não existe mais senha única. Tempo estimado: 30–60 min na
primeira vez.

---

## Antes de começar: uma decisão importante

Como o app usa IA paga, decida **quem paga a conta da IA**:

- **Site pessoal / equipe de confiança** → você pode deixar uma chave no servidor
  e todos usam ela. (`ALLOW_SHARED_KEY=true`, com a `DEEPSEEK_API_KEY` preenchida.)
- **Site público (qualquer um pode se cadastrar)** → **cada usuário usa a própria
  chave** (BYOK). Assim você não paga a conta de estranhos.
  Coloque `ALLOW_SHARED_KEY=false`. Cada pessoa cadastra a chave dela em
  **Configurações → Provedor de IA** dentro do app.

> 💡 Você também pode limitar o uso com `RATE_MSGS_PER_DAY=50` (máx. de mensagens
> por usuário por dia) — útil se compartilhar a sua chave.

---

## O que você vai precisar

1. **Uma VPS** (servidor Linux). Boas opções: Hetzner (CX22, ~€4/mês),
   DigitalOcean (~US$6/mês), Contabo, Oracle Cloud (nível gratuito).
   Escolha **Ubuntu 22.04 ou 24.04**, mínimo **2 GB de RAM** (4 GB recomendado).
2. **Um domínio ou subdomínio** (ex.: `ia.suaempresa.com.br`).
3. (Opcional) Sua **chave do OpenRouter/DeepSeek**, se for a do servidor.

## Passo 1 — Criar a VPS e conectar por SSH

Crie a VPS (Ubuntu) e anote o **IP público**. No Windows, abra o **PowerShell**:

```powershell
ssh root@SEU_IP
```

## Passo 2 — Apontar o domínio para a VPS

No painel do seu domínio (Registro.br, GoDaddy, Cloudflare...):

- Crie um registro **A** com o subdomínio (ex.: `ia`) apontando para o **IP da VPS**.
- Aguarde a propagação (alguns minutos, até ~1h).

Teste: `ping ia.suaempresa.com.br` deve responder com o IP da VPS.

## Passo 3 — Instalar o Docker na VPS

```bash
curl -fsSL https://get.docker.com | sh
```

## Passo 4 — Baixar o projeto

```bash
git clone https://github.com/fredabsd-svg/Frederico-IA-Studio.git
cd Frederico-IA-Studio
```

> Se o repositório for **privado**, o git vai pedir usuário e um *token* do
> GitHub (Settings → Developer settings → Personal access tokens).

## Passo 5 — Gerar os segredos e configurar o `.env`

Gere dois segredos (guarde os valores):

```bash
openssl rand -hex 32   # 1º valor → BETTER_AUTH_SECRET
openssl rand -hex 32   # 2º valor → ENCRYPTION_KEY
```

Crie o `.env`:

```bash
cp .env.example .env
nano .env
```

Preencha o mínimo:

```env
# ---- Endereço público ----
DOMAIN=ia.suaempresa.com.br
BETTER_AUTH_URL=https://ia.suaempresa.com.br

# ---- Segredos gerados acima (um valor cada) ----
BETTER_AUTH_SECRET=cole_o_1o_valor
ENCRYPTION_KEY=cole_o_2o_valor

# ---- Quem paga a IA (veja a decisão lá em cima) ----
# Site público (cada usuário usa a própria chave):
ALLOW_SHARED_KEY=false
# Site pessoal (chave do servidor para todos): deixe ALLOW_SHARED_KEY sem definir
# e preencha:
# DEEPSEEK_API_KEY=sk-or-sua_chave
# DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1
# DEEPSEEK_MODEL=deepseek/deepseek-chat
```

Salve com `Ctrl+O`, `Enter`, e saia com `Ctrl+X`.

### (Opcional) Login com GitHub/Google

O login por **e-mail e senha** já funciona sem configurar nada. Se quiser os
botões de GitHub/Google, preencha no `.env` as credenciais
(`GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`) e cadastre, no painel de
cada um, a **URL de callback** exatamente assim:

```
https://ia.suaempresa.com.br/api/auth/callback/github
https://ia.suaempresa.com.br/api/auth/callback/google
```

## Passo 6 — Ligar o firewall (recomendado)

```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## Passo 7 — Subir o aplicativo

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

A primeira vez demora alguns minutos (constrói sandbox, backend e frontend).
Quando terminar, acesse **https://ia.suaempresa.com.br** — o certificado HTTPS
é emitido automaticamente. Você verá a **página de apresentação**; clique em
**Criar conta** e pronto. 🎉

---

## Operação do dia a dia

Rode na pasta do projeto, via SSH:

| Ação | Comando |
|---|---|
| Ver se está rodando | `docker compose -f docker-compose.prod.yml ps` |
| Ver os logs | `docker compose -f docker-compose.prod.yml logs -f backend` |
| **Atualizar para a versão nova** | `bash atualizar.sh` (atalho: baixa do GitHub, reconstrói, limpa imagens antigas e mostra o status). Equivale a `git pull && docker compose -f docker-compose.prod.yml up -d --build`. Os dados (banco, arquivos, `.env`) são preservados. |
| Reiniciar | `docker compose -f docker-compose.prod.yml restart` |
| Desligar | `docker compose -f docker-compose.prod.yml down` |

## Backup (importante — o banco agora é PostgreSQL)

O banco fica num volume do Docker (não é mais a pasta `data/`). Faça assim:

```bash
# Backup do banco (usuários, conversas, configurações):
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U studio studio > backup-$(date +%F).sql

# Backup dos arquivos das conversas:
tar czf workspaces-$(date +%F).tar.gz workspaces
```

Copie esses arquivos para o seu PC (rode **no seu PC**):

```powershell
scp root@SEU_IP:~/Frederico-IA-Studio/backup-*.sql ./
scp root@SEU_IP:~/Frederico-IA-Studio/workspaces-*.tar.gz ./
```

> Também dá para baixar um backup completo pelo próprio app, logado como
> administrador, na opção de backup (botão na barra lateral).

---

## Como funciona por dentro (produção)

- **Caddy** (serviço `web`) recebe as visitas nas portas 80/443, emite o HTTPS
  do seu domínio sozinho (Let's Encrypt), serve o frontend e repassa `/api` ao
  backend (mesma origem — cookies e streaming funcionam sem CORS).
- O **backend não é exposto** à internet — só o proxy fala com ele.
- **Cada usuário** tem login próprio e só enxerga os próprios dados (multi-tenant).
- **PostgreSQL** roda num contêiner interno, sem porta exposta.

## Avisos importantes

- **Cada conversa roda num sandbox isolado, mas COM acesso à internet** (para
  baixar dados, consultar APIs, instalar pacotes). Código gerado pela IA pode
  acessar a rede — por isso use uma **VPS dedicada só a este app**, sem outros
  serviços sensíveis. O backend precisa do Docker do servidor (para criar os
  sandboxes), então não é uma VPS para compartilhar com outras coisas.
- **Custo da IA:** se deixar a chave do servidor num site público, qualquer
  cadastrado gasta a sua conta. Prefira `ALLOW_SHARED_KEY=false` (BYOK) ou defina
  `RATE_MSGS_PER_DAY`.
- **LGPD:** o texto do chat vai para o provedor de IA configurado (o do servidor
  ou o do próprio usuário). Avise seus usuários.
- **HTTPS não saiu?** Confira se o DNS já propagou (`ping`) e se as portas 80/443
  estão liberadas no firewall do **provedor** (além do `ufw`).
