# REGRAS DO PROJETO — Frederico IA Studio

> Vigência: 2026-08-04  
> Escopo: toda pessoa, agente de IA, automação ou integração que altere este repositório.  
> Documento autônomo: estas regras não dependem de “PROMPT MESTRE” externo.

Estas regras existem para manter o Frederico IA Studio verificável, seguro e coerente enquanto o produto evolui. Elas não são sugestões. Uma violação é tratada como defeito de engenharia.

## 0. Precedência e forma de adoção

1. Requisitos legais, proteção de dados, isolamento entre usuários e segurança do host não podem ser flexibilizados por conveniência.
2. Dentro do repositório, este arquivo prevalece sobre `CLAUDE.md`, documentos de domínio, comentários e hábitos anteriores.
3. `CLAUDE.md` é um checklist operacional curto. Ele não deve duplicar nem contradizer estas regras.
4. Uma tarefa pode restringir o escopo, mas não pode dispensar silenciosamente segurança, testes, documentação ou isolamento. Exceção exige justificativa explícita no PR e, quando estrutural, ADR.
5. As regras valem imediatamente para código novo e para toda área modificada. Lacunas legadas não bloqueiam automaticamente trabalho não relacionado, mas nenhuma mudança pode criar dívida nova ou piorar uma lacuna conhecida.
6. Nenhuma IA ou automação faz merge por conta própria. A entrega termina em Pull Request para decisão humana.

---

## REGRA 1 — DOCUMENTAÇÃO É PARTE DO PRODUTO

### 1.1 Verdade operacional

A documentação descreve o que a branch principal faz hoje. Planejamento, hipótese e intenção devem ser marcados como tal e não podem aparecer como funcionalidade disponível.

É proibido:

- anunciar no README ou na interface algo que ainda não passou pelos critérios de aceite;
- manter números de testes, ferramentas, modelos, migrações ou dependências copiados manualmente quando podem ser derivados do código;
- deixar nomes antigos depois de renomear, mover ou remover componentes;
- declarar “seguro”, “verificado”, “em produção” ou “compatível” sem evidência atual.

### 1.2 Mapa documental adaptado ao repositório atual

| Arquivo | Responsabilidade única |
| --- | --- |
| `README.md` | Porta de entrada: o que o produto é, o que funciona, início rápido e links. Não é o manual completo. |
| `REGRAS-DO-PROJETO.md` | Constituição de engenharia do repositório. |
| `CLAUDE.md` | Sequência curta que agentes executam antes, durante e depois de uma mudança. |
| `CONTINUIDADE.md` | Estado presente, último trabalho, riscos abertos e como retomar. Não é diário histórico. |
| `docs/ARCHITECTURE.md` | Arquitetura e fluxos reais da aplicação. |
| `docs/SECURITY.md` | Modelo de ameaça, fronteiras de confiança, controles e riscos abertos. |
| `docs/OPERATIONS.md` | Deploy, operação, observabilidade, incidentes e recuperação. |
| `docs/TESTING.md` | Estratégia, comandos, ambientes e significado das suítes. |
| `docs/CHANGELOG_HISTORY.md` | Histórico cronológico e decisões antigas preservadas. |
| `docs/CONFIGURACAO.md` | Variáveis, instalação e configuração suportada. |
| `docs/BACKUP_RESTORE.md` | Backup, restauração, chave mestra e testes de recuperação. |
| Documentos de domínio já existentes | Memória, multimodelo, Docling, Modo Design, ambiente de execução e demais subsistemas. |
| `docs/decisions/NNNN-titulo.md` | ADRs de decisões estruturais novas. |
| `docs/AUDITORIA_*.md` | Fotografias de auditorias datadas. Não substituem a documentação vigente. |

Não se cria uma segunda página sobre assunto já coberto. Primeiro se atualiza o documento canônico.

### 1.3 Documentação no mesmo PR

Toda mudança de comportamento, contrato, evento SSE, schema, migration, permissão, ferramenta, fluxo, variável de ambiente, serviço, risco ou comando de operação atualiza o documento afetado no mesmo PR.

Quando não houver impacto documental, a descrição do PR deve registrar:

> Sem impacto documental — motivo: ...

“Atualizaremos depois” não é aceite.

### 1.4 Um documento por domínio, não por arquivo

O repositório possui muitos componentes, rotas, hooks e módulos internos. Não é exigido um documento para cada arquivo pequeno.

Documento próprio é obrigatório quando nasce:

- um serviço ou processo separado;
- um subsistema com fronteira de segurança;
- um contrato público ou protocolo reutilizado;
- uma área de produto com fluxo próprio;
- uma persistência ou ciclo de vida não trivial;
- um runtime, kit ou integração externa relevante.

O documento deve explicar: finalidade, limites, contratos, dependências, persistência, segurança, falhas esperadas, como testar e o que o subsistema não faz.

### 1.5 Cabeçalho de estado

Documento técnico novo ou substancialmente revisado deve começar com:

```text
Estado: implementado | parcialmente implementado | planejado
Verificado contra o código em: AAAA-MM-DD
Evidências: <arquivos e testes>
```

Regras:

- `planejado` não pode ser apresentado como disponível;
- ao entrar a primeira implementação, o estado muda no mesmo PR;
- documento implementado ou parcial com mais de 60 dias sem verificação entra como pendência no `CONTINUIDADE.md`;
- auditoria datada permanece histórica, mas seus controles vigentes devem estar refletidos em `ARCHITECTURE.md`, `SECURITY.md`, `OPERATIONS.md` ou no documento de domínio.

### 1.6 README honesto

O README deve ser progressivamente reduzido a uma entrada confiável. Detalhes de arquitetura, segurança, operação e testes pertencem aos documentos canônicos.

Badges e afirmações de status só podem permanecer quando forem verificáveis. Badge estático de “produção”, “LGPD”, cobertura ou segurança não substitui evidência.

### 1.7 Conteúdo gerado vence conteúdo manual

Devem ser gerados a partir da fonte sempre que possível:

- inventário de ferramentas e schemas;
- catálogo de modelos e capacidades;
- bibliotecas disponíveis no sandbox;
- lista de migrations e estado do schema;
- variáveis de ambiente documentáveis;
- eventos e contratos que já possuam schema;
- contagem de testes.

Arquivo gerado deve informar a fonte e não pode ser editado manualmente. O CI deve reprovar divergência.

### 1.8 Idioma e estilo

- Documentação, ADRs, commits e PRs: português do Brasil, voz ativa e frases objetivas.
- Identificadores, nomes de APIs e termos técnicos consagrados permanecem em inglês.
- Sem marketing em documentação técnica.
- Emoji é aceitável apenas em material de produto quando agrega significado; não é marcador de severidade técnica.
- Data sempre em `AAAA-MM-DD`.

---

## REGRA 2 — FRONTEIRAS DE ARQUITETURA

### 2.1 Frontend não é autoridade

O frontend React/Vite é cliente não confiável. Ele pode melhorar a experiência, mas nunca é a única camada de:

- autenticação ou autorização;
- escopo por usuário;
- validação de permissão;
- limite de uso;
- proteção de segredo;
- decisão de acesso a arquivo, sandbox, conector ou ferramenta.

Toda decisão de segurança é repetida e aplicada no backend.

### 2.2 Backend é a fronteira de aplicação

O backend Node/Express:

- valida entradas;
- resolve a sessão;
- escopa consultas por usuário;
- aplica limites;
- controla ferramentas, provedores, uploads e sandboxes;
- devolve erros sem stack ou segredo;
- não confia em IDs, paths, MIME types ou estados enviados pelo cliente.

Nova rota `/api` exige autenticação por padrão. Exceção pública deve ser explícita, mínima, documentada e testada.

### 2.3 PostgreSQL é a fonte de verdade persistente

Estado que precisa sobreviver a reinício não pode existir apenas em memória.

A arquitetura atual ainda possui estado de processo para SSE, filas, cancelamento, concorrência e sessões de sandbox. Portanto:

- o sistema continua assumindo uma única réplica de backend;
- ninguém pode anunciar escalabilidade horizontal enquanto esse estado não for externalizado;
- criar segunda réplica exige ADR, testes de concorrência, reavaliação de locks e atualização de arquitetura/operação.

### 2.4 `docker-guard` é uma fronteira inviolável

Somente `docker-guard` pode montar `/var/run/docker.sock`.

É proibido:

- devolver o socket ao backend, frontend, Docling ou sandbox;
- ampliar a allowlist sem ameaça, teste de recusa e justificativa;
- permitir container privilegiado, capabilities extras, rede host, binds fora das raízes autorizadas ou remoção das cotas;
- operar container que não pertença ao aplicativo pelas labels previstas.

Mudança no guarda exige revisão de segurança e testes que provem que a requisição bloqueada não chegou ao daemon.

### 2.5 Serviços auxiliares permanecem internos

PostgreSQL, ClamAV, Docling e `docker-guard` não recebem porta pública sem ADR e análise de ameaça.

Novo serviço precisa de:

- papel e dependências documentados;
- health check;
- limites de CPU/memória quando relevante;
- política de autenticação interna;
- comportamento quando indisponível;
- configuração em desenvolvimento e produção;
- testes e validação do Compose.

### 2.6 Sem atalhos entre camadas

Não duplicar regra de negócio em locais independentes sem contrato compartilhado. Quando frontend e backend precisam da mesma precedência, enum ou schema, a origem deve ser única ou existir teste espelhado que detecte divergência.

---

## REGRA 3 — BANCO DE DADOS E MIGRATIONS

### 3.1 Migration publicada é imutável

Migration que entrou na `main` não é reescrita. Correção gera migration nova, numerada em sequência.

### 3.2 Requisitos de toda migration

Toda migration deve:

- funcionar em banco vazio;
- ser reaplicável conforme o padrão idempotente adotado pelo projeto;
- preservar instalações existentes;
- definir chaves, índices, unicidade e `ON DELETE` conscientemente;
- considerar volume de dados, lock e tempo de execução;
- ter teste de integração;
- atualizar arquitetura, domínio e operação quando houver impacto.

Alteração destrutiva exige plano de backup, compatibilidade de leitura/escrita e estratégia de recuperação.

### 3.3 Isolamento multiusuário

Tabela com dado de usuário deve ter escopo inequívoco. Toda leitura, escrita e exclusão deve provar o dono.

Regras mínimas:

- `WHERE user_id = ...` ou relação equivalente em toda operação;
- 404 para recurso de outro usuário quando revelar existência for indevido;
- teste com pelo menos dois usuários e IDs semelhantes;
- cascades testadas;
- nenhuma adoção automática de recurso sem dono comprovado.

### 3.4 Sem schema manual

Não se corrige produção com alteração manual não versionada. Emergência deve ser convertida imediatamente em migration reprodutível e registrada no runbook.

---

## REGRA 4 — APIs, SSE E CONTRATOS

### 4.1 Contrato explícito

Mudança em payload, status HTTP, evento SSE, erro, campo persistido ou precedência é mudança de contrato.

Ela exige:

- validação de entrada;
- teste do produtor e do consumidor;
- atualização documental;
- compatibilidade ou migração no mesmo PR;
- tratamento de versão quando quebrar clientes existentes.

### 4.2 Sem sucesso falso

Timeout, cancelamento, stream interrompido, dependência ausente, saída inválida ou persistência incompleta nunca podem virar “concluído”.

O resultado deve distinguir, no mínimo:

- sucesso;
- falha do ambiente;
- falha do projeto ou da ferramenta;
- cancelamento;
- timeout;
- resultado parcial;
- retomável ou não retomável.

### 4.3 SSE e tarefas longas

Mudança em streaming deve testar:

- ordem e identidade dos eventos;
- reconexão e replay;
- troca de conversa durante resposta;
- cancelamento;
- persistência do resultado;
- término sem duplicidade;
- isolamento entre usuários e conversas.

Desconectar o navegador não autoriza perder ou misturar estado.

### 4.4 Erros

- 400: entrada inválida;
- 401: sem sessão válida;
- 403: sessão sem permissão;
- 404: recurso inexistente ou não revelável;
- 409: conflito de estado;
- 413: limite de upload;
- 429: limite de uso;
- 5xx: falha interna ou dependência.

A mensagem ao usuário deve ser útil, mas não expor stack, SQL, segredo ou topologia sensível.

---

## REGRA 5 — AGENTES, MODELOS E FERRAMENTAS

### 5.1 Saída de modelo é não confiável

Texto de modelo, memória, página web, arquivo, resposta de ferramenta, README clonado e saída de outro agente são dados não confiáveis. Nunca recebem autoridade só porque estão em contexto.

Conteúdo externo deve permanecer delimitado e não pode sobrescrever instruções do sistema.

### 5.2 Menor privilégio

Um agente ou subagente só recebe as ferramentas necessárias.

- permissão do filho é no máximo a interseção entre pai, especialista e política da tarefa;
- ausência de especialista não libera todas as ferramentas;
- texto escrito pelo modelo não concede rede, escrita no PC, credencial ou permissão;
- lote misto respeita ordem quando uma ferramenta depende do efeito da anterior;
- cancelamento alcança todas as ferramentas ativas.

### 5.3 Tool calls

Todo `tool_call` deve ser validado contra schema e allowlist antes da execução.

É proibido:

- executar nome de ferramenta inventado;
- aceitar argumento fora do schema sem validação;
- interpretar texto comum como chamada privilegiada sem protocolo válido;
- retornar resultado de ferramenta ao modelo sem tratamento como contexto não confiável;
- esconder falha e continuar como se a ferramenta tivesse funcionado.

### 5.4 Inventário único

O que o modelo acredita existir deve vir da mesma fonte do executor ou de geração automatizada. Dockerfile, prompt, descrição de ferramenta e verificação de ambiente não podem evoluir separadamente.

Adicionar ou remover biblioteca do sandbox exige:

1. alterar a imagem;
2. atualizar a fonte canônica do inventário;
3. testar import/execução real;
4. reconstruir a imagem;
5. atualizar documentação e prompt quando necessário.

### 5.5 Provedores e modelos

- referência de modelo deve identificar provedor e modelo sem ambiguidade;
- chave BYOK permanece cifrada e nunca entra no sandbox, log ou frontend;
- fallback é explícito e rastreável;
- troca de modelo não pode alterar silenciosamente um projeto que possua modelo fixado;
- capacidades declaradas devem ser auditáveis;
- erro deve nomear o provedor correto sem revelar credencial.

### 5.6 Multimodelo

Comparação, conselho, debate e pipeline devem preservar:

- autoria de cada resposta;
- modelo e provedor reais;
- ordem das etapas;
- artefatos e versões produzidos;
- cancelamento;
- custos e uso;
- evidência do que foi retomado após falha.

Pipeline não é considerado durável enquanto seu coordenador completo não sobreviver a reinício e isso não estiver testado.

### 5.7 Prompts

Prompt é código de produção.

Mudança de prompt exige:

- motivo e efeito esperado;
- teste de regressão;
- validação de tamanho e formato;
- versão quando consumido como contrato;
- revisão contra injeção;
- atualização do inventário de ferramentas quando aplicável.

---

## REGRA 6 — SEGURANÇA, PRIVACIDADE E SEGREDOS

### 6.1 Falha fechada

Quando autenticação, autorização, resolução de host, verificação de posse, antivírus, schema ou política de sandbox estiverem incertos, o sistema recusa. Não concede por fallback.

### 6.2 Segredos

Nunca registrar ou devolver:

- chaves de IA;
- tokens de conectores;
- cookie ou segredo de sessão;
- chave mestra de criptografia;
- conteúdo sensível de backup;
- credenciais de banco.

Logs e erros passam por sanitização. Máscara visual não é proteção de armazenamento.

### 6.3 Criptografia e backup

Mudança em criptografia exige teste de ciclo real: cifrar, persistir, exportar, restaurar e decifrar.

Backup deve informar se depende de chave externa. Pacote que contém chave é tratado como segredo.

### 6.4 SSRF e navegação

Toda URL controlada por usuário ou modelo deve:

- aceitar apenas protocolos previstos;
- bloquear loopback, rede privada, link-local e metadados;
- resolver DNS e validar cada IP;
- repetir a validação em redirecionamentos;
- limitar bytes, tempo e tipo de conteúdo.

Playwright, captura de página e exportação PDF obedecem à mesma guarda.

### 6.5 Uploads

Upload exige limite por arquivo, lote, usuário e concorrência, gravação temporária segura, hash por streaming, limpeza de parciais, validação de tipo e política de antivírus honesta.

“Verificado” só pode ser exibido quando a análise realmente ocorreu.

### 6.6 HTML e artefatos gerados por IA

HTML gerado é código hostil:

- renderizar em iframe sandbox;
- CSP restritiva;
- sem `allow-same-origin` quando a arquitetura depender de origem opaca;
- sem acesso a cookies, storage ou API privilegiada;
- mensagens `postMessage` validadas por origem, formato e capacidade.

### 6.7 Mudança de fronteira

Qualquer alteração em autenticação, administração, isolamento, Docker, rede, uploads, conectores, backup, HTML gerado ou execução de comando atualiza `docs/SECURITY.md` e recebe testes adversariais.

---

## REGRA 7 — SANDBOX, DOCLING E KITS DE DOCUMENTO

### 7.1 Sandbox

A chave de isolamento é usuário + conversa. Toda operação de criar, reutilizar, invalidar, destruir, limitar ou coletar sandbox mantém esse escopo.

- rede desligada por padrão;
- autorização de rede vale para o turno e não vaza;
- pastas do PC pertencem ao usuário e usam raízes autorizadas;
- path passa por normalização, contenção e resolução de symlink;
- timeout encerra a árvore do comando, não declara sucesso;
- reinício informa o que persistiu e o que foi perdido;
- observação não pode criar ou destruir ambiente como efeito colateral.

### 7.2 Docling

Docling é opcional e interno. O backend deve se degradar de forma explícita quando indisponível.

Mudança exige testar limites de arquivo/página, timeout, token interno, cache, conteúdo malformado e ausência do serviço.

### 7.3 Geração de Word, Excel e PDF

Os kits oficiais do sandbox são a fonte de diagramação. Não criar um segundo motor improvisado quando o kit cobre o formato.

Antes de entregar:

- arquivo deve existir e ter assinatura/formato correto;
- Word/Excel devem reabrir estruturalmente;
- PDF deve ser auditado e renderizado quando o fluxo exigir;
- fontes devem ter fallback previsível;
- texto não pode sair da caixa útil;
- planilhas devem preservar fórmulas, tipos e abas;
- falha de bloco visual não pode ser engolida em `except` silencioso;
- saída parcial ou inválida não é “arquivo pronto”.

### 7.4 Dependências do runtime

Nunca afirmar que biblioteca, fonte, navegador ou linguagem está disponível apenas porque aparece em documentação. A verificação deve executar import/comando real na imagem que será usada.

---

## REGRA 8 — FRONTEND, UX E ACESSIBILIDADE

### 8.1 Estado real na interface

A interface deve refletir o backend, não antecipá-lo.

- “processando”, “cancelando”, “reconectando”, “parcial” e “falhou” são estados distintos;
- troca de conversa não mistura tokens, arquivos ou progresso;
- botão não pode habilitar ação que o backend recusará por estado;
- seleção persistente pertence ao recurso correto, não a estado global acidental;
- erro de provedor, ferramenta ou ambiente deve ser compreensível.

### 8.2 Responsividade

Fluxos principais devem ser testados em largura móvel e desktop. Sobreposição não pode cobrir caixa de texto, botão de envio, modal ou controles.

Mudança de layout crítico exige teste visual ou E2E de clique real, não apenas snapshot.

### 8.3 Acessibilidade

Novo componente interativo precisa de:

- navegação por teclado;
- foco visível;
- rótulo acessível;
- semântica correta;
- fechamento previsível com `Esc`;
- contraste suficiente;
- estado não comunicado apenas por cor.

### 8.4 Desempenho

O orçamento de bundle é catraca: pode baixar, não subir sem justificativa, medição e plano. Dependência nova deve provar que o custo compensa e que não duplica capacidade já existente.

### 8.5 Compatibilidade

Mudança de contrato frontend/backend entra no mesmo PR ou em sequência compatível. A UI não pode depender de campo ainda não publicado na API.

---

## REGRA 9 — TESTES E PORTÕES DE QUALIDADE

### 9.1 Comandos canônicos

Use os comandos reais do projeto:

```bash
cd backend && npm run check
cd frontend && npm run check

# Quando houver migration, query, rota com banco ou persistência:
cd backend && npm run test:integration

# Kits e runtime Python:
python -m unittest discover -s sandbox -p '*_test.py' -v

# Guarda do Docker:
cd docker-guard && npm test

# Ponta a ponta:
cd e2e && npm test
```

Compose, imagens e serviços alterados também exigem `docker compose config` e build correspondente.

### 9.2 Matriz mínima por área

| Mudança | Evidência mínima |
| --- | --- |
| Backend puro | lint + testes unitários relevantes |
| Rota/API | teste HTTP + autenticação/autorização |
| Banco/migration | banco vazio + idempotência + integração sem skips |
| Frontend | lint + testes + build |
| SSE/chat | unitário + integração/E2E do fluxo afetado |
| Sandbox | testes de isolamento/estabilidade e, quando necessário, daemon falso |
| `docker-guard` | política + proxy; provar que bloqueado não alcança daemon |
| Documento | teste Python + abertura/auditoria do arquivo |
| Segurança | caso positivo, caso negativo e caso adversarial |
| Bug | teste que falha antes e passa depois |

### 9.3 Sem números inventados e sem skips ocultos

Contagem de testes vem de `cd backend && npm run test:count`.

Com PostgreSQL disponível, teste de banco pulado é falha. Dependência ausente que faz suíte se autopular deve aparecer no resultado e na descrição do PR.

### 9.4 Relato verdadeiro

“Testes passaram” sem comando e resultado é proibido.

O PR registra:

- comandos executados;
- resultado;
- quantidade de falhas;
- skips e motivo;
- o que não foi possível executar;
- evidência de CI quando disponível.

Não afirmar validação que não ocorreu.

### 9.5 CI é bloqueante

PR com job obrigatório vermelho não está pronto. Reexecutar sem entender a causa não é correção.

Mudança que altera o significado de um job atualiza `docs/TESTING.md` e o nome do job quando necessário.

---

## REGRA 10 — GIT, COMMITS E PULL REQUESTS

### 10.1 Fluxo

1. Ler `REGRAS-DO-PROJETO.md`.
2. Ler `CONTINUIDADE.md`.
3. Ler os documentos do domínio afetado.
4. Criar branch a partir de `origin/main` atual.
5. Fazer uma frente coerente.
6. Testar.
7. Atualizar documentação e `CONTINUIDADE.md`.
8. Commitar e enviar.
9. Abrir Pull Request para `main`.
10. Não fazer merge sem decisão humana.

### 10.2 Commits

- português do Brasil;
- primeira linha no imperativo, até 72 caracteres;
- efeito observável, não “fix”, “update”, “ajustes” ou “wip”;
- corpo explica o porquê e riscos quando necessário;
- não misturar frentes independentes;
- não usar force-push em branch compartilhada.

### 10.3 PR

Todo PR informa:

- objetivo;
- implementado;
- arquivos/áreas;
- impacto documental;
- decisões/ADRs;
- segurança e privacidade;
- migrations e compatibilidade;
- testes executados e resultados;
- limitações;
- riscos;
- próxima etapa.

Um PR por frente. Branch já associada a PR aberto atualiza o mesmo PR.

### 10.4 Escopo

Refatoração não relacionada não entra “de carona”. Ao encontrar problema fora do escopo, registrar como pendência ou issue, salvo quando ele impede a correção segura.

---

## REGRA 11 — DECISÕES E ADRs

### 11.1 Quando criar

ADR é obrigatório para:

- nova tecnologia central;
- novo serviço;
- mudança de banco, autenticação ou contrato fundamental;
- mudança de fronteira de segurança;
- persistência de estado antes em memória;
- alteração do modelo de isolamento;
- quebra de compatibilidade;
- exceção permanente a estas regras.

Não é necessário ADR para correção local ou refatoração reversível.

### 11.2 Formato

`docs/decisions/NNNN-titulo.md`, em sequência, com exatamente:

1. Contexto
2. Decisão
3. Alternativas descartadas
4. Consequências

ADR publicado é imutável. Revisão gera ADR novo e marca o anterior como substituído.

### 11.3 Sem decisão silenciosa

Código não pode introduzir arquitetura nova antes de a decisão estar registrada no mesmo PR.

---

## REGRA 12 — OPERAÇÃO E RELEASE

### 12.1 Configuração

Toda variável nova entra em `.env.example` sem segredo real, com padrão, obrigatoriedade, escopo e risco documentados.

Configuração de desenvolvimento e produção não pode divergir silenciosamente em segurança.

### 12.2 Saúde e observabilidade

Novo serviço ou dependência operacional precisa de health check e erro diagnosticável.

Logs devem:

- identificar correlação, usuário por identificador seguro, conversa/run quando cabível;
- ter nível coerente;
- evitar PII e segredos;
- registrar recusas de segurança;
- não transformar falha esperada em stack ruidosa nem esconder falha crítica.

### 12.3 Degradação

Serviço opcional indisponível deve produzir estado explícito. O sistema não pode dizer “analisado”, “protegido” ou “indexado” quando ClamAV, Docling, pgvector ou outro mecanismo não executou.

### 12.4 Backup e restauração

Mudança em schema, armazenamento, workspace ou criptografia avalia impacto no backup. Alteração de formato de backup exige teste de restauração.

### 12.5 Release

Funcionalidade só é anunciada quando:

- critérios de aceite passam;
- documentação vigente está atualizada;
- migrações e compatibilidade foram avaliadas;
- riscos conhecidos estão registrados;
- CI obrigatório está verde.

---

## REGRA 13 — ADOÇÃO SEM CRIAR CAOS

Estas regras entram em vigor sem exigir uma reescrita documental imediata.

### 13.1 Dívida legada conhecida

Na data de adoção:

- o README acumula apresentação e manual técnico;
- documentos técnicos ainda não usam um cabeçalho uniforme de estado;
- não há diretório de ADRs consolidado;
- verificações documentais ainda não estão automatizadas no CI;
- `CONTINUIDADE.md` e o histórico precisam continuar sendo mantidos sem voltar a se misturar.

Essas lacunas devem ser reduzidas por frentes próprias ou quando a área for tocada.

### 13.2 Sem dívida nova

A partir desta regra:

- novo subsistema já nasce documentado;
- nova decisão estrutural já nasce com ADR;
- novo contrato já nasce testado;
- novo inventário derivável já nasce gerado;
- novo risco já entra no modelo de ameaça;
- nova funcionalidade não é anunciada antes de existir.

### 13.3 Regra do toque

Ao modificar uma área, corrija incoerências diretamente relacionadas que sejam pequenas e seguras. Não use esta regra para transformar um PR focado em reforma geral.

### 13.4 Revisão destas regras

Mudança neste arquivo exige:

- PR próprio ou seção destacada;
- justificativa;
- impacto;
- ADR quando estrutural;
- aprovação humana.

---

## Checklist de saída

Antes de declarar uma frente concluída:

- [ ] o comportamento implementado corresponde ao pedido;
- [ ] isolamento entre usuários foi preservado;
- [ ] nenhuma fronteira de segurança foi afrouxada;
- [ ] migrations e contratos foram tratados;
- [ ] testes adequados foram executados e relatados;
- [ ] documentação canônica foi atualizada;
- [ ] `CONTINUIDADE.md` reflete o presente;
- [ ] o PR explica limitações e riscos;
- [ ] não existe sucesso falso;
- [ ] o Pull Request está aberto e não foi mesclado automaticamente.
