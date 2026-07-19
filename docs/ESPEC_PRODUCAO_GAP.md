# Especificação de produção × estado real do código

> Análise da "Especificação Técnica para Produção — Frederico IA Studio"
> (documento de 18/07/2026, elaborado SEM acesso ao repositório) confrontada
> com o código em 19/07/2026. A seção 10 do documento pedia exatamente esta
> conferência antes da aprovação.

## Resumo executivo

O documento assumia o projeto num estágio anterior ao real. **As Fases 1 e 2
do plano (seção 9) já estavam concluídas e em produção** antes do documento:
o app está no ar em `https://fredericostudio.com.br` (VPS Contabo, Docker +
Caddy/HTTPS), com PostgreSQL (não mais SQLite), Better Auth, multi-tenancy
testado A-contra-B, BYOK criptografado (AES-256-GCM), landing page e medição
de tokens por usuário. Desta especificação, o que faltava de P1 foi
**implementado agora** (ver "Aplicado nesta rodada"); o que é P2/P3 está
registrado como roadmap.

## Pendências da seção 10 — respondidas

| Item | Estado real |
|---|---|
| Catálogo de tools | `backend/src/tools.js`: `run_python`, `bash`, `write_file`, `read_file`, `list_files`, `zip_outputs`, `consultar_cnpj`, `web_search`, `web_fetch`, `generate_image`. Upload via `multer`; entrega via rota autenticada de download com posse verificada. |
| Ciclo do sandbox | `backend/src/sandbox.js`: contêiner por conversa (Docker via socket do host), imagem congelada `frederico-ai-sandbox` (kits docpro/xlspro/pdfpro pré-instalados), reciclagem por ociosidade (30 min), LRU por usuário (`MAX_SANDBOXES_PER_USER`), CapDrop ALL, no-new-privileges, uid 1000, limites de CPU/RAM/PIDs, saída truncada, timeout por comando. |
| Modelo de dados | Migration 003: `user_id` em todas as tabelas de topo; `user_settings` guarda a chave de API do usuário CIFRADA (AES-256-GCM, chave fora do banco em `ENCRYPTION_KEY`). |
| Autenticação | Better Auth completo (e-mail/senha + GitHub/Google), sessões por cookie, todas as rotas `/api` protegidas. Em produção, login social ainda não configurado (só e-mail/senha). |
| Deploy | `docker-compose.prod.yml` (postgres + backend + web/Caddy), `VPS-DEPLOY.md`, `atualizar.sh`. Backend não exposto diretamente. |

## Mapa da especificação × código

### §3 Ferramentas de arquivo e execução — ✅ já existia
Caminhos restritos ao workspace (`safeJoin` + `realInside` bloqueiam escape e
symlink), timeout obrigatório, saída truncada, usuário sem privilégios,
validação de uploads, expurgo por `OUTPUT_RETENTION_DAYS`. Imagem base
congelada e versionada, como o documento recomenda.

### §4 Sandbox em produção — ✅ com adições desta rodada
Arquitetura atual: socket do host montado (o documento classifica como
aceitável apenas com acesso restrito; produção roda com BYOK e cadastro
divulgado por link). **Roadmap: dind ou gVisor/Kata antes de cadastro aberto
indexado** — segue sendo o bloqueador de go-live público da especificação.

Limites obrigatórios da tabela do documento:

| Controle | Estado |
|---|---|
| CPU e memória | ✅ `SANDBOX_CPUS` / `SANDBOX_MEMORY` |
| Tempo de vida (ocioso) | ✅ `SANDBOX_IDLE_TTL_MS` (30 min) |
| Tempo de vida (teto absoluto) | ✅ **novo** `SANDBOX_MAX_AGE_MS` (padrão 12 h) |
| Disco | ✅ retenção por `OUTPUT_RETENTION_DAYS` + coletor de `.tmp_*`; ⏳ cota dura por conversa (roadmap — exigiria quota de filesystem) |
| Rede | ✅ **novo** `SANDBOX_NETWORK=none` bloqueia a saída do contêiner (padrão `full` preserva o comportamento atual; `none` é o recomendado para cadastro aberto) |
| Privilégios | ✅ uid 1000, CapDrop ALL, no-new-privileges, PidsLimit 256 |
| Concorrência | ✅ por usuário (`MAX_SANDBOXES_PER_USER`) + ✅ **novo** global (`MAX_SANDBOXES_GLOBAL`, padrão 20, LRU) |

### §5 Integrações via MCP — ⏳ roadmap (P2, Fase 3)
Não implementado (era P2 no próprio documento). Pré-requisito de auditoria
**já entregue nesta rodada**: tabela `audit_log` registra toda chamada a
recurso externo (usuário, conversa, ferramenta, parâmetro).

### §6 Skills e subagentes — ✅ parcial
O app já tem **assistentes por usuário** (nome, emoji, prompt de sistema,
seed automático com versionamento de prompt — ex.: DOCPRO v9) e o **modo
Equipe** (especialistas em paralelo), que cobrem o desenho básico. Faltam,
como roadmap: lista de tools permitidas POR assistente, modelo preferencial
por assistente e skills globais da plataforma × privadas do tenant.

### §7 Web, agendamento e entrega — ✅ quase tudo já existia
- **Web pelo backend, não pelo contêiner**: exatamente como o documento pede —
  `web_search`/`web_fetch`/`consultar_cnpj` rodam no backend com bloqueio de
  hosts internos (`isBlockedHost`), timeout e limites por etapa/tarefa.
  ⏳ Allowlist de domínios por tenant: roadmap.
- **Agendamento**: rotinas diárias/semanais/mensais por usuário
  (`scheduling.js` + `RoutinesPanel`), fila persistente de tarefas no banco
  (sobrevive a reinício), limite diário aplicado também às tarefas.
  ⏳ Notificação por e-mail/push ao fim de execuções longas: roadmap (P3).
- **Entrega**: download autenticado por cookie de sessão com posse verificada
  (`WHERE id=? AND user_id=?` → 404) e caminho validado contra escape — não há
  caminho previsível sem autenticação. ✅ **novo**: todo download entra na
  trilha de auditoria. ⏳ Publicação de páginas HTML em subdomínio isolado:
  roadmap (P3).

### §8 Multi-tenancy, segurança e custos — ✅ com adições desta rodada
- Isolamento por `user_id` em todas as tabelas e queries — testado
  deliberadamente A-contra-B (16/16).
- **PostgreSQL já é o banco de produção** (a "decisão pendente" do documento
  já estava tomada e executada).
- Segredos: BYOK cifrado em repouso, `ENCRYPTION_KEY`/`BETTER_AUTH_SECRET`
  fora do repositório.
- Limites: `RATE_MSGS_PER_DAY` já existia; ✅ **novo** `RATE_TOKENS_PER_DAY`
  (cota diária de tokens por usuário, bloqueio ao atingir o teto — o controle
  de custo que o documento exige antes de abrir cadastros).
- Auditoria: ✅ **novo** `audit_log` (chamadas externas + downloads) com rota
  `GET /api/audit` (admin vê tudo; usuário comum vê só o próprio).
- ⏳ Verificação de e-mail no cadastro e aviso formal de privacidade/termos:
  pendência já registrada no CONTINUIDADE — segue como bloqueador de
  divulgação ampla.

### §9 Plano de fases — situação
- **Fase 1 (Fundação)** — ✅ concluída (auth, tenancy, sandbox com limites,
  VPS com domínio e HTTPS).
- **Fase 2 (Produto)** — ✅ quase toda (landing, medição por usuário, retenção;
  "planos" comerciais formais não existem — os limites são por env, iguais
  para todos).
- **Fase 3 (Diferenciação)** — ⏳ parcial (assistentes/equipe sim; MCP e
  allowlist de web não).
- **Fase 4 (Escala)** — ⏳ parcial (rotinas sim; runtime reforçado,
  notificações e observabilidade não).

## Aplicado nesta rodada

1. `SANDBOX_MAX_AGE_MS` — teto absoluto de vida do contêiner (12 h padrão),
   além do TTL de ociosidade (`sandbox.js`, testado).
2. `MAX_SANDBOXES_GLOBAL` — teto global de contêineres simultâneos com
   reciclagem LRU (`sandbox.js`).
3. `SANDBOX_NETWORK=none` — bloqueio opcional da saída de rede do sandbox
   (`sandbox.js`, testado; padrão `full` não muda a produção atual).
4. `RATE_TOKENS_PER_DAY` — cota diária de tokens por usuário; consumo
   acumulado em `usage_daily.tokens` a cada resposta (chat e tarefas) e
   verificado antes de rodar o agente (`server.js`, migration 004).
5. `audit_log` — trilha de auditoria de chamadas externas (`web_search`,
   `web_fetch`, `consultar_cnpj`, `generate_image`) e downloads, com rota
   `GET /api/audit` (`audit.js`, `tools.js`, `server.js`, migration 004).
6. `.env.example` documentando as novas variáveis (todas opcionais, padrões
   preservam o comportamento atual de produção).

## Roadmap remanescente (prioridade herdada do documento)

1. **Bloqueador para cadastro aberto indexado**: isolamento reforçado do
   sandbox (dind → gVisor/Kata) + verificação de e-mail + termos/privacidade.
2. Cliente MCP por tenant (GitHub, Microsoft 365) com credenciais cifradas e
   catálogo dinâmico de tools.
3. Tools permitidas e modelo preferencial POR assistente (skills com
   permissões mínimas).
4. Allowlist de domínios para `web_fetch` por tenant.
5. Notificações (e-mail/push) ao término de execuções longas e rotinas.
6. Cota dura de disco por conversa; planos comerciais com limites por plano
   (hoje os limites são globais por env).
