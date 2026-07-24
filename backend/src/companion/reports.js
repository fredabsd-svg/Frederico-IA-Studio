// Relatórios de diagnóstico (seções 6 e 19): renderiza um incidente como
// Markdown/JSON e define o caminho organizado (projeto/ano/mês/dia/severidade).
// Lógica PURA (testável) — a escrita em disco fica na rota.

function two(n) { return String(n).padStart(2, '0'); }

// Caminho relativo organizado do relatório. `dateIso` vem do incidente (não usa
// relógio implícito, para ser determinístico e testável).
export function reportRelPath(incident = {}, dateIso = incident.createdAt) {
  const d = new Date(dateIso || 0);
  const y = Number.isNaN(d.getTime()) ? '0000' : d.getUTCFullYear();
  const mm = Number.isNaN(d.getTime()) ? '00' : two(d.getUTCMonth() + 1);
  const dd = Number.isNaN(d.getTime()) ? '00' : two(d.getUTCDate());
  const project = (incident.project || 'sem-projeto').replace(/[^a-zA-Z0-9._-]/g, '_');
  const sev = incident.severity || 'media';
  const kind = incident.kind || 'bug';
  const id = incident.id || 'incidente';
  return `relatorios/${project}/${y}/${mm}/${dd}/${sev}/${kind}_${id}.md`;
}

const section = (title, body) => (body ? `## ${title}\n\n${body}\n` : '');
const list = (arr) => (Array.isArray(arr) && arr.length ? arr.map(x => `- ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n') : '');

// Relatório em Markdown de um incidente (todos os campos da seção 6).
export function incidentReportMarkdown(incident = {}, { similar = [] } = {}) {
  const i = incident;
  const files = Array.isArray(i.relatedFiles) ? i.relatedFiles.map(f => (f.file ? `${f.file}${f.lines?.length ? `:${f.lines.join(',')}` : ''}` : String(f))) : [];
  const lines = [
    `# Diagnóstico — ${i.summary || 'Incidente'}`,
    '',
    `- **ID:** ${i.id || '-'}`,
    `- **Data:** ${i.createdAt || '-'}${i.lastSeen ? ` (última ocorrência: ${i.lastSeen})` : ''}`,
    `- **Projeto:** ${i.project || '-'}`,
    `- **Ambiente:** ${i.environment || '-'}`,
    `- **Serviço:** ${i.service || '-'}`,
    `- **Severidade:** ${i.severity || '-'}`,
    `- **Tipo:** ${i.kind || '-'}`,
    `- **Ocorrências:** ${i.occurrences ?? 1}`,
    `- **Status:** ${i.status || '-'}`,
    `- **Confiança da análise:** ${i.confidence != null ? i.confidence + '%' : '-'}`,
    i.commitRef ? `- **Commit:** ${i.commitRef}` : '',
    i.prRef ? `- **Pull request:** ${i.prRef}` : '',
    '',
    section('Resumo', i.summary),
    section('Mensagem original', i.errorMessage ? '```\n' + i.errorMessage + '\n```' : ''),
    section('Stack trace', i.stack ? '```\n' + i.stack + '\n```' : ''),
    section('Causa provável', i.probableCause),
    section('Arquivos relacionados', list(files)),
    section('Alterações recentes', list(i.recentChanges)),
    section('Sugestão de correção', i.suggestedFix),
    section('Comandos recomendados', Array.isArray(i.commands) && i.commands.length ? '```\n' + i.commands.join('\n') + '\n```' : ''),
    section('Evidências', i.evidence ? '```json\n' + JSON.stringify(i.evidence, null, 2) + '\n```' : ''),
    section('Solução aplicada', i.solution),
    section('Resultado', i.result),
    similar.length ? section('Ocorrências anteriores semelhantes', list(similar.map(s => `${s.createdAt} — ${s.summary}${s.solution ? ` (corrigido: ${s.solution})` : ''}`))) : '',
  ];
  return lines.filter(l => l !== '').join('\n');
}
