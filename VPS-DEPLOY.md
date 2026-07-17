# Publicar o Frederico AI Studio numa VPS (acessar de qualquer lugar)

Guia passo a passo para colocar o app num servidor na nuvem e acessá-lo por um
site com **HTTPS e senha**. Tempo estimado: 30–60 min na primeira vez.

## O que você vai precisar

1. **Uma VPS** (servidor virtual Linux). Sugestões com bom custo-benefício:
   - Hetzner (CX22, ~€4/mês) · DigitalOcean (~US$6/mês) · Contabo · Oracle Cloud (tem nível gratuito)
   - Escolha **Ubuntu 22.04 ou 24.04**, mínimo **2 GB de RAM** (4 GB recomendado).
2. **Um domínio ou subdomínio** (ex.: `ia.suaempresa.com.br`). Pode ser um que
   você já tenha; só precisa criar um registro DNS.
3. Sua **chave do OpenRouter/DeepSeek**.

## Passo 1 — Criar a VPS e acessar por SSH

Crie a VPS no provedor escolhido (Ubuntu). Anote o **IP público** dela.

No Windows, abra o **PowerShell** e conecte:

```powershell
ssh root@SEU_IP
```

(Digite `yes` na primeira vez e a senha/na chave que o provedor te deu.)

## Passo 2 — Apontar o domínio para a VPS

No painel do seu provedor de domínio (Registro.br, GoDaddy, Cloudflare...):

- Crie um registro **A** com o nome do subdomínio (ex.: `ia`) apontando para o **IP da VPS**.
- Aguarde alguns minutos (até 1h) a propagação.

Teste: `ping ia.suaempresa.com.br` deve responder com o IP da VPS.

## Passo 3 — Instalar o Docker na VPS

No terminal SSH da VPS, cole:

```bash
curl -fsSL https://get.docker.com | sh
```

## Passo 4 — Baixar o projeto e configurar

```bash
git clone https://github.com/SEU_USUARIO/Frederico-IA-Studio.git
cd Frederico-IA-Studio
cp .env.example .env
nano .env
```

No editor, preencha (mínimo obrigatório):

```env
DEEPSEEK_API_KEY=sk-or-sua_chave
DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1
DEEPSEEK_MODEL=deepseek/deepseek-chat

# >>> OBRIGATÓRIO na internet <<<
APP_PASSWORD=uma_senha_forte_e_longa
DOMAIN=ia.suaempresa.com.br
```

Salve com `Ctrl+O`, `Enter`, e saia com `Ctrl+X`.

> ⚠️ **Não pule o `APP_PASSWORD`.** Sem ele o app fica aberto para o mundo
> inteiro usar sua chave de API paga.

## Passo 5 — Ligar o firewall (recomendado)

```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## Passo 6 — Subir o aplicativo

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

A primeira vez demora alguns minutos (constrói sandbox, backend e frontend).
Quando terminar, acesse **https://ia.suaempresa.com.br** — o certificado HTTPS
é emitido automaticamente. Digite a senha do `APP_PASSWORD` e pronto: o app
funciona de qualquer lugar (computador, celular, tablet). 🎉

## Operação do dia a dia

| Ação | Comando (na pasta do projeto, via SSH) |
|---|---|
| Ver se está rodando | `docker compose -f docker-compose.prod.yml ps` |
| Ver os logs | `docker compose -f docker-compose.prod.yml logs -f backend` |
| Atualizar para versão nova | `git pull && docker compose -f docker-compose.prod.yml up -d --build` |
| Desligar | `docker compose -f docker-compose.prod.yml down` |
| Backup dos dados | copie as pastas `data/` (banco) e `workspaces/` (arquivos) |

Backup rápido para sua máquina (rode no seu PC):

```powershell
scp -r root@SEU_IP:~/Frederico-IA-Studio/data ./backup-data
```

## Como funciona por dentro (produção)

- **Caddy** (serviço `web`) recebe as visitas nas portas 80/443, emite o HTTPS
  do seu domínio sozinho, serve o frontend compilado e repassa `/api` ao backend.
- O **backend não é exposto** à internet — só o proxy fala com ele.
- O **login por senha** protege todas as rotas; a sessão dura 30 dias por cookie.
- Cada conversa continua tendo seu **sandbox isolado sem internet**.

## Avisos importantes

- O modelo de segurança é **uma senha única** (pensado para uso próprio/equipe
  pequena e de confiança). Para vários clientes com contas separadas, o próximo
  passo é implementar autenticação multiusuário.
- O backend continua com acesso ao Docker do servidor (necessário para o
  sandbox). Use uma VPS **dedicada a este app**, sem outros serviços sensíveis.
- Lembre da **LGPD**: o texto do chat vai para o provedor de IA configurado.
- Se o certificado não for emitido, confira se o DNS já propagou e se as portas
  80/443 estão liberadas no firewall do provedor (além do ufw).
