# CONTINUIDADE — Estado do projeto Frederico AI Studio

> Documento de handoff para continuar o desenvolvimento em uma nova sessão.
> Última atualização: 2026-07-14. Leia isto ANTES de qualquer mudança.

## 0. PONTO ATUAL (2026-07-14) — o que foi feito depois da v. de memória

Branch `claude/new-session-ohbtj0`, PR #1. Tudo validado (esbuild/node --check)
e enviado. Desde a versão de memória, foi adicionado/corrigido:

- **Reforma visual (ChatGPT/Claude/Jan.ai):** abre em tela de boas-vindas
  (conversa "rascunho" — registro só no 1º envio via `ensureConversation`,
  single-flight); barra lateral **recolhível** (`sideHidden`); busca de
  conversas (procura em TODOS os clientes via `?all=1`); tela de boas-vindas
  com cards; campo de mensagem arredondado.
- **Layout da barra lateral:** conversas + ferramentas num único scroll
  (`.sideScroll`) — histórico com espaço garantido, nada cortado.
- **Caixa de mensagem:** todos os botões agrupados num **menu único**
  (`.cmpMenu`, ícone SlidersHorizontal): Anexar, Pesquisa web, Esforço,
  Ditar, Segundo plano. Só menu + textarea + enviar visíveis. CUIDADO: a regra
  base `.composer button{height:48px;width:52px}` sobrescreve botões novos —
  use seletores mais específicos (`.composer .cmpMenuBtn`, `.cmpMenuPanel .cmpItem`).
- **Seletor de modelos:** filtros (família via `<select>`, lançamentos/NOVO,
  grátis, contexto, capacidades), favoritos (localStorage), ordenar por
  novos/baratos. `/api/models` expõe created, context, price, vision, free.
- **7 temas** (claro/escuro + slate/indigo/emerald/amber/sepia) via classes
  `.t-<id>` + `theme` state; botão Tema abre seletor.
- **Esforço da IA** (baixo/medio/alto/extra/max): reasoning effort (OpenRouter)
  + maxSteps + nudge. Enviado no body do chat; aliases p/ nomes antigos.
- **Correção de bugs (revisão com 4 agentes):** symlink escape (safeJoin +
  realInside), BLOCKED_PATHS/isDangerousHostPath, SSRF no web_fetch,
  execInSandbox (error handler + demux + cap), getContainer single-flight,
  vazamento de memória entre clientes (findSimilar por escopo + 'passage'),
  guardas Array.isArray no front, etc.
- **Economia de tokens** (`economy_mode`, LIGADO por padrão): contexto ~8k,
  histórico 20, extração de memória só a cada 4 msgs.
- **Recursos novos:** Ferramentas/apps embutidos (EMBEDDED_APPS: NF-e, OCR,
  conciliação, comparador de regimes, dashboard, doc profissional), assistente
  "Documentos profissionais" (seed único via settings.seeded_docpro, Word Design
  em python-docx), Rotinas agendadas (tabela `schedules` + agendador 1x/min),
  Calendário fiscal (com obrigações de Tocantins: GIAM/ICMS dia 9, SPED Fiscal
  dia 15), Caixa de entrada de documentos por cliente (data/inbox).
- **Heartbeat SSE** (": ping" a cada 15s) contra "Upstream idle timeout".
- **Acesso no celular:** app agora usa **mesma origem** (API relativa "" +
  Vite `server.proxy` /api → `backend:3001`; `host:true`, `allowedHosts:true`;
  compose usa `VITE_PROXY_TARGET`). Habilita Tailscale/HTTPS numa porta só.

**PENDENTE / em andamento:** o usuário ia testar **Tailscale Serve** no Windows
(`tailscale serve --bg 5173` → `https://<pc>.<tailnet>.ts.net`), com HTTPS ligado
no admin do Tailscale, para acesso pelo celular com microfone. Confirmar se
abriu. Próximo passo opcional oferecido: fazer o app/serve iniciar sozinho com
o Windows. NÃO foi testado de ponta a ponta em Docker (sem Docker neste ambiente).

## 1. O que é o projeto

**Frederico AI Studio**: aplicativo web de chat agêntico em PT-BR, conectado a
APIs compatíveis com OpenAI (o usuário usa **OpenRouter**), com **um sandbox
Docker por conversa** que executa Python/bash e gera **arquivos reais**
(xlsx, docx, pdf, imagens, zip) baixáveis no chat. Roda via `docker compose`.

- **Repositório**: `fredabsd-svg/Frederico-IA-Studio` (GitHub)
- **Branch de trabalho**: `claude/new-session-ohbtj0` — TODO push vai para ela
- **PR #1 aberto** contra `main` (main é um commit vazio criado só como base)
- Último commit: sistema de memória de longo prazo (8b95c19)

## 2. Sobre o usuário (Frederico) — como trabalhar com ele

- **Contador** (mencionou CRC TO-006157/O-8 como seu registro), usa o app para
  trabalho contábil/fiscal (DFC, fluxo de caixa, propostas, relatórios).
- **Leigo em programação**: explicar passo a passo, sem jargão, em PT-BR.
- Ambiente: **Windows**, Docker Desktop, pasta do projeto clonada via git em
  `C:\Users\conta\Downloads\Frederico-IA-Studio\Frederico-IA\Frederico-IA-Studio`.
- Atualiza com: `git pull` + duplo clique em **`iniciar.bat`** (reconstrói) +
  Ctrl+Shift+R no navegador. **Sempre terminar respostas com essas instruções**
  quando houver mudança de código (dizer se backend mudou → rebuild).
- `.env` dele: chave do **OpenRouter** (`DEEPSEEK_BASE_URL=https://openrouter.ai/api/v1`,
  `DEEPSEEK_MODEL=deepseek/deepseek-chat`). Usa DeepSeek V3 e GPT-4o.
- Manda **prints** quando algo dá errado; responder com diagnóstico + correção.
- Plano futuro dele: servidor caseiro com **notebook Linux + Tailscale**
  (guia pronto em `NOTEBOOK-SERVIDOR.md`; alternativa VPS em `VPS-DEPLOY.md`).

## 3. Stack e estrutura

- **Backend** (`backend/src/`, Node 20 ESM): Express, dockerode, better-sqlite3,
  multer, nanoid, openai SDK, @xenova/transformers (embeddings locais).
  - `server.js` — todas as rotas HTTP + SSE + auth + fila de tarefas
  - `agent.js` — loop agêntico (streaming token a token), orquestrador (modo
    Equipe), regras do sandbox, freio de loop de erros, validador de arquivos
  - `tools.js` — ferramentas: run_python, bash, write/read/list, zip_outputs,
    web_search/web_fetch (backend), generate_image (via IMAGE_MODEL)
  - `sandbox.js` — ciclo de vida dos containers (1 por conversa)
  - `auth.js` — login por senha (APP_PASSWORD; desligado sem ela)
  - `memory/` — **sistema de memória de longo prazo** (ver §5)
- **Frontend** (`frontend/src/`, React 19 + Vite 8, versões FIXADAS):
  `App.jsx` (principal), `MemoryPanel.jsx` (Cérebro), `components.jsx`
  (ToolStep/Slider/Modal/ModelPicker/Collapsible), `constants.js`, `styles.css`
- **Sandbox** (`sandbox/Dockerfile`): python:3.12-slim + pandas, openpyxl,
  xlsxwriter, python-docx, reportlab, weasyprint(+libs pango), matplotlib,
  PyMuPDF, ocrmypdf, ghostscript, camelot, pdf2image, pytesseract(por),
  **ffmpeg** (edição de vídeo/áudio). Sem rede, uid 1000, limites.
- **Deploy**: `docker-compose.yml` (dev: 5173/3001) e `docker-compose.prod.yml`
  (Caddy com HTTPS automático + frontend buildado + backend sem porta pública).
- Utilitários Windows: `iniciar.bat` (limpa + sobe + abre navegador), `parar.bat`.

## 4. Funcionalidades já entregues (todas funcionando)

Assistentes personalizados (Studio com templates e sliders) · Biblioteca de
templates de pedido (+ salvar mensagem como template) · Clientes/Projetos
(conversas e memória isoladas por cliente) · Modo Equipe (orquestrador
multi-assistente) · **Memória de longo prazo** (§5) · Fila de tarefas em 2º
plano (sobrevive a reinício) · Pesquisa na internet (botão globo; Google via
GOOGLE_API_KEY/CSE_ID ou DuckDuckGo) · Ditado por voz (Web Speech pt-BR) ·
Geração/edição de imagens (generate_image, IMAGE_MODEL padrão
google/gemini-2.5-flash-image, prévia no chat) · Edição de vídeo (ffmpeg) ·
Validador automático de xlsx/pdf/docx gerados (selo no cartão) · Exportar
conversa em PDF/Word · Backup .tar.gz de um botão · Análises (tokens por
assistente/modelo/conversa) · Pausar/Continuar/Parar · Streaming ao vivo +
chips de ferramenta expansíveis (mostram código executado e resultado) ·
Editar mensagem estilo ChatGPT (trunca conversa) · Copiar mensagem ·
Mensagens longas recolhíveis · Seletor de modelos com busca e categorias
(⭐ melhores p/ planilhas; 🆓 free separados) · Erros da API traduzidos
(429/401/402...) · Login por senha p/ produção · Arquivos como cartões no
chat · Upload como chips · Tela responsiva (gaveta mobile) · Tema claro/escuro.

## 5. Sistema de memória (recém-entregue — usuário AINDA NÃO TESTOU)

- **Módulos** em `backend/src/memory/`: `embeddings.js` (locais,
  Xenova/multilingual-e5-small ~112MB baixado 1x p/ ./data/models; fallback
  automático para busca por palavras), `memoryService.js` (CRUD tipado:
  perfil/preferencia/projeto/fato/manual + ranking sim+recência+importância+
  fixada + dedupe + settings + guard de segredos looksSensitive em add E
  update), `indexer.js` (após cada resposta: chunk com embedding + escopo do
  cliente; LLM barato [EXTRACT_MODEL] gera resumo/tags e extrai fatos;
  importação de exports do Claude/ChatGPT/json genérico/txt/md/html),
  `contextBuilder.js` (monta contexto por prioridade respeitando
  context_target_tokens, padrão 60k, configurável até 1M+).
- **Rotas**: `/api/memories` (GET busca/POST/PUT/DELETE, /export, /import,
  /reindex), `/api/memory-config`; legadas `/api/memory` mantidas.
- **UI**: painel "Cérebro do Assistente" (MemoryPanel.jsx).
- **Decisões da revisão adversarial** (5 fixes aplicados): chunks têm coluna
  `scope` (isolamento por cliente); apagar/truncar conversa apaga chunks e
  resumos; remover cliente move chunks p/ global; fallback do EXTRACT_MODEL
  depende da base URL; MemoryPanel valida res.ok.
- **Testes**: suíte E2E de 37 casos passou (script no scratchpad da sessão
  antiga — recriar se precisar; testa modo degradado, não o modelo real).

## 6. Decisões/armadilhas técnicas que NÃO podem regredir

1. Binds do sandbox usam `HOST_WORKSPACE_ROOT` (caminho do HOST, não do container).
2. Todo write no workspace: `chownSync(1000,1000)` (exec roda como uid 1000).
3. Timeout mata o container; próximo exec recria sozinho; reaper de 30min.
4. Backend em node:20-**slim** (alpine quebra better-sqlite3).
5. Desconexão SSE: usar `res.on('close')` com `writableEnded` — `req.on('close')`
   dispara imediatamente e matava toda resposta no 1º token (bug histórico grave).
6. Streaming: reenviar ao histórico só {role, content, tool_calls}; emitir
   fallback via delta se o modelo não gerar texto (senão balão vazio).
7. SANDBOX_RULES no prompt: cada run_python é processo novo (sem estado);
   narrar antes de cada ferramenta; ffmpeg disponível; generate_image p/ imagens.
8. Freio: 5 falhas consecutivas de ferramenta → interrompe com o último erro.
9. `AGENT_MAX_STEPS=30`, `AGENT_HISTORY_LIMIT=60` (env).
10. Validação de caminhos com `insideBase()` (startsWith + separador) — nunca
    voltar ao startsWith puro (path traversal).
11. Frontend: dependências com versões fixadas (nunca "latest").
12. Nome de arquivo de upload: converter latin1→utf8 (acentos).
13. Container names sem `container_name` fixo no compose (evita conflito).

## 7. Regras de trabalho (processo)

- Commits em português, descritivos; push SEMPRE para `claude/new-session-ohbtj0`.
- Validar antes de commitar: `node --check` em todo backend + bundle do
  frontend com esbuild (`npx esbuild frontend/src/App.jsx --jsx=automatic
  --bundle --external:react ...`) + `py_compile` em scripts Python embutidos.
- Nunca expor chaves/tokens; nunca salvar dados sensíveis; avisos de
  segurança/LGPD mantidos no README.
- Não quebrar funcionalidades existentes; migrações de banco sempre
  não-destrutivas (ALTER TABLE em try/catch).
- Respostas ao usuário: PT-BR, passo a passo, com seção "Atualize aí" no final.

## 8. Pendências / próximos passos sugeridos

1. **Usuário testar a memória** (git pull + iniciar.bat; 1ª conversa baixa o
   modelo de embeddings ~112MB) — perguntar "quem sou eu?" após algumas conversas.
2. Testar **importação** do export do Claude (conversations.json).
3. Futuro: consolidação/decaimento de memórias; indexação retroativa das
   conversas antigas da instalação; geração de vídeo (fal.ai/Replicate);
   multiusuário (contas separadas); montar o notebook-servidor com Tailscale.

## 9. Estado do git

- Tudo commitado e enviado (working tree limpo até 8b95c19).
- `backend/node_modules` local desta sessão de dev tinha transformers sem o
  binário sharp (limitação do ambiente de dev, NÃO afeta o Docker do usuário).
