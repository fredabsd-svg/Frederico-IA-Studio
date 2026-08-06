// Schemas das tools usadas pelo probe. Formato OpenAI-compatible (function calling):
// cada tool tem { type: 'function', function: { name, description, parameters: JSON Schema } }.
//
// Mantemos só 3 tools no probe porque o objetivo não é cobrir todas as tools
// reais do projeto (que viram dezenas) — é medir se o modelo SEGUE instruções
// de tool calling em formato OpenAI quando apresentado a elas.
//
// As tools aqui são "didáticas": descrevem um problema concreto (calcular, ler
// arquivo, listar) e o modelo tem que decidir se usa ou não.

export const toolSchemas = {
  calculator: {
    type: 'function',
    function: {
      name: 'calculator',
      description:
        'Calcula uma operação aritmética entre dois números inteiros. Use quando o usuário pedir contas.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'integer', description: 'Primeiro operando.' },
          b: { type: 'integer', description: 'Segundo operando.' },
          op: {
            type: 'string',
            enum: ['add', 'subtract', 'multiply', 'divide'],
            description: 'Operação a executar.',
          },
        },
        required: ['a', 'b', 'op'],
        additionalProperties: false,
      },
    },
  },

  fileReader: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Lê o conteúdo de um arquivo a partir de um caminho relativo ao workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Caminho relativo do arquivo a ser lido.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },

  fileLister: {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'Lista os arquivos em um diretório (use "." para a raiz do workspace).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Diretório alvo; "." para raiz.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
};