# Testes ponta a ponta (E2E)

Navegador de verdade contra o app de verdade: `vite preview` do **build de
produção**, backend real, PostgreSQL real. O único figurante é o provedor de IA
— `fixtures/provedorFalso.mjs` responde no lugar dele, de forma determinística.
**Nenhum teste aqui usa rede externa nem chave paga.**

## Por que existem

Até então o frontend só tinha teste de módulo (`modelFilters`, `sse`,
`promptCoach`...). Nenhum abria o app. O que estes testes cobrem — streaming ao
vivo, troca de conversa no meio da resposta, reconexão depois de recarregar a
página — não dá para provar sem navegador: depende de `EventSource` real, do
estado do React sobrevivendo à troca de conversa e de o backend continuar a
execução mesmo sem ninguém ouvindo.

É o item 1 da lista "para chegar ao verde" em `docs/AUDITORIA_2026-07.md` §6, e
o provedor falso é o item 2 da mesma lista.

## Rodar

Precisa de um PostgreSQL acessível (o mesmo pré-requisito do
`npm run test:integration` do backend). O banco é **descartável**: os testes
criam uma conta nova por caso e não limpam nada.

```bash
cd e2e
npm install
npm run navegador          # baixa o Chromium do Playwright (uma vez)
E2E_DATABASE_URL='postgres://studio:studio@127.0.0.1:5432/studio' npm test
```

Os três servidores (provedor falso, backend, frontend) sobem sozinhos — não
os inicie à mão.

### Variáveis

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `E2E_DATABASE_URL` | Banco de E2E (cai em `DATABASE_URL` se não vier) | `postgres://studio:studio@127.0.0.1:5432/studio` |
| `E2E_CHROMIUM_PATH` | Usar um Chromium **já instalado** em vez de baixar outro | vazio (usa o do Playwright) |
| `E2E_PAUSA_TOKEN_MS` | Pausa entre tokens do modelo `eco-lento` | `250` |
| `E2E_PORTA_PROVEDOR` / `E2E_PORTA_BACKEND` / `E2E_PORTA_FRONTEND` | Portas | `4599` / `3197` / `4173` |

Ver o que aconteceu num teste que falhou:

```bash
npx playwright show-trace test-results/<pasta-do-teste>/trace.zip
```

## O provedor falso

O comportamento vem do **id do modelo** — não há endpoint de controle, então o
servidor é sem estado:

| Modelo | O que faz |
| --- | --- |
| `eco` | devolve o texto da última mensagem do usuário, token a token |
| `eco-lento` | o mesmo, com pausa entre tokens (dá tempo de trocar de conversa ou derrubar a conexão no meio) |
| `chave-ruim` | responde 401, como uma chave inválida |
| `design-web` | devolve um documento HTML completo **sujo** (conversa em volta + cerca de código), como respondem os modelos reais — usado pelo Modo Design |
| `design-slides` | devolve o JSON de slides (`{"slides":[…]}`) do Modo Design |

Os dois modelos de design respondem no caminho **sem streaming**: o Modo Design
pede um artefato pronto, não um texto que chega aos poucos. E a resposta do
`design-web` vem propositalmente suja — é a limpeza (`extractArtifact`) que o
teste precisa exercitar de ponta a ponta.

Não há modo "provedor que trava": o watchdog de stream parado já tem teste
unitário (`backend/src/agent/streamGuard.test.js`), e reproduzi-lo aqui custaria
os 30 s do menor timeout possível por um resultado que aquele dá em milissegundos.

Ecoar a mensagem é o que permite provar que **não há vazamento entre
conversas**: o teste manda `ALFA…` numa e `BETA…` noutra e cobra que cada uma
só mostre o seu.

O prefixo `/apenas/<modelo>` restringe o catálogo àquele modelo. Assim cada
conta de teste enxerga um modelo só, o app o seleciona sozinho e o teste não
precisa operar o seletor de modelos.

## Como escrever um teste aqui

`fixtures/app.js` tem o essencial:

- `criarConta(request, { modelo })` — conta nova, aceite dos termos, provedor
  falso cadastrado e o modelo fixado nos assistentes;
- `abrirLogado(page, request, conta)` — leva os cookies para o navegador e abre
  o app;
- `enviar(page, texto)` — escreve no compositor e manda com Enter;
- `ui` — os seletores, num lugar só.

Duas regras que o conjunto segue:

1. **Uma conta por teste.** O app tem teto de execuções simultâneas por
   usuário; compartilhar conta faz um teste derrubar o outro.
2. **Seletor acessível** (rótulo, papel, placeholder) sempre que der. Se um
   quebrar, é porque a interface perdeu o rótulo — e isso é uma regressão de
   acessibilidade que vale ser apontada.

## Armadilhas já pagas

- **`reuseExistingServer` está desligado de propósito.** Reaproveitar um
  servidor que ficou de pé faz o teste rodar contra código velho e falhar (ou
  passar) sem motivo aparente.
- **O helper `enviar()` usa Enter, não o clique no botão** — é o caminho
  principal ("Enter envia", escrito embaixo do campo) e o mais rápido. O clique
  tem teste próprio em `tests/layout.spec.js`: o avatar do Nino cobria o botão
  de enviar (defeito encontrado por esta suíte e corrigido depois), e é lá que
  a regressão fica guardada.
- **Ao recarregar, o app abre em "Nova conversa"** — a conversa anterior fica na
  barra lateral e precisa ser clicada.
- **Conversa recém-criada se chama "Nova conversa"** até ganhar título da
  primeira mensagem. Por isso o botão da barra lateral é localizado por CSS
  (`.sidebar button.new`), e não por texto.
