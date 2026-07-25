# Frederico Companion — Assistente Virtual

O **Frederico Companion** é a camada de experiência (um personagem virtual
flutuante) sobre a infraestrutura que o Frederico AI Studio já oferece: catálogo
de modelos, provedores, memória, ferramentas e modo desenvolvedor. O personagem é
apenas a representação visual — a inteligência continua sendo o núcleo do Studio,
e o modelo/provedor é escolhido livremente pelo usuário.

> Filosofia (seção 15 da proposta): diferente do Clippy, o Companion observa
> **apenas o que foi autorizado**, explica por que está intervindo e deixa o
> usuário no controle total da sua presença.

## O que já está implementado (Fase 1 — MVP)

- **Personagem 2D animado** (SVG + CSS, sem dependência 3D) com estados visuais:
  disponível, escutando, pensando, executando, sucesso, alerta, erro e
  silencioso. O avatar reflete em tempo real a atividade do Studio (o mesmo
  `busy`/`statusText` do chat).
- **Presença flutuante**: arrastável pela tela, minimizável e ancorada no canto.
  A posição e o estado minimizado ficam no `localStorage`.
- **Painel ao clicar no personagem** com: modelo em uso, persona (assistente),
  modo de comportamento, status da sessão, alertas, ações rápidas (nova conversa,
  modo desenvolvedor, assistentes) e envio rápido de mensagem — que delega ao chat
  do Studio na conversa aberta.
- **Modos de comportamento** (seção 5): silencioso, auxiliar, proativo, foco e
  apresentação. Controlam quando o Companion pode intervir.
- **Escolha do modelo e da persona** (seção 6.2): qualquer modelo/provedor do
  catálogo do Studio; qualquer assistente pode virar a "voz" do personagem.
- **Alertas proativos com transparência** (seções 8 e 9): cada evento guarda
  origem, data/hora, projeto, nível de importância, dados enviados, ação proposta,
  autorização necessária e resultado. No MVP, tarefas em segundo plano que falham
  viram alertas discretos (respeitando o modo e a permissão).
- **Níveis de permissão 1–5** (seção 7) e **nível de animação** configuráveis.

## Arquitetura

### Backend

- `backend/migrations/015_companion.sql` — tabelas `companion_settings`
  (config por usuário, em JSON) e `companion_events` (fila de alertas com o
  rastro de auditoria).
- `backend/src/routes/companion.js` — API montada em `/api`:
  - `GET  /api/companion` — configuração + persona resolvida + eventos + opções.
  - `PUT  /api/companion` — salva a configuração (sanitizada; nunca confia no cliente).
  - `GET  /api/companion/events` — lista de eventos (`?all=1` inclui os dispensados).
  - `POST /api/companion/events` — cria um alerta (uso interno e, no futuro, do agente local).
  - `PATCH /api/companion/events/:id` — muda status (visto/dispensado/resolvido) e resultado.
  - `POST /api/companion/events/dismiss-all` — limpa os alertas pendentes.
- `backend/src/routes/companion.test.js` — testes da sanitização da configuração.

### Frontend

- `frontend/src/hooks/useCompanion.js` — carrega/salva a configuração e os
  eventos; faz a detecção proativa mínima do MVP.
- `frontend/src/Companion.jsx` — o personagem, o painel e o modal de configuração.
- `frontend/src/companion.css` — estilos e animações isolados (respeitam o nível
  de animação e o tema claro/escuro).
- Montado em `frontend/src/App.jsx`, recebendo o estado ao vivo (`busy`,
  `statusText`, `listening`, `model`, `assistants`, `tasks`) e os atalhos.

## Fase 2 — Companion de desenvolvimento (em andamento)

Primeiro corte: **monitoramento (awareness)**. O backend passa a transformar
sinais reais que já enxerga em eventos/alertas, respeitando o modo de
comportamento e a deduplicação (não repete o mesmo alerta a cada ciclo):

- **Git** — `POST /api/companion/monitor/git` roda `git status` no sandbox da
  conversa e cria alertas de *alterações sem commit* e *commits sem push*
  («Você alterou 7 arquivos mas ainda não fez commit»). O front verifica
  periodicamente enquanto há uma conversa de desenvolvimento ativa.
- **Erros recorrentes** — `POST /api/companion/monitor/logs` recebe linhas de
  log, normaliza cada uma numa assinatura estável (ignorando timestamps,
  números, ids, caminhos) e alerta quando a mesma assinatura cruza o limiar
  dentro de uma janela («O mesmo erro apareceu 5 vezes»).

Novos módulos:
- `backend/src/companion/events.js` — criação/serialização/deduplicação de
  eventos (compartilhado entre a rota e o monitoramento).
- `backend/src/companion/errorDigest.js` — detecção pura de erros recorrentes
  (com testes).
- `backend/src/companion/monitor.js` — `checkGit`/`inspectGit`/`parseGitStatus`
  e `ingestLogs` (com testes de parsing e de política de modo).
- Endpoints `POST /api/companion/monitor/git` e `.../logs`.
- Frontend: `useCompanion` faz o poll dos eventos e do Git da conversa ativa.

Próximos cortes da Fase 2:
- Saúde de containers Docker → alertas de "aplicação fora do ar".
- Fluxo **Debugger Companion** (detectar → explicar → planejar → autorizar →
  executar → testar → apresentar diff), começando pelo botão "Investigar" de
  um alerta de erro recorrente.
- Agente local dedicado (Node.js) coletando os sinais autorizados fora do
  sandbox.
- **Fase 3 — Voz e contexto**: fala/escuta, contexto da janela ativa, captura de
  tela sob demanda.
- **Fase 4 — Personalização e multiassistentes**: vários personagens, temas,
  personalidades e especialidades.
- **Fase 5 — Automação avançada**: rotinas autorizadas, monitoramento remoto e
  relatórios automáticos.

O MVP prioriza **provar a utilidade** antes de investir num avatar 3D
sofisticado: primeiro ele precisa ser útil, depois pode ser visualmente
impressionante.
