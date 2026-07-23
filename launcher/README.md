# Launcher (.exe) — Frederico AI Studio

Atalho amigável para ligar o app sem digitar comandos. Faz o papel dos `.bat`,
porém como um executável de duplo‑clique. Ele:

1. confere se o Docker Desktop está rodando (e tenta abri-lo se não estiver);
2. sobe tudo com `docker compose up -d --build` — incluindo o `docling-service`
   quando `DOCLING_ENABLED=true` no `.env` (usa o profile `docling`);
3. espera o app responder e abre o navegador em `http://localhost:5173`;
4. deixa a janela aberta para você DESLIGAR quando quiser (tecla `S`).

> Não substitui o Docker: o app continua rodando sobre Docker (o sandbox de
> execução de código depende disso). O launcher só orquestra e abre o navegador.

## Uso

Coloque o `.exe` na **raiz do projeto** (mesma pasta do `docker-compose.yml`) e
dê duplo‑clique.

## Compilar

Requer Go 1.21+. A partir da raiz do projeto:

```bash
# Windows (a partir de Linux/macOS/Windows)
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o "Frederico AI Studio.exe" ./launcher

# Para a plataforma atual (teste local)
go build -o frederico-launcher ./launcher
```

O `.exe` gerado não é assinado; o SmartScreen do Windows pode pedir
"Mais informações → Executar assim mesmo" na primeira execução. Uma assinatura
de código (certificado pago) elimina o aviso, mas não é necessária para uso
pessoal.
