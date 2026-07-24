// Assistente de criação/revisão de prompts (seção 4) — 100% LOCAL e eficiente:
// analisa o texto que o usuário está digitando ANTES de enviar à IA, sem gastar
// tokens. Detecta problemas de clareza/estrutura, estima tokens e oferece
// transformações. Nunca altera o texto sozinho — só sugere (o usuário aceita).

// Estimativa de tokens (mesma heurística ~4 chars/token do backend).
export function estimatePromptTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  return Math.max(Math.ceil(s.length / 4), Math.ceil(s.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

const AMBIGUOUS = /\b(isso|aquilo|coisa|algo|etc|de alguma forma|talvez|mais ou menos|melhor(?:ar)? um pouco|arruma[r]?|conserta[r]?)\b/i;
const HAS_FORMAT = /\b(formato|json|tabela|lista|markdown|csv|bullet|c[oó]digo|em portugu[eê]s|responda com|retorne|sa[ií]da)\b/i;
const HAS_CONTEXT = /\b(contexto|projeto|arquivo|no c[oó]digo|considerando|dado que|a partir de|abaixo|acima|segue)\b/i;
const HAS_OBJECTIVE = /\b(quero|preciso|fa[çc]a|gere|crie|analise|explique|corrija|implemente|escreva|liste|compare|resuma|revise)\b/i;
const HAS_RULES = /\b(regra|restri[çc][aã]o|n[aã]o (?:use|fa[çc]a|inclua)|deve|precisa|obrigat[oó]rio|evite|somente|apenas)\b/i;

// Analisa o rascunho e devolve issues + estrutura + score + tokens.
export function analyzePrompt(text) {
  const t = String(text || '').trim();
  const words = t ? t.split(/\s+/).filter(Boolean).length : 0;
  const structure = {
    hasContext: HAS_CONTEXT.test(t),
    hasObjective: HAS_OBJECTIVE.test(t),
    hasRules: HAS_RULES.test(t),
    hasFormat: HAS_FORMAT.test(t),
  };
  const issues = [];
  if (words > 0 && words < 6) issues.push({ kind: 'curto', label: 'Prompt muito curto', hint: 'Dê mais detalhes: o que, para quê e em que contexto.' });
  if (!structure.hasObjective && words >= 3) issues.push({ kind: 'sem_objetivo', label: 'Objetivo pouco claro', hint: 'Comece com um verbo de ação (crie, analise, corrija…).' });
  if (!structure.hasContext && words >= 12) issues.push({ kind: 'sem_contexto', label: 'Falta contexto', hint: 'Inclua o projeto, arquivos ou dados relevantes.' });
  if (!structure.hasFormat && words >= 12) issues.push({ kind: 'sem_formato', label: 'Formato de saída não especificado', hint: 'Diga como quer a resposta (tabela, JSON, passos…).' });
  if (AMBIGUOUS.test(t)) issues.push({ kind: 'ambiguo', label: 'Termos ambíguos', hint: 'Troque "isso/algo/melhorar um pouco" por termos concretos.' });
  if (words > 400) issues.push({ kind: 'longo', label: 'Prompt muito longo', hint: 'Considere resumir ou dividir — economiza tokens e melhora o foco.' });
  if (!structure.hasRules && words >= 25) issues.push({ kind: 'sem_criterios', label: 'Sem critérios de qualidade', hint: 'Adicione regras/critérios de validação da resposta.' });

  // Score simples 0..100 (quanto mais estrutura e menos problemas, melhor).
  const structPoints = Object.values(structure).filter(Boolean).length * 15; // 0..60
  const penalty = Math.min(60, issues.length * 12);
  const score = Math.max(0, Math.min(100, 40 + structPoints - penalty));

  return { words, tokens: estimatePromptTokens(t), structure, issues, score };
}

// Transformações rápidas (seção 4). Cada uma monta um META-PROMPT que instrui a
// IA a reescrever o texto do usuário PRESERVANDO a intenção — a reescrita é feita
// pelo modelo escolhido; aqui só produzimos a instrução (local).
export const PROMPT_ACTIONS = [
  { id: 'revisar', label: 'Revisar prompt', instr: 'Revise o prompt abaixo: corrija escrita, melhore clareza e estrutura, remova ambiguidades e contradições, preservando a intenção original. Devolva apenas o prompt revisado.' },
  { id: 'raciocinio', label: 'Melhorar raciocínio', instr: 'Reescreva o prompt abaixo para induzir um raciocínio passo a passo e critérios de verificação, sem mudar o objetivo. Devolva apenas o prompt.' },
  { id: 'tecnico', label: 'Tornar mais técnico', instr: 'Reescreva o prompt abaixo com terminologia técnica precisa e requisitos explícitos, preservando a intenção. Devolva apenas o prompt.' },
  { id: 'objetivo', label: 'Tornar mais objetivo', instr: 'Reescreva o prompt abaixo de forma mais objetiva e enxuta, sem perder informação essencial. Devolva apenas o prompt.' },
  { id: 'criterios', label: 'Adicionar critérios de qualidade', instr: 'Reescreva o prompt abaixo adicionando critérios claros de qualidade e validação da resposta. Devolva apenas o prompt.' },
  { id: 'estruturar', label: 'Separar contexto/objetivo/regras/formato', instr: 'Reestruture o prompt abaixo em seções claras: Contexto, Objetivo, Regras e Formato de saída, preservando a intenção. Devolva apenas o prompt.' },
  { id: 'codex', label: 'Criar prompt para Codex', instr: 'Transforme o pedido abaixo num prompt de engenharia para um agente de código (Codex/Claude Code): contexto do projeto, objetivo, restrições, arquivos afetados, critérios de aceite e formato de saída. Devolva apenas o prompt.' },
  { id: 'analise_codigo', label: 'Criar prompt para análise de código', instr: 'Transforme o pedido abaixo num prompt de análise de código: o que revisar (bugs, segurança, performance, legibilidade), evidências exigidas e formato do relatório. Devolva apenas o prompt.' },
  { id: 'documentos', label: 'Criar prompt para documentos', instr: 'Transforme o pedido abaixo num prompt para gerar um documento (estrutura, seções, tom, formato de saída). Devolva apenas o prompt.' },
  { id: 'multi', label: 'Criar prompt para múltiplos modelos', instr: 'Transforme o pedido abaixo num prompt adequado a comparação multi-modelo: tarefa clara, critérios de avaliação e formato para consolidar respostas. Devolva apenas o prompt.' },
];

// Monta a mensagem que será enviada à IA para aplicar uma transformação.
export function buildCoachMessage(actionId, userText) {
  const action = PROMPT_ACTIONS.find(a => a.id === actionId);
  if (!action) return null;
  return `${action.instr}\n\n---\nPROMPT DO USUÁRIO:\n${String(userText || '').trim()}`;
}
