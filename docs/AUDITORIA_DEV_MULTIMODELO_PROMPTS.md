# Auditoria do Modo Desenvolvedor, Multimodelo e prompts

Data da revisão: 22/07/2026

Base limpa auditada novamente: `main` em `e399370`, incluindo histórico, documentação, rotas, frontend, migrations e testes.

Escopo: execução monoagente, Modo Desenvolvedor, Modo Equipe, Multimodelo, checkpoints, artefatos, memória, contexto, prompts e UX de progresso.

## Resumo executivo

A arquitetura já tinha bons componentes isolados — loop agêntico com ferramentas, controle de pausa/parada, failover, watchdog de stream, sandbox por conversa, memória, validação de documentos e checkpoint final. Porém, o estado real da execução não era uma entidade persistida, e o pipeline multimodelo não operava como um pipeline de artefatos: somente uma etapa executava ferramentas; revisores posteriores produziam texto sem abrir nem corrigir o resultado real.

Esta revisão introduz quatro invariantes:

1. fim de stream ou ausência de `tool_calls` não significa conclusão;
2. arquivo só é entregue com o estado e a validação conhecidos;
3. publicação no GitHub exige autorização explícita no pedido atual;
4. em pipeline de desenvolvimento, cada modelo trabalha sobre o mesmo artefato real e deixa uma versão recuperável.

## Arquitetura encontrada

- Frontend: React 19 + Vite, streaming SSE em `frontend/src/hooks/useChat.js`.
- Backend: Node/Express, PostgreSQL, migrations SQL e chamadas OpenAI-compatible.
- Modelos: BYOK, OpenRouter, DeepSeek e camada gratuita controlada.
- Execução: `backend/src/agent/loop.js`, com ferramentas, reparos, failover, pausa/parada e entrega de arquivos.
- Multimodelo: `backend/src/agent/multiModel.js`, modos comparação, conselho, debate e pipeline.
- Equipe: `backend/src/agent/orchestrator.js`, pareceres paralelos e executor delegado.
- Estado durável: mensagens, `multi_meta`, memória, arquivos e `execution_checkpoints`.
- Artefatos: `/workspace/outputs`, validação de XLSX/XLSM/PDF/DOCX e cartões de download.

## Fluxo monoagente antes e depois

Antes:

`pedido → prompt/contexto → stream → ferramentas → texto final → persistência/arquivo → validação → checkpoint final`

Riscos: persistência ocorria antes da validação; o último checkpoint só era salvo quando o loop já encerrava; a interface inferia sucesso a partir de ferramentas antigas e `busy=false`.

Depois:

`pedido → estado planning/analyzing → stream → tool_running → processing_result → checkpoint seguro → continuing → validating → estado terminal → persistência/arquivo`

O backend é a fonte de verdade dos estados: `waiting`, `planning`, `analyzing`, `tool_running`, `tool_waiting`, `processing_result`, `continuing`, `validating`, `completed`, `stopped`, `paused`, `awaiting_user`, `recoverable_error` e `fatal_error`.

## Fluxo multimodelo

### Comparação

Os modelos respondem de forma independente. Não há síntese. O código real do repositório, quando incluído, entra como dado não confiável em mensagem de usuário, nunca como instrução de sistema.

### Conselho

Os modelos produzem pareceres paralelos; o coordenador consolida. Os textos externos e contribuições permanecem abaixo da hierarquia de instruções do aplicativo.

### Debate

As respostas são revisadas em rodadas. O custo passa a somar somente o delta de cada rodada, evitando contabilização duplicada do uso cumulativo de um slot.

### Pipeline

Antes, somente o primeiro `implementador`/`codigo` chamava `runAgent`; as etapas seguintes recebiam texto e não corrigiam arquivos. Agora, quando o Modo Desenvolvedor está ativo:

1. cada etapa usa `runAgent` e as ferramentas permitidas;
2. todas compartilham o mesmo workspace;
3. cada etapa deve abrir e inspecionar o estado atual;
4. partes válidas devem ser preservadas;
5. correções devem ser aplicadas no arquivo/projeto real;
6. a etapa valida o resultado antes de declarar sucesso;
7. uma cópia versionada é gravada em `.multimodel/<run>/vNN/`, com SHA-256, modelo, papel, validação e caminho para recuperação.

Na nova revisão, essa execução sobre o artefato real deixou de depender do Modo Desenvolvedor: qualquer pedido de arquivo/ferramenta no modo Pipeline usa `runAgent` em todas as etapas elegíveis. Compare, Conselho e Debate continuam textuais e recusam de forma explícita um pedido de entrega de arquivo, orientando o usuário a selecionar Pipeline.

Uma falha de etapa fica explícita no cartão e não apaga versões anteriores. Se houver checkpoint retomável, o pipeline para em vez de avançar como se a etapa tivesse terminado.

## Inventário de prompts ativos

O registro em `backend/src/agent/promptRegistry.js` identifica a release `frederico-prompt-core@2026.07.22.3` e os módulos ativos:

| Módulo | Versão | Origem principal | Uso |
|---|---:|---|---|
| `global-core` | 3.1.0 | `agent/prompts.js` | núcleo neutro e perfil protegido |
| `tool-contract` | 2.0.0 | `agent/prompts.js`, `repair.js` | ferramentas, sandbox e execução |
| `developer-mode` | 2.0.0 | `agent/prompts.js` | modos ask/plan/build/fix/review/auto |
| `multi-model` | 3.0.0 | `agent/multiModel.js` | papéis protegidos, coordenação e pipeline de artefatos |
| `artifact-workflow` | 1.0.0 | `promptRegistry.js` | inspeção, correção e validação sequencial |
| `resume-protocol` | 2.0.0 | `agent/checkpoint.js`, `provider.js` | continuidade após pausa/falha |
| `memory-context` | 2.0.0 | `memory/contextBuilder.js`, `persistence.js` | memória e resumos |
| `docpro` | 10.0.0 | `backend/prompts/docpro/atual.txt` | documentos profissionais |

O evento `prompt_meta` expõe somente release, módulos, caracteres e estimativa de tokens. Conteúdo privado do prompt não é registrado nesse evento.

### Hierarquia adotada

1. instruções do aplicativo e contratos de segurança: `system`;
2. modo de trabalho e capacidades autorizadas: `system`;
3. regras livres do projeto, memória, resumo, extrato de repositório, arquivos, web e saída de outro modelo: `user` em `<untrusted-context>`;
4. pedido atual do usuário: `user`;
5. resultados de ferramentas: `tool`.

O wrapper escapa tentativas de fechar o delimitador ou abrir uma falsa instrução privilegiada. Ele reduz promoção indevida de contexto; não substitui autorização no backend nem isolamento do sandbox.

### Prompts legados

- versões antigas de DocPro em `backend/prompts/docpro/` permanecem como histórico e não são carregadas pelo caminho `atual.txt`;
- comentários ou relatórios antigos em `docs/` não entram em chamadas de modelo;
- textos persistidos de conversas anteriores são histórico/dados, não módulos de sistema;
- o cliente legado de provedor existe por compatibilidade, mas chamadas BYOK usam o cliente e a `baseURL` do usuário.

## Achados e correções

| Prioridade | Achado | Correção |
|---|---|---|
| Crítica | Revisores do pipeline eram apenas textuais | todas as etapas de desenvolvimento agora executam sobre o workspace real |
| Crítica | Não havia versão por etapa | snapshots com hash, validade e link recuperável |
| Alta | Checkpoint apenas no encerramento | checkpoint seguro após cada lote de ferramentas |
| Alta | Objetivo podia sumir no aparo | objetivo explicitamente preservado/reinserido |
| Alta | Conclusão inferida pelo fim do stream | máquina de estados explícita e persistida |
| Alta | Arquivo persistido antes da validação | validação ocorre antes da mensagem e dos cartões |
| Alta | UI mostrava “Tarefa concluída” com base em histórico | painel consome `execution.state`, falhas e retomada |
| Alta | Prompt mandava commit/push automático | publicação bloqueada sem autorização explícita no pedido |
| Alta | Custo multimodelo acumulado era somado novamente | contabilização pelo delta da rodada |
| Alta | Digest/memória/parecer podiam virar `system` | contexto externo rebaixado e delimitado como não confiável |
| Média | Cache/roteamento ignorava `baseURL` BYOK | funções recebem a rota real do provedor do usuário |
| Média | Prompts sem manifesto comum | registro versionado e telemetria segura |
| Média | Testes usavam `/tmp` fixo | caminhos portáveis relativos ao workspace de teste |

## Autorização de GitHub

Clone e leitura continuam disponíveis quando o conector está ativo. `github_push` e `github_create_pr` só são oferecidos quando:

- o modo permite escrita; e
- o texto atual contém uma solicitação explícita de commit, push, publicação ou Pull Request.

Regras do projeto, memória ou texto de outro modelo não concedem essa autorização. A implementação local, por si só, nunca autoriza publicação.

## Estado, checkpoint e recuperação

- checkpoints são gravados entre lotes concluídos, nunca no meio de uma ferramenta;
- ferramentas já concluídas ficam pareadas com seus resultados;
- o objetivo é armazenado como campo e como mensagem preservada quando há aparo;
- conclusão limpa remove o checkpoint intermediário;
- limite de etapas, parada com progresso e falha de provedor mantêm retomada;
- a UI só exibe “Continuar” quando há checkpoint e nenhuma execução ativa;
- versões multimodelo permitem baixar uma etapa anterior mesmo que uma posterior falhe.

## Validação e observabilidade

- `execution_meta` persiste estado terminal, modelo, número de ferramentas, retomada e resultados de validação;
- `multi_meta` persiste modelos, papéis, uso, custo, tempo e versão de artefato;
- `prompt_meta` informa release/módulos/tamanho sem copiar o prompt;
- arquivos XLSX/XLSM/PDF/DOCX continuam com inspeção automática;
- uma validação negativa marca a execução como incompleta e acrescenta aviso explícito à resposta.

## Verificações executadas

- Backend: 226 testes descobertos; 224 aprovados; 2 pulados porque exigem PostgreSQL (`DATABASE_URL`); 0 falhas em 3 rodadas consecutivas.
- Frontend: 7 testes aprovados; 0 falhas.
- Excel real: 4 testes aprovados, incluindo cinco etapas de preservação do mesmo XLSX.
- Build de produção: concluído.
- Aviso conhecido: bundle principal do frontend com cerca de 859 kB antes de gzip; recomenda-se divisão futura de código.

## Limitações e próximos passos

1. A retomada durante uma etapa do pipeline recupera o `runAgent` e os arquivos, mas a continuação automática das etapas multimodelo restantes ainda deve ganhar um coordenador durável próprio, com `pipeline_run_id` e cursor de etapa.
2. Validação genérica de código depende dos comandos/testes encontrados pelo modelo; ainda não existe um contrato uniforme de “teste obrigatório” por stack.
3. O painel de alterações deriva ações de ferramentas e versões; um diff Git estruturado por arquivo/linha seria mais preciso.
4. `toolDefinitions` ainda pode evoluir para declarar, em metadados estruturados, idempotência, efeito destrutivo, retry e pré-condições.
5. Recomenda-se teste integrado com PostgreSQL, provedor simulado e interrupção real do processo entre duas etapas do pipeline.

## Critérios de aceite cobertos

- nenhuma publicação automática no GitHub;
- progresso e término representados por estado explícito;
- validação anterior à entrega;
- checkpoint intermediário seguro;
- objetivo preservado após aparo;
- modelos posteriores capazes de modificar o mesmo artefato;
- versões por etapa recuperáveis;
- contexto externo sem privilégio de sistema;
- custo multimodelo sem dupla contagem;
- BYOK respeitando a base URL configurada;
- testes portáveis em Windows/Linux.
