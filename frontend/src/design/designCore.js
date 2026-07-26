// Lógica pura do Modo Design na interface: metadados dos tipos de saída,
// formatos de exportação e formatação de datas. Fica fora dos componentes para
// poder ser testada com `node --test` (os .jsx não entram na suíte — só no
// build), e porque a lista de formatos precisa bater com a do backend.

export const DESIGN_OUTPUT_TYPES = [
  {
    id: 'web',
    label: 'Site ou protótipo',
    short: 'Site',
    desc: 'Uma página HTML completa, responsiva e navegável.',
    placeholder: 'Ex.: uma landing page para um escritório de contabilidade, com seção de serviços, depoimentos e formulário de contato.',
  },
  {
    id: 'slides',
    label: 'Apresentação',
    short: 'Slides',
    desc: 'Slides 16:9 com título, marcadores e notas do apresentador.',
    placeholder: 'Ex.: uma apresentação de 8 slides sobre a reforma tributária para clientes do comércio.',
  },
  {
    id: 'document',
    label: 'Documento visual',
    short: 'Documento',
    desc: 'Documento paginado em A4, com capa e tabelas estilizadas.',
    placeholder: 'Ex.: uma proposta comercial de 3 páginas com capa, escopo, prazos e tabela de honorários.',
  },
];

export function outputTypeMeta(id) {
  return DESIGN_OUTPUT_TYPES.find(t => t.id === id) || DESIGN_OUTPUT_TYPES[0];
}

// Espelha EXPORT_FORMATS do backend (design/core.js). Divergir aqui só produz
// um botão que baixa um erro — a rota recusa o formato que não é da lista.
const EXPORT_FORMATS = {
  web: [{ id: 'html', label: 'HTML' }],
  slides: [{ id: 'html', label: 'HTML' }, { id: 'pdf', label: 'PDF' }, { id: 'pptx', label: 'PowerPoint' }],
  document: [{ id: 'html', label: 'HTML' }, { id: 'pdf', label: 'PDF' }],
};

export function exportFormatsFor(outputType) {
  return EXPORT_FORMATS[outputType] || EXPORT_FORMATS.web;
}

// Data curta em pt-BR ("hoje 14:32", "12/03 09:10"). O histórico de versões
// costuma ter várias entradas no mesmo dia — a hora é o que diferencia.
export function formatWhen(iso, reference = new Date()) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const sameDay = date.toDateString() === reference.toDateString();
  if (sameDay) return `hoje ${time}`;
  return `${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

// Rótulo da versão na lista do histórico. A versão apontada como atual é a que
// o preview mostra — e não é necessariamente a mais recente (depois de
// reverter, a atual pode ser uma antiga).
export function versionLabel(version, currentVersionId) {
  const marker = version.id === currentVersionId ? ' · atual' : '';
  return `v${version.versionNumber}${marker}`;
}

// Nome do modelo para MOSTRAR. A referência interna tem a forma
// "<provedor>::<modelo>" (ver backend/src/modelRef.js) e o prefixo é um id
// aleatório — informação de banco, não de tela.
export function modelLabel(modelRef) {
  const value = String(modelRef || '').trim();
  if (!value) return '';
  const parts = value.split('::');
  return parts.length > 1 ? parts.slice(1).join('::') : value;
}

// Só faz sentido pedir uma geração com texto e sem outra em andamento.
export function canSubmit(prompt, busy) {
  return Boolean(String(prompt || '').trim()) && !busy;
}

// URL de download de uma exportação. `versionId` é opcional: sem ele o backend
// exporta a versão atual.
export function exportUrl(api, projectId, format, versionId = '') {
  const params = new URLSearchParams({ format });
  if (versionId) params.set('versionId', versionId);
  return `${api}/api/design/projects/${encodeURIComponent(projectId)}/export?${params}`;
}
