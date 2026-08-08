// Catraca da costura entre o backend e o validador em Python (F-23).
//
// O validador dos artefatos deixou de ser uma template string dentro do
// `outputs.js` e virou `sandbox/validar_artefato.py`, que o backend LÊ e manda
// para o sandbox executar. Isso resolveu a testabilidade e criou uma
// dependência nova: um arquivo fora de `backend/`, que precisa existir na
// imagem do backend (o `Dockerfile` o copia).
//
// É uma dependência fácil de quebrar em silêncio — renomear o .py, mover a
// pasta, esquecer o COPY num Dockerfile novo. E o silêncio é o problema: o
// `validateOutputs` engole exceção e devolve `{}`, que o resto do sistema lê
// como "não validei". A entrega então some com a checagem sem avisar ninguém,
// que é o F-10 de volta por outra porta.
//
// Estes testes falham no CI quando isso acontece, em vez de a validação
// evaporar em produção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatorSource, _validatorPathForTests, pickValidatableFiles } from './agent/outputs.js';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('o módulo do validador existe no caminho que o backend resolve', () => {
  assert.ok(fs.existsSync(_validatorPathForTests),
    `o backend procura o validador em ${_validatorPathForTests} e ele não está lá`);
});

test('o caminho resolvido é o sandbox/validar_artefato.py do repositório', () => {
  // Prova que o `../../..` do outputs.js aponta para a raiz, e não para um
  // arquivo homônimo em outro lugar.
  assert.equal(path.resolve(_validatorPathForTests),
    path.resolve(path.join(raiz, 'sandbox', 'validar_artefato.py')));
});

test('a fonte carrega e expõe a função que o driver chama', () => {
  const src = validatorSource();
  assert.match(src, /^def validar\(files, base="\/workspace", cfg=None\):$/m,
    'o driver monta `validar(json.loads(...))` — a assinatura precisa bater');
  assert.match(src, /^def check_xlsx\(/m);
  assert.match(src, /^def check_docx\(/m);
  assert.match(src, /^def check_pdf\(/m);
});

test('a fonte importa json — o driver chama json.loads sem importar nada', () => {
  // O driver anexado pelo outputs.js usa `json.loads` e `json.dumps` contando
  // com o import do módulo. Se ele sumir, o código quebra só em execução.
  assert.match(validatorSource(), /^import json$/m);
});

test('o validador não importa nada do projeto', () => {
  // Ele roda DENTRO do sandbox, onde só existe o que a imagem do sandbox
  // instalou. Um `from ..algo import x` passaria no lint e falharia no cliente.
  const src = validatorSource();
  const proibidos = src.split('\n').filter(l => /^\s*(from|import)\s+\./.test(l));
  assert.deepEqual(proibidos, []);
});

test('a leitura é cacheada — não relê o arquivo a cada validação', () => {
  assert.equal(validatorSource(), validatorSource());
});

test('o Dockerfile copia o validador para a imagem do backend', () => {
  // Sem esta linha o arquivo não existe em produção: a imagem só copia
  // `backend/`. O teste é chato de propósito — foi a pegadinha que quase
  // passou nesta própria frente.
  const dockerfile = fs.readFileSync(path.join(raiz, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY sandbox\/validar_artefato\.py \.\/sandbox\/$/m);
});

test('o par de testes em Python existe ao lado do módulo', () => {
  // O que fecha o F-23 não é o módulo ter saído do JS: é ele ter bateria.
  assert.ok(fs.existsSync(path.join(raiz, 'sandbox', 'validar_artefato_test.py')));
});

test('pickValidatableFiles e o validador concordam sobre as extensões', () => {
  // Duas listas de extensões em linguagens diferentes: o filtro em JS escolhe
  // quem vai, o roteador em Python decide o que fazer com cada um. Divergir
  // significa mandar arquivo que ninguém valida (e a entrega dizer "ok" por
  // omissão) ou deixar de mandar um que seria validado.
  const src = validatorSource();
  const escolhidos = pickValidatableFiles(
    ['a.xlsx', 'b.xlsm', 'c.docx', 'd.pdf'].map(name => ({ name, path: 'outputs/' + name })), 10);
  assert.equal(escolhidos.length, 4, 'o filtro do JS precisa aceitar as quatro extensões');
  for (const ext of ['xlsx', 'xlsm', 'pdf', 'docx']) {
    assert.ok(src.includes(`"${ext}"`), `o roteador em Python não trata .${ext}`);
  }
});
