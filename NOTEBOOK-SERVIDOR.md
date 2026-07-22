# Usar um notebook como servidor (Linux + Docker)

Guia para deixar o Frederico AI Studio rodando **num notebook com Linux** na sua
casa/escritório e acessá-lo **de qualquer lugar** — sem pagar VPS.

## Antes de começar: qual caminho seguir?

Internet residencial no Brasil normalmente usa **CGNAT** (você não tem um IP
público próprio), então "abrir porta no roteador" costuma **não funcionar** e
não é o caminho recomendado. Use uma destas duas opções:

| Opção | Para quem | Custo | Dificuldade |
|---|---|---|---|
| **A) Tailscale** (recomendada) | Você e sua equipe acessarem de qualquer lugar | Grátis | ⭐ Fácil |
| **B) Cloudflare Tunnel** | Ter um site público `https://ia.suaempresa.com.br` | Grátis (precisa ter um domínio) | ⭐⭐ Média |

Ambas **atravessam o CGNAT** sem mexer no roteador e com tráfego criptografado.

---

## Preparação (para as duas opções)

### 1. Linux + Docker no notebook

Com o Linux instalado (Ubuntu 22.04/24.04 recomendado), abra o Terminal:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Feche e abra o terminal de novo (para o grupo valer).

### 2. Baixar e configurar o app

```bash
git clone https://github.com/SEU_USUARIO/Frederico-IA-Studio.git
cd Frederico-IA-Studio
cp .env.example .env
nano .env
```

Preencha no mínimo:

```env
BETTER_AUTH_SECRET=gere_com_openssl_rand_hex_32
ENCRYPTION_KEY=gere_outro_com_openssl_rand_hex_32
```

Depois de entrar, cadastre uma ou mais chaves em **Provedores de IA**. Sem uma
chave validada, nenhum modelo é carregado para a conta.

(`DOMAIN` só é usado na opção B.)

### 3. Subir o app

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Teste local: abra `http://localhost` no navegador do notebook → tela de senha. ✅

### 4. Impedir que o notebook durma de tampa fechada

```bash
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```

Também desative suspensão automática em Configurações → Energia.
💡 Dicas de hardware: deixe na tomada, num local ventilado; na BIOS, ative
"Restore on AC/Power" se houver (religa sozinho se faltar luz). Os containers
já voltam sozinhos quando o notebook liga (`restart: unless-stopped`).

---

## Opção A — Tailscale (recomendada)

O Tailscale cria uma rede privada criptografada entre seus aparelhos
(notebook-servidor, seu PC do trabalho, seu celular). É como se estivessem
todos no mesmo Wi-Fi, em qualquer lugar do mundo.

### No notebook (servidor)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Abra o link que aparecer e entre com Google/Microsoft (conta gratuita).
Descubra o nome/IP do notebook:

```bash
tailscale status
```

(ex.: nome `notebook-frederico`, IP `100.x.y.z`)

### Nos aparelhos que vão acessar

- **Celular:** instale o app *Tailscale* (Play Store/App Store) e entre com a mesma conta.
- **PC:** instale de https://tailscale.com/download e entre com a mesma conta.

### Pronto — acesse de qualquer lugar

No navegador de qualquer aparelho conectado ao Tailscale:

```
http://notebook-frederico     (ou http://100.x.y.z)
```

Digite a senha do app e use normalmente. 🎉

> 🔐 Segurança: além da senha do app, **só quem está na sua rede Tailscale
> alcança o servidor**. Nada fica exposto à internet pública. Para dar acesso a
> um funcionário, convide-o na sua conta Tailscale (Admin Console → Users).

---

## Opção B — Cloudflare Tunnel (site público com seu domínio)

Para acessar por `https://ia.suaempresa.com.br` de qualquer navegador, sem
instalar nada nos aparelhos. Requisitos: um **domínio seu** (ex.: R$ 40/ano no
Registro.br) com DNS na **Cloudflare** (conta grátis em cloudflare.com).

1. No painel da Cloudflare: **Zero Trust → Networks → Tunnels → Create tunnel**
   (tipo *Cloudflared*). Dê um nome (ex.: `frederico-ia`).
2. Ele mostra um comando de instalação — copie o token e rode no notebook:

```bash
docker run -d --name cloudflared --restart unless-stopped --network host \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run --token SEU_TOKEN
```

3. Ainda no painel do túnel, em **Public Hostname**, adicione:
   - Subdomain: `ia` · Domain: `suaempresa.com.br`
   - Service: `HTTP` · URL: `localhost:80`
4. Acesse `https://ia.suaempresa.com.br` — o HTTPS é da própria Cloudflare.

> A senha do app (`APP_PASSWORD`) continua obrigatória — é ela que impede
> estranhos de usarem sua chave de IA. Na Cloudflare dá ainda para adicionar
> uma camada extra de login (Zero Trust → Access) de graça.

---

## Operação do dia a dia (no notebook)

| Ação | Comando (na pasta do projeto) |
|---|---|
| Status | `docker compose -f docker-compose.prod.yml ps` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f backend` |
| Atualizar | `git pull && docker compose -f docker-compose.prod.yml up -d --build` |
| Desligar o app | `docker compose -f docker-compose.prod.yml down` |
| Backup | copiar as pastas `data/` e `workspaces/` para um pendrive/nuvem |

## Limitações honestas desse arranjo

- O app só funciona **enquanto o notebook estiver ligado e com internet**.
- Se a luz ou a internet da sua casa cair, o app cai junto (a VPS não tem esse
  problema). Para uso profissional crítico, a VPS continua sendo o mais estável.
- Velocidade de **upload** residencial baixa pode deixar downloads de arquivos
  grandes mais lentos para quem acessa de fora.
- Notebook 24/7 esquenta: prefira um modelo que fique bem ventilado e considere
  limitar a carga da bateria a ~80% se a BIOS permitir (prolonga a vida útil).
