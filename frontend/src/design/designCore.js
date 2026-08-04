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

// Modelo que ESTE projeto usa. O do projeto manda; o do app é só o padrão dos
// projetos criados antes de o modelo passar a ser fixado (`modelRef` nulo).
// Espelha `modelForProject` do backend — se as duas divergirem, a tela mostra um
// modelo e a geração usa outro.
export function effectiveModel(project, appModel) {
  return String(project?.modelRef || appModel || '').trim();
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

// ---- Ponte com a prévia (v2) -----------------------------------------------

// Tipos de mensagem trocados com o iframe. O outro lado está em
// backend/src/design/bridge.js — as duas listas precisam bater, e um teste em
// cada ponta guarda isso. Divergir não dá erro: a seleção simplesmente para de
// funcionar, em silêncio.
export const PREVIEW_MESSAGES = {
  pronto: 'fred-preview-pronto',
  selecionado: 'fred-preview-selecionado',
  modo: 'fred-preview-modo',
  ajustes: 'fred-preview-ajustes',
  limparSelecao: 'fred-preview-limpar',
};

// Aceita uma mensagem vinda do iframe?
//
// A origem NÃO serve de checagem aqui: o documento da prévia roda em origem
// opaca (é o ponto do sandbox), então `event.origin` chega como "null" e
// compará-lo não prova nada. O que prova é a JANELA de onde veio — só o iframe
// que nós montamos tem esse `contentWindow`.
export function isPreviewMessage(event, frame) {
  if (!frame || !event || event.source !== frame.contentWindow) return false;
  const tipo = event.data && event.data.tipo;
  return typeof tipo === 'string' && Object.values(PREVIEW_MESSAGES).includes(tipo);
}

// Rótulo curto do elemento selecionado, para a etiqueta acima do compositor.
export function targetLabel(target) {
  if (!target) return '';
  if (target.slide) return `Slide ${target.slide}`;
  const texto = String(target.texto || '').trim();
  const tag = String(target.tag || 'elemento');
  if (!texto) return `<${tag}>`;
  return `<${tag}> ${texto.length > 42 ? `${texto.slice(0, 42)}…` : texto}`;
}

// Valor efetivo de um controle: o ajuste do usuário quando existe, senão o que
// o próprio design declara. É o que faz o slider abrir na posição certa em vez
// de saltar para um padrão nosso na primeira renderização.
export function tokenValue(token, adjustments) {
  const ajuste = adjustments ? adjustments[token.id] : undefined;
  return ajuste === undefined || ajuste === null || ajuste === '' ? token.defaultValue : ajuste;
}

// CSS de sobreposição para o ajuste AO VIVO, enquanto o usuário arrasta.
//
// É uma segunda implementação da que existe no backend (design/tokens.js), e a
// duplicação é intencional: o efeito precisa ser instantâneo, sem ida ao
// servidor. O backend continua sendo a autoridade — ele revalida tudo ao gravar
// e é ele quem monta a prévia e a exportação. O que sai daqui vive só no iframe.
export function liveOverrideCss(tokens, adjustments) {
  const linhas = [];
  for (const token of tokens || []) {
    const valor = tokenValue(token, adjustments);
    if (valor === undefined || valor === null || valor === '') continue;
    const css = token.kind === 'cor' ? valor : `${valor}${token.unit || ''}`;
    linhas.push(`  ${token.cssVar}: ${css} !important;`);
  }
  return linhas.length ? `:root{\n${linhas.join('\n')}\n}` : '';
}
