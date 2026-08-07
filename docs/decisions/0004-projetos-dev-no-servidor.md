# ADR 0004 — Projetos do Modo Desenvolvedor com fonte de verdade no servidor

Data: 2026-08-07

## Contexto

Os projetos do Modo Desenvolvedor (vínculo repo/pasta, regras, memória
permanente, permissões concedidas, modo de trabalho) tinham origem no
`localStorage` do navegador. O servidor guardava apenas uma cópia de leitura
(migration 021) para o Context Builder. A auditoria do Developer Workspace 3.0
classificou isso como risco R7: trocar de navegador ou limpar dados perdia o
vínculo ("o agente passava a dizer que não encontra o repositório"), as
autorizações de publicação e de comandos morriam com o dispositivo, e o
endurecimento das rotas de botão GitHub (que valida o alvo contra o vínculo do
servidor) dependia de um espelhamento que só acontecia ao rodar um chat.

## Decisão

O servidor vira a fonte de verdade dos projetos:

1. Migration 033 completa a linha de `dev_projects` com `permissions` (JSON) e
   `mode`. `permissions` continua sendo REGISTRO da decisão do usuário — quem
   concede é a re-validação no uso (`githubAccess.js`/`permissionPolicy.js`);
   o upsert usa COALESCE para um chamador antigo (sem os campos) não apagar o
   registro. A lista de conversas do projeto não vira coluna: deriva de
   `conversations.project_id`, que o backend já mantém.
2. Rotas autenticadas `GET/PUT/DELETE /api/dev-projects` + `POST /import`
   (migração única do acervo local, idempotente). Excluir um projeto SOLTA as
   conversas (`project_id=NULL`) — nunca apaga histórico.
3. O `useDevProjects` passa a operar como cache: bootstrap lê do servidor;
   na primeira vez, o acervo do `localStorage` sobe pelo `/import` (guardado
   por um marcador local, para um servidor esvaziado em outro dispositivo não
   ser re-populado por cache antigo); mudanças locais sobem por PUT com
   debounce; exclusão vai direto. Falha de rede mantém o cache local
   funcionando — a UI nunca quebra offline.

## Alternativas descartadas

- **Manter o navegador como origem e melhorar o espelhamento.** Não resolve o
  multi-dispositivo nem a perda por limpeza de dados, e deixa a validação de
  vínculo do servidor dependente de um espelho eventual.
- **Sincronização bidirecional com resolução de conflito por campo.** Custo e
  complexidade desproporcionais para um dado de baixa concorrência (um dono,
  edição esporádica). Last-write-wins por projeto, com debounce, cobre o caso
  real; o marcador de sync evita o único conflito perigoso (ressurreição de
  acervo apagado).
- **Guardar `conversationIds` como coluna/JSON.** Duplicaria uma verdade que
  `conversations.project_id` já mantém, com risco de divergência.

## Consequências

- Projetos, permissões e memória sobrevivem a troca de navegador/dispositivo;
  o pré-voo e as rotas de botão GitHub validam contra o mesmo registro que a
  UI mostra.
- O `localStorage` permanece como cache: partida instantânea e modo offline.
- Um novo dispositivo vê os projetos ao primeiro carregamento — sem passo
  manual de exportação.
- A escrita no servidor é por projeto e debounced (~1 req por rajada de
  edição); o custo é desprezível.
