# Frederico AI Studio

Aplicacao web em portugues para conversar com modelos de IA, analisar arquivos,
executar tarefas em um sandbox Docker e entregar arquivos reais no chat.

O Frederico AI Studio funciona com provedores compativeis com a API OpenAI,
como OpenRouter, DeepSeek e endpoints privados compativeis. Ele combina chat,
ferramentas, memoria, pesquisa na web, modo equipe e um ambiente de execucao para
documentos, planilhas, PDFs, codigo e automacoes.

## Estado atual

- Banco de dados em PostgreSQL.
- Login com Better Auth: e-mail/senha, GitHub e Google quando configurados.
- Frontend em React + Vite e backend em Node.js + Express.
- Um sandbox Docker por conversa para Python, Bash e geracao de arquivos.
- Fase atual de produto: autenticacao concluida; isolamento completo de dados por
  usuario e chaves de API por usuario ainda sao a proxima fase.

Leia [CONTINUIDADE.md](CONTINUIDADE.md) antes de iniciar uma nova frente de
trabalho. Ele registra a arquitetura, decisoes, riscos e proximos passos.

## Principais recursos

- Assistentes personalizados com instrucoes, modelos, ferramentas e personalidade.
- Arquivos reais no chat: Excel, Word, PDF, CSV, ZIP, imagens, graficos e OCR.
- Memoria de longo prazo com recuperacao semantica e painel de revisao.
- Modo Equipe para combinar perspectivas de varios assistentes.
- Modo Desenvolvedor para trabalhar sobre uma pasta de projeto autorizada.
- Pesquisa na internet via Google Custom Search ou DuckDuckGo.
- Ditado por voz, tarefas em segundo plano, historico por cliente e analises de uso.
- Temas visuais e interface responsiva para computador e celular.

## Execucao de tarefas

O chat transmite a resposta ao vivo e mostra as ferramentas utilizadas. O app
inclui controles para pausar, continuar e parar uma tarefa, alem de limites de
tempo para comandos no sandbox e de etapas para o agente.

As tarefas podem ler arquivos enviados, criar documentos, gerar planilhas,
executar Python e Bash no sandbox ou consultar a web quando a pesquisa for
ativada pelo usuario.

## Arquitetura

~~~text
Navegador
    |
    v
React + Vite (porta 5173)
    |
    v
Express + SSE (porta 3001) ---- API compativel com OpenAI
    |             |
    |             +---- PostgreSQL
    |
    +---- Docker sandbox por conversa ---- arquivos em workspaces/
~~~

O frontend usa a mesma origem e o Vite repassa /api para o backend. Isso faz o
chat e o streaming SSE funcionarem tambem atras de Tailscale ou de um proxy HTTPS.

## Comecar

### Pre-requisitos

- Docker Desktop em execucao.
- Uma chave de API de um provedor compativel com OpenAI.
- Segredos do Better Auth para o login local.

### 1. Configurar o ambiente

No PowerShell, crie seu arquivo local de configuracao:

~~~powershell
Copy-Item .env.example .env
~~~

Preencha ao menos estes valores no arquivo .env:

~~~env
DEEPSEEK_API_KEY=sua_chave
DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1
DEEPSEEK_MODEL=deepseek/deepseek-chat

BETTER_AUTH_URL=http://localhost:5173
BETTER_AUTH_SECRET=gere_um_valor_com_openssl_rand_hex_32
ENCRYPTION_KEY=gere_outro_valor_com_openssl_rand_hex_32
~~~

Para usar DeepSeek diretamente, altere a URL para
https://api.deepseek.com e use o modelo correspondente. GitHub e Google sao
opcionais: deixe as credenciais OAuth vazias para usar apenas e-mail/senha.

### 2. Subir o aplicativo

No Windows, abra iniciar.bat. Ele prepara e inicia os servicos.

Ou use o terminal:

~~~powershell
docker compose up --build
~~~

Abra [http://localhost:5173](http://localhost:5173). O primeiro acesso apresenta
a tela de cadastro ou login.

### 3. Atualizar uma instalacao existente

~~~powershell
git pull
docker compose up --build -d
~~~

Depois, recarregue a pagina no navegador. Alteracoes de backend exigem rebuild;
em Windows, alteracoes de frontend podem exigir reiniciar o servico frontend.

## Estrutura do projeto

~~~text
Frederico-IA-Studio/
|-- docker-compose.yml       # PostgreSQL, backend, frontend e imagem sandbox
|-- Dockerfile               # backend Node 20
|-- sandbox/Dockerfile       # Python, ferramentas de documentos e utilitarios
|-- migrations/              # schema PostgreSQL e Better Auth
|-- backend/src/
|   |-- server.js            # API HTTP, SSE, tarefas e rotas autenticadas
|   |-- agent.js             # loop agente, equipe, memoria e controles
|   |-- tools.js             # arquivos, sandbox, pesquisa web e imagens
|   |-- sandbox.js           # ciclo de vida dos containers Docker
|   |-- auth.js              # Better Auth
|   '-- memory/              # memoria e indexacao semantica
|-- frontend/src/
|   |-- App.jsx              # aplicacao principal
|   |-- AuthGate.jsx         # protecao de sessao
|   |-- LoginScreen.jsx      # cadastro e login
|   '-- components.jsx       # componentes reutilizaveis
'-- CONTINUIDADE.md          # handoff obrigatorio entre sessoes
~~~

## Variaveis importantes

| Variavel | Padrao | Finalidade |
|---|---:|---|
| DEEPSEEK_API_KEY | - | Chave do provedor de IA |
| DEEPSEEK_BASE_URL | DeepSeek | Base compativel com OpenAI |
| DEEPSEEK_MODEL | deepseek-chat | Modelo principal |
| BETTER_AUTH_URL | http://localhost:5173 | Origem publica do app e callbacks OAuth |
| BETTER_AUTH_SECRET | - | Segredo de sessao do Better Auth |
| ENCRYPTION_KEY | - | Reservada para chaves por usuario na proxima fase |
| TOOL_TIMEOUT_MS | 45000 | Tempo maximo de um comando de sandbox |
| AGENT_MAX_STEPS | configurado pelo esforco | Limite de etapas da tarefa |
| SANDBOX_MEMORY / SANDBOX_CPUS | 2048m / 1 | Recursos do sandbox |

Consulte o arquivo [.env.example](.env.example) para todas as opcoes.

## Seguranca e limites atuais

- O backend recebe o socket Docker para criar sandboxes. Isso e uma permissao
  privilegiada e o backend nao deve ser exposto sem protecao adequada.
- A sandbox roda sem privilegios, com limites de CPU, memoria e processos, mas a
  rede esta habilitada intencionalmente para pesquisas e automacoes. Codigo e
  arquivos montados devem ser tratados como dados sensiveis.
- Conteudo enviado ao modelo, inclusive texto extraido de arquivos e paginas web,
  pode ser transmitido ao provedor configurado. Avalie LGPD, sigilo e residencia
  de dados antes de enviar informacoes sensiveis.
- O login ja existe, mas o isolamento completo entre varios usuarios ainda esta em
  desenvolvimento. Nao trate a instalacao atual como um SaaS multi-tenant pronto
  para terceiros ate a conclusao da Fase 3 descrita no CONTINUIDADE.md.

## Validacao local

Os testes mais relevantes podem ser executados assim:

~~~powershell
node --test backend/src/agent.control.test.js backend/src/tools.pathResolution.test.js frontend/src/sse.test.js
docker compose exec -T frontend npm run build
~~~

## Documentacao complementar

- [CONTINUIDADE.md](CONTINUIDADE.md): estado atual, decisoes e handoff.
- [NOTEBOOK-SERVIDOR.md](NOTEBOOK-SERVIDOR.md): acesso remoto com notebook e Tailscale.
- [VPS-DEPLOY.md](VPS-DEPLOY.md): publicacao em VPS com HTTPS.

## Processo de contribuicao

Toda mudanca relevante precisa atualizar CONTINUIDADE.md, passar por validacao,
receber um commit descritivo em portugues e ser enviada ao GitHub na mesma sessao.
Nao inclua arquivos gerados, lockfiles alterados apenas pelo ambiente ou notas de
outras frentes sem revisao explicita.
