// Sonda controlada de tool calling — cenários canônicos (model-agnostic).
//
// Cada cenário é um par (mensagem do usuário, tool disponível). O objetivo NÃO é
// resolver o problema de negócio — é forçar o modelo a tomar uma decisão observável
// sobre a tool: chamá-la com os argumentos certos, chamá-la errada, ou não chamar.
//
// Estes cenários são deliberadamente pequenos e baratos. O probe completo roda
// 5 cenários × {modo sem tools, modo com tools} × 3 turnos = 30 chamadas. Cada
// turno cabe em <300 tokens de saída, então o custo total fica na casa de poucos
// centavos por execução.
//
// Adicionar cenário novo:
//   1) Acrescentar um bloco abaixo com { id, description, userMessage, tools, expectedDecision }
//   2) Adicionar fixture correspondente em probe.test.js (para o classificador)
//   3) Atualizar CONTEXT.md / TOOL_CALLING_PROBE.md com o motivo pedagógico

import { toolSchemas } from './schemas.js';

// expectedDecision é uma pista humana para o relatório — não é um teste de
// aprovação. O classificador pode discordar; aí a frente decide o que fazer.
export const scenarios = [
  {
    id: 'math.simple_addition',
    description: 'Soma simples (12 + 7). Espera-se tool call com a=12, b=7.',
    userMessage: 'Quanto é 12 + 7? Use a ferramenta de calculadora se necessário.',
    tools: [toolSchemas.calculator],
    expectedDecision: 'tool_call',
    expectedArguments: { a: 12, b: 7, op: 'add' },
  },
  {
    id: 'math.simple_subtraction',
    description: 'Subtração (100 - 58). Espera-se tool call com op="subtract".',
    userMessage: 'Quanto é 100 menos 58?',
    tools: [toolSchemas.calculator],
    expectedDecision: 'tool_call',
    expectedArguments: { a: 100, b: 58, op: 'subtract' },
  },
  {
    id: 'file.find_known_path',
    description: 'Caminho concreto. Espera-se tool call com path="README.md".',
    userMessage: 'Abra o arquivo README.md do projeto.',
    tools: [toolSchemas.fileReader],
    expectedDecision: 'tool_call',
    expectedArguments: { path: 'README.md' },
  },
  {
    id: 'file.list_directory',
    description: 'Listagem ambígua. Espera-se tool call com path=".".',
    userMessage: 'Quais arquivos tem na raiz do projeto?',
    tools: [toolSchemas.fileLister],
    expectedDecision: 'tool_call',
    expectedArguments: { path: '.' },
  },
  {
    id: 'no_tool.acknowledge_only',
    description: 'Pergunta retórica. Espera-se resposta em texto puro, SEM tool call.',
    userMessage: 'Você consegue me ajudar com uma dúvida de programação?',
    tools: [toolSchemas.calculator, toolSchemas.fileReader],
    expectedDecision: 'no_tool',
    expectedArguments: null,
  },
];

export function getScenarioById(id) {
  return scenarios.find((s) => s.id === id);
}