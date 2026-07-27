import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENT_QUERY_RE, toolAvailabilityNote } from './prompts.js';
import { toolDefinitions } from '../tools.js';

// O prompt manda o modelo NÃO inventar capacidades fora do inventário. O reverso
// também vale: um inventário que cita pacote fora da imagem faz o modelo prometer
// o que o sandbox não entrega, e um pacote instalado que ninguém cita nunca é
// usado. Este guarda compara o que o modelo lê com o que o Dockerfile instala.
// Os COMENTÁRIOS do Dockerfile são descartados de propósito: eles citam os
// pacotes pelo nome para explicar o porquê, então casar contra o arquivo inteiro
// daria um guarda vazio — "pacote comentado mas não instalado" é exatamente a
// divergência que ele precisa pegar. Só o que sobra do `pip install` vale.
const dockerfile = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../sandbox/Dockerfile'),
  'utf8'
).split('\n').filter(line => !line.trim().startsWith('#')).join('\n');

const runPython = [{ type: 'function', function: { name: 'run_python' } }];
const inventario = toolAvailabilityNote(runPython, { includeInventory: true });

// Pacote Python : trecho que precisa aparecer no Dockerfile e no inventário.
// Cobre os casos em que o nome do pacote não é o nome do módulo — é onde o
// modelo erra sozinho, tentando `import strawberry_graphql` ou `import odfpy`.
const PACOTES = [
  ['strawberry-graphql', 'strawberry'],
  ['odfpy', 'odf'],
  ['PyMuPDF', 'fitz'],
  ['opencv-python-headless', 'opencv'],
  ['duckdb', 'duckdb'],
  ['fastapi', 'FastAPI']
];

for (const [pacote, mencao] of PACOTES) {
  test(`${pacote} está na imagem do sandbox e no inventário do modelo`, () => {
    assert.match(dockerfile, new RegExp(pacote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `${pacote} não é instalado em sandbox/Dockerfile`);
    assert.match(inventario, new RegExp(mencao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      `o inventário não menciona ${mencao}`);
  });
}

// A descrição da ferramenta é o que muitos modelos leem para DECIDIR chamá-la;
// pacote ausente ali costuma virar "não tenho como fazer isso".
test('a descrição do run_python cita o GraphQL', () => {
  const runPythonTool = toolDefinitions.find(t => t.function.name === 'run_python');
  assert.ok(runPythonTool, 'run_python deveria existir em toolDefinitions');
  assert.match(runPythonTool.function.description, /strawberry-graphql/i);
});

// Sem isso a pergunta "tem GraphQL aí?" não dispara a verificação real no
// sandbox e o modelo responde de memória — exatamente o que o prompt proíbe.
test('pergunta sobre GraphQL dispara a verificação de ambiente', () => {
  assert.ok(ENVIRONMENT_QUERY_RE.test('dá para montar uma API GraphQL?'));
  assert.ok(ENVIRONMENT_QUERY_RE.test('o strawberry está instalado?'));
});

// Sem run_python o inventário Python não deve aparecer: prometer pacote para
// quem não pode executar Python é a mesma mentira, do outro lado.
test('sem run_python o inventário Python não é enviado', () => {
  const semPython = toolAvailabilityNote([{ type: 'function', function: { name: 'web_search' } }], { includeInventory: true });
  assert.ok(!semPython.includes('strawberry'));
  assert.ok(!semPython.includes('Inventário Python'));
});
