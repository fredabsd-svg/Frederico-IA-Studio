# Frederico Companion — Assistente Virtual

Estado: parcialmente implementado
Verificado contra o código em: 2026-08-06
Evidências: `backend/src/copilot/executive.js`, `backend/src/copilot/executive.test.js`, `backend/src/routes/copilot.js`, `frontend/src/components/CopilotWorkspace.jsx`

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

## Nino como gerente executivo

O chat próprio do Nino não usa mais a revisão gramatical como identidade
principal. O prompt de produção define cinco responsabilidades: Planejador,
Crítico, Guardião, Otimizador e Tecelão. Ele pode questionar respostas do agente
principal, propor divisão de tarefas e recomendar o próximo resultado útil, mas
não recebe autoridade implícita para executar ações.

Ao surgir um novo anexo, o frontend envia somente metadados mínimos (nome,
caminho lógico, MIME e tamanho) ao motor local de sugestões. CSVs recebem uma
proposta de auditoria/relatório/dashboard; PDFs recebem uma sugestão condicional
de Docling/OCR. Arquivos já presentes quando a tela abre não geram alertas
retroativos.

Sugestões geradas por anexos aparecem imediatamente em um balão junto ao Nino,
sem exigir que o painel seja aberto primeiro. Para PDFs, **Analisar PDF** é uma
ação real: após a confirmação, o pedido é enviado ao agente principal da conversa,
que aguarda o upload e usa o conteúdo do Docling/OCR quando disponível. O mesmo
botão aparece no cartão do aviso dentro da aba **Conversa**; **Agora não** ou
**Dispensar** encerram a sugestão sem executar nada.

A aba **Ações** expõe ferramentas separadas e auditáveis:

- `POST /api/copilot/tools/sandbox-audit`: verifica conteúdo textual, estrutura
  de CSV, risco de fórmula injetável, disponibilidade de texto em PDF e sinais
  de dados pessoais. Para `.xlsx` binário, informa explicitamente que a análise
  completa das fórmulas ainda exige integração com o arquivo no sandbox.
- `POST /api/copilot/tools/lgpd-check`: conta padrões de CPF, e-mail, telefone,
  cartão e possíveis segredos sem devolver ou registrar os valores encontrados.
- `POST /api/copilot/tools/model-routing`: classifica o pedido em nível econômico,
  equilibrado ou avançado e informa as capacidades exigidas.
- `POST /api/copilot/tools/memory-review`: identifica duplicatas exatas e notas
  com possíveis dados sensíveis. A ferramenta é somente leitura e nunca apaga
  memória automaticamente.
- `POST /api/copilot/tools/executive-action`: executa auditoria lógica ou
  otimização de prompt com instruções dedicadas e conteúdo delimitado como dado
  não confiável.
- `POST /api/copilot/tools/auto-routine`: cria uma rotina somente após confirmação
  explícita, política `criar_rotinas` autorizada e registro em auditoria.

Os resultados são apoio à decisão, não certificação legal ou garantia contábil.
Valores sensíveis não entram no log de auditoria; o log registra apenas categoria,
quantidade e resultado da verificação.

### Recuperação de visibilidade

A posição arrastada do Nino é salva no navegador. Ao abrir o aplicativo ou mudar
o tamanho da janela, essa posição é validada e ajustada para permanecer dentro da
área útil, inclusive sem ficar atrás da coluna **Atividade** do Modo Desenvolvedor.
Em **Configurações › Agente › Copiloto — Personalização**, a ação **Restaurar na
tela** remove a posição e o estado minimizado salvos e reativa o personagem ao
salvar.

### A faixa de controles do rodapé

Enquanto o Nino está ancorado no canto, quem o mantém fora do caminho é o CSS:
`companion.css` calcula o `bottom` a partir de `--composer-h` e `--dock-h`, as
alturas reais publicadas por `useComposerHeight`. **Arrastado**, ele passa a ter
`left`/`top` absolutos e o CSS deixa de valer — e voltava a pousar sobre o botão
de enviar e sobre o cabeçalho do terminal inferior, engolindo os cliques de
recolher, expandir e maximizar (medido por hit test: `elementFromPoint` no botão
devolvia o SVG do mascote).

A regra agora é uma só, em `frontend/src/companionPosition.js`:

- `PROTECTED_CONTROL_SELECTORS` lista os controles que o personagem **nunca**
  pode cobrir — `.composerWrap`, `.dockHead` e o botão `.chatJump`. Cobrir a
  *área de log* do terminal continua permitido: quem arrastou o Nino para lá
  quis isso; cobrir botão é outra coisa.
- `protectedBottomInset` converte as medidas desses controles no recuo inferior
  que `clampCompanionPosition` já sabia aplicar. O personagem para acima do
  controle mais alto da faixa, com 8px de folga.

O recuo é aplicado nos dois caminhos: no arraste (medido uma vez, no início do
gesto — medir a cada `pointermove` forçaria layout dezenas de vezes por segundo)
e na revalidação de visibilidade. Como a faixa muda de altura sem que a janela
mude de tamanho — abrir, expandir ou redimensionar o terminal —, o
`useComposerHeight` anuncia cada mudança no evento `BOTTOM_BAND_EVENT`
(`fred:bottom-band`), e o personagem recalcula. Sem esse evento, abrir o terminal
por baixo de um Nino já arrastado o deixaria parado em cima dos botões.

Limite conhecido: o botão **Ir para o final** aparece e desaparece conforme a
rolagem, sem passar pela faixa medida. Ele é respeitado no arraste, mas um Nino
já parado ali não sai do caminho quando o botão surge — o botão é transitório e
a conversa continua rolável pelo teclado e pela roda.

Os guardas: `frontend/src/companionPosition.test.js` para a regra pura e
`e2e/tests/layout.spec.js` para o comportamento no navegador, com hit test e
clique real (os três casos de arraste falham se o recuo for removido).
