# Publicar o Frederico AI Studio numa VPS (acessar de qualquer lugar)

Guia passo a passo para colocar o app num servidor na nuvem, com **domínio
próprio e HTTPS**. Agora o acesso é por **conta de usuário** (cada pessoa cria
o próprio login) — não existe mais senha única. Tempo estimado: 30–60 min na
primeira vez.

---

## Antes de começar: uma decisão importante

Como o app usa IA paga, cada pessoa cadastra suas próprias chaves em
**Configurações → Provedores de IA**. Uma conta nova não recebe modelos até uma
chave ser validada. Se você quiser oferecer uso patrocinado, configure o
**Modo gratuito**, que tem opt-in, allowlist, limites e fila próprios.

> 💡 Você também pode limitar o uso com `RATE_MSGS_PER_DAY=50` (máx. de mensagens
> por usuário por dia) — útil se compartilhar a sua chave.

---

## O que você vai precisar

1. **Uma VPS** (servidor Linux). Boas opções: Hetzner (CX22, ~€4/mês),
   DigitalOcean (~US$6/mês), Contabo, Oracle Cloud (nível gratuito).
   Escolha **Ubuntu 22.04 ou 24.04**, mínimo **2 GB de RAM** — **4 GB
   recomendado**, principalmente com o antivírus dos uploads ligado (ClamAV,
   que vem ativado por padrão e usa ~1–1,5 GB; veja o Passo 8.4).
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
- (Opcional) Crie também um registro **A** para `www` apontando para o mesmo IP —
  o app emite o certificado do `www` sozinho e redireciona para o endereço
  principal.
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

# ---- IA ----
# Cada usuário cadastra e valida suas próprias chaves dentro do aplicativo.
# Para oferecer uma cota patrocinada, configure FREE_TIER_API_KEY e a allowlist.
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

## Passo 8 — Reforçar a segurança do servidor (recomendado)

O firewall do Passo 6 é o mínimo. Estes reforços custam ~10 minutos, não custam
nada em dinheiro e bloqueiam a grande maioria dos ataques reais contra uma VPS
(força bruta no SSH e software desatualizado). Rode tudo na VPS, como root.

### 8.1 — Atualizações de segurança automáticas

O Ubuntu passa a instalar sozinho as correções de segurança:

```bash
apt update && apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades   # responda "Yes"
```

### 8.2 — Bloquear tentativas de invasão (Fail2ban)

Bane automaticamente IPs que ficam tentando adivinhar a senha do SSH:

```bash
apt install -y fail2ban
systemctl enable --now fail2ban
```

Para ver quem já foi bloqueado: `fail2ban-client status sshd`.

### 8.3 — Entrar só com chave SSH (sem senha)

Chave SSH não dá para "adivinhar" como uma senha. **No seu PC** (PowerShell):

```powershell
ssh-keygen -t ed25519        # Enter em tudo (ou defina uma frase-senha)
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@SEU_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Teste `ssh root@SEU_IP` — deve entrar **sem pedir senha**. Só depois de
confirmar isso, desative o login por senha (**na VPS**):

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

> ⚠️ Não desative o login por senha antes de testar a chave, senão você fica
> trancado para fora da VPS.

### 8.4 — Antivírus nos arquivos enviados (ClamAV) — já vem ligado

O `docker-compose.prod.yml` já sobe um serviço **clamav** (antivírus gratuito e
de código aberto, padrão em servidores Linux). Como funciona:

- **Todo arquivo enviado** pelos usuários (anexos do chat, caixa de entrada,
  importação de memória) é **escaneado antes de ser salvo**. Arquivo infectado
  é recusado na hora, com aviso dizendo qual foi a ameaça.
- Quando a verificação acontece, o usuário vê **"✓ Arquivos verificados pelo
  antivírus"** no chat — e a página de apresentação anuncia o recurso.
- **Primeiro boot**: o ClamAV baixa a base de assinaturas (~5 min). Nesse
  meio-tempo os uploads seguem funcionando **sem** verificação, para o app não
  parar. Se preferir recusar uploads enquanto o antivírus estiver fora do ar,
  coloque `CLAMAV_REQUIRED=true` no `.env`.
- **Memória**: o ClamAV usa ~1–1,5 GB de RAM. Com ele ligado, prefira uma VPS
  de **4 GB**. Para desativar: coloque `CLAMAV_HOST=` (vazio) no `.env`,
  remova o serviço `clamav` do compose — e retire o cartão "Arquivos
  verificados" da página de apresentação (`frontend/src/Landing.jsx`), para
  não anunciar algo que não existe mais.

Conferir se está no ar e testar de verdade:

```bash
docker compose -f docker-compose.prod.yml ps clamav        # deve estar "healthy"
docker compose -f docker-compose.prod.yml logs clamav | tail
```

Para uma demonstração segura, use o **EICAR** — um arquivo de teste inofensivo
que todo antivírus reconhece de propósito (padrão da indústria). Crie um `.txt`
com exatamente este conteúdo e anexe numa conversa:

```
X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*
```

O app deve **recusar o arquivo** e mostrar o aviso do antivírus. 🛡️

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
- **ClamAV** (serviço `clamav`) escaneia os uploads dos usuários por dentro da
  rede do Docker, também sem porta exposta (veja o Passo 8.4).

## Avisos importantes

- **Cada conversa roda num sandbox isolado, mas COM acesso à internet** (para
  baixar dados, consultar APIs, instalar pacotes). Código gerado pela IA pode
  acessar a rede — por isso use uma **VPS dedicada só a este app**, sem outros
  serviços sensíveis. O backend precisa do Docker do servidor (para criar os
  sandboxes), então não é uma VPS para compartilhar com outras coisas.
- **Custo da IA:** cada usuário usa as próprias chaves validadas. Se você ativar
  o Modo gratuito patrocinado, defina a allowlist e os limites diários.
- **LGPD:** o texto do chat vai para o provedor de IA escolhido pelo próprio
  usuário. Avise seus usuários.
- **HTTPS não saiu?** Confira se o DNS já propagou (`ping`) e se as portas 80/443
  estão liberadas no firewall do **provedor** (além do `ufw`).
