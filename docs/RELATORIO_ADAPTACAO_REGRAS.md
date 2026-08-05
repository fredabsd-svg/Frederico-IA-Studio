# RELATÓRIO DE ADAPTAÇÃO DAS REGRAS — Frederico IA Studio

> **Nota de publicação (2026-08-05).** Este relatório entrou no repositório como
> documento histórico, no formato em que foi entregue. Duas ressalvas, para que
> ninguém o leia como retrato do presente:
>
> - Dos cinco arquivos listados na seção 5, **dois** foram publicados:
>   [`REGRAS-DO-PROJETO.md`](../REGRAS-DO-PROJETO.md) e este relatório. O
>   template de Pull Request, o ADR `0001` e o patch **não** acompanharam a
>   entrega e não existem no repositório — a seção 5 descreve o pacote que foi
>   preparado, não o que está publicado.
> - A limitação da seção 6 (`403 — Resource not accessible by integration`)
>   está superada: a publicação foi feita por branch e Pull Request, sem
>   alteração direta na `main`.
>
> O documento vigente é o `REGRAS-DO-PROJETO.md`. Este arquivo registra por que
> as regras ficaram como ficaram.

**Data da revisão:** 2026-08-04  
**Repositório analisado:** `fredabsd-svg/Frederico-IA-Studio`  
**Branch de referência:** `main`  
**Commit observado:** `957c2d5522712ba77453fd830b4e404c4e74308d`

## 1. Escopo efetivamente revisado

A adaptação foi baseada na leitura do arquivo original de regras e na inspeção, pelo GitHub, dos principais elementos que definem o comportamento e a governança atuais:

- `README.md`;
- `CLAUDE.md`;
- `CONTINUIDADE.md`;
- `docs/ARCHITECTURE.md`;
- `docs/SECURITY.md`;
- `docs/TESTING.md`;
- `docs/CHANGELOG_HISTORY.md`;
- `.github/workflows/ci.yml`;
- `docker-compose.yml`;
- manifests do backend e do frontend;
- histórico recente de commits e branches;
- organização documentada dos serviços, migrations, agentes, ferramentas, sandbox, Docling, Modo Design, kits de documento e testes E2E.

A revisão não se limitou a trocar nomes. As regras foram reescritas para corresponder às fronteiras reais da aplicação.

## 2. Problemas do arquivo original

### 2.1 Dependência inexistente

O texto original dizia complementar um “PROMPT MESTRE”, mas esse artefato não existe no repositório. Uma regra central não pode depender de contexto externo que uma nova sessão talvez não possua.

**Adaptação:** o novo arquivo é autônomo e define sua própria precedência.

### 2.2 Estrutura incompatível

O original falava em crates, workers e pacotes como unidade documental. A aplicação real é composta por:

- frontend React 19/Vite;
- backend Node 20/Express;
- PostgreSQL com pgvector e migrations;
- `docker-guard`;
- sandbox Docker e runtime Python;
- Docling;
- ClamAV opcional;
- E2E com Playwright;
- módulos de agentes, ferramentas, memória, multimodelo e Modo Design.

**Adaptação:** a documentação passa a ser exigida por domínio, serviço, contrato ou fronteira de segurança, não por arquivo pequeno.

### 2.3 Estrutura documental já consolidada

O projeto já usa documentos canônicos em nomes diferentes dos previstos no original: `ARCHITECTURE.md`, `SECURITY.md`, `OPERATIONS.md`, `TESTING.md`, `CHANGELOG_HISTORY.md` e `CONTINUIDADE.md`.

**Adaptação:** os nomes atuais foram preservados. Não foi proposta uma reorganização destrutiva que quebraria links e criaria duplicidade.

### 2.4 Estado atual já possui mecanismo próprio

`CONTINUIDADE.md` funciona como fotografia do presente, enquanto `docs/CHANGELOG_HISTORY.md` preserva o histórico. Criar outro `docs/status.md` repetiria a mesma responsabilidade.

**Adaptação:** `CONTINUIDADE.md` foi mantido como fonte do estado corrente.

### 2.5 CI mais avançado que as regras originais

O CI já valida:

- sintaxe;
- backend em Node 20 e 22;
- PostgreSQL real e migrations;
- ausência de skips na integração;
- frontend e build;
- orçamento de bundle;
- kits Python;
- `docker-guard`;
- E2E com Chromium;
- Compose e imagens;
- proteção do socket Docker.

**Adaptação:** essas garantias foram incorporadas como portões obrigatórios por tipo de mudança.

## 3. Regras específicas introduzidas

A versão adaptada adiciona regras próprias para:

1. precedência e adoção sem dívida nova;
2. documentação canônica e conteúdo gerado;
3. frontend como cliente não confiável;
4. backend como fronteira de autorização;
5. estado persistente versus estado em memória;
6. PostgreSQL, migrations e isolamento multiusuário;
7. APIs, erros e eventos SSE;
8. agentes, subagentes, tool calls e menor privilégio;
9. provedores, fallback, catálogo e multimodelo;
10. prompt como código de produção;
11. segredos, criptografia, backup e SSRF;
12. uploads, antivírus e HTML gerado por IA;
13. `docker-guard` como única posse do socket;
14. sandbox, Docling e kits Word/Excel/PDF;
15. UX, acessibilidade, responsividade e orçamento de bundle;
16. matriz de testes por área;
17. commits, Pull Requests, ADRs, operação e releases;
18. adoção progressiva do legado sem criar dívida nova.

## 4. Decisões de adaptação

- Não renomear os documentos técnicos existentes.
- Não exigir documento para cada componente ou arquivo.
- Introduzir ADR apenas para decisões estruturais novas.
- Transformar o template de PR em mecanismo de verificação.
- Manter `CLAUDE.md` curto e subordinado às regras.
- Não anunciar capacidade sem teste e evidência.
- Preservar como invariantes imediatos: isolamento entre usuários, autenticação, socket Docker, segredo fora do sandbox, SSRF, migrations e sucesso real de execuções.
- Tratar README excessivamente amplo e cabeçalhos documentais não uniformes como dívida legada, não como motivo para bloquear toda mudança atual.

## 5. Arquivos preparados

| Arquivo | Finalidade |
| --- | --- |
| `REGRAS-DO-PROJETO.md` | Regras completas adaptadas ao aplicativo. |
| `CLAUDE.md` | Checklist operacional atualizado e subordinado às regras. |
| `.github/pull_request_template.md` | Template para exigir documentação, segurança, migrations, testes e riscos. |
| `docs/decisions/0001-adocao-das-regras-do-projeto.md` | ADR que registra a adoção e as alternativas descartadas. |
| `Frederico-IA-Studio-regras.patch` | Patch único para aplicar todas as mudanças, inclusive a nota em `CONTINUIDADE.md`. |

## 6. Limitação encontrada no GitHub

A integração do GitHub conseguiu ler o repositório, arquivos, branches, commits e permissões declaradas. Porém, as ações de criar branch e criar arquivo foram recusadas pelo GitHub com `403 — Resource not accessible by integration`.

Por segurança, nenhuma alteração foi feita diretamente na `main`. O pacote foi preparado para aplicação em uma branch pelo proprietário do repositório ou após conceder à integração permissão de **Contents: Read and write** e **Pull requests: Read and write**.
