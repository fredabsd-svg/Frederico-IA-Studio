// Sugestões inteligentes baseadas no contexto (seção 23). Lógica PURA: recebe um
// contexto observável (texto do usuário, arquivos alterados, tipo de ação…) e
// devolve sugestões relevantes NO MOMENTO CERTO — cada uma com gatilho, texto e
// severidade. Quem decide mostrar (respeitando o modo/nível) é o chamador.

const RULES = [
  {
    id: 'csv_next_step',
    test: (c) => c.files.some(f => /\.csv$/i.test(f)),
    suggestion: (c) => /finan|venda|receita|despesa|fluxo|2025/i.test(c.files.join(' '))
      ? 'Notei uma planilha CSV que parece conter dados financeiros. Quer um relatório executivo em PDF no padrão Tinta & Latão ou um dashboard de gráficos interativos no Modo Design?'
      : 'Notei uma planilha CSV. Posso primeiro auditar colunas e consistência e, depois, sugerir relatório, limpeza ou dashboard.',
    severity: 'info',
  },
  {
    id: 'pdf_docling',
    test: (c) => c.files.some(f => /\.pdf$/i.test(f)),
    suggestion: 'Você anexou um PDF. Se ele for escaneado ou tiver tabelas, posso usar o Docling/OCR para reduzir perdas na extração antes da análise.',
    severity: 'info',
  },
  {
    id: 'delegate_campaign',
    test: (c) => /campanha de marketing|lan[cç]amento de produto|plano de marketing/i.test(c.text),
    suggestion: 'Esta entrega se beneficia de delegação: pesquisa de público, redação das peças e uma auditoria final de consistência pelo Nino.',
    severity: 'info',
  },
  {
    id: 'backup_migration',
    test: (c) => /migration|migrate|alter table|schema/i.test(c.text) || (c.files || []).some(f => /migration/i.test(f)),
    suggestion: 'Esta ação envolve migração de banco. Recomendo fazer um backup/checkpoint antes de aplicar.',
    severity: 'aviso',
  },
  {
    id: 'commit_before_refactor',
    test: (c) => /refator|refactor|renomear tudo|mover.*arquivos/i.test(c.text) || (c.changedCount || 0) >= 8,
    suggestion: 'Antes de uma refatoração grande, crie um commit — facilita reverter se algo quebrar.',
    severity: 'info',
  },
  {
    id: 'security_review_auth',
    test: (c) => /auth|login|senha|password|token|permiss|jwt|oauth|sess[aã]o/i.test(c.text) || (c.files || []).some(f => /auth|login|permission/i.test(f)),
    suggestion: 'A alteração envolve autenticação/permissões. Recomendo uma verificação de segurança antes de publicar.',
    severity: 'aviso',
  },
  {
    id: 'cost_check_ai',
    test: (c) => /chamada.*(ia|modelo|api)|prompt|tokens|openai|anthropic|gemini/i.test(c.text) && /loop|todos|cada|em massa|batch|lote/i.test(c.text),
    suggestion: 'Mudança em chamadas de IA em lote pode elevar o custo. Verifique o consumo de tokens depois.',
    severity: 'info',
  },
  {
    id: 'optimize_long_prompt',
    test: (c) => (c.promptTokens || 0) > 1500,
    suggestion: 'Este prompt está longo (muitos tokens). Posso ajudar a resumir sem perder informação.',
    severity: 'info',
  },
  {
    id: 'split_big_task',
    test: (c) => (c.words || 0) > 250 || /e depois|e também|além disso|várias etapas|tudo isso/i.test(c.text),
    suggestion: 'A tarefa parece grande. Considere dividi-la em passos menores para melhor controle.',
    severity: 'info',
  },
  {
    id: 'tests_before_critical',
    test: (c) => /deploy|publicar|produ[çc][aã]o|release/i.test(c.text),
    suggestion: 'Antes de publicar, recomendo rodar os testes e uma verificação pré-deploy.',
    severity: 'aviso',
  },
  {
    id: 'rollback_before_update',
    test: (c) => /atualiza[r]? (depend|pacote|lib|vers[aã]o)|upgrade|bump/i.test(c.text),
    suggestion: 'Antes de atualizar dependências, tenha um ponto de rollback (commit/checkpoint) e a estratégia de reversão.',
    severity: 'info',
  },
];

// Normaliza o contexto e aplica as regras. Deduplica por id.
export function contextualSuggestions(ctx = {}) {
  const text = String(ctx.userText || ctx.text || '');
  const c = {
    text,
    words: text ? text.trim().split(/\s+/).filter(Boolean).length : 0,
    files: (Array.isArray(ctx.files) ? ctx.files : []).map(f => typeof f === 'string' ? f : String(f?.name || f?.path || '')),
    changedCount: Number(ctx.changedCount || (Array.isArray(ctx.files) ? ctx.files.length : 0)),
    promptTokens: Number(ctx.promptTokens || 0),
  };
  const out = [];
  const seen = new Set();
  for (const r of RULES) {
    try {
      if (r.test(c) && !seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, suggestion: typeof r.suggestion === 'function' ? r.suggestion(c) : r.suggestion, severity: r.severity }); }
    } catch { /* regra robusta: nunca derruba */ }
  }
  return out;
}
