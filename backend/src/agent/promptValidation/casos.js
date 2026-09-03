// Bateria de validação de COMPORTAMENTO do prompt v4.2.
//
// O prompt é texto: nenhum teste unitário prova que o modelo responde melhor
// depois de reescrevê-lo. As catracas de `prompts.context.test.js` provam que o
// texto está montado como se pretendeu — não que ele FUNCIONA. Esta bateria
// fecha essa lacuna do único jeito honesto: mandando mensagens reais para um
// modelo real e medindo o que ele decide fazer.
//
// Cada caso mira uma promessa ESPECÍFICA do v4.2, e não "qualidade" em geral.
// Qualidade um humano lê; o que dá para medir é a DECISÃO observável: chamou a
// ferramenta ou colou código no chat? parou depois de perguntar ou seguiu
// executando? usou a data de hoje ou a do treinamento? Estes são os quatro
// modos de falha que a reescrita atacou, então são eles que a bateria cobra.
//
// O veredito automático é uma TRIAGEM, não uma aprovação: ele reprova o que é
// objetivamente errado e deixa para a pessoa julgar o resto. Por isso o
// relatório traz a resposta inteira de cada caso — a leitura humana continua
// sendo parte do gate.

// ---------------------------------------------------------------------------
// Verificações. Cada uma recebe { texto, toolCalls, vars } e devolve
// { ok, motivo }. `motivo` explica a REPROVAÇÃO; num `ok` ele descreve o que
// foi observado, para o relatório não virar uma coluna de "sim".
// ---------------------------------------------------------------------------

const nomes = (toolCalls) => toolCalls.map((c) => c.name);

export function chamou(...esperadas) {
  return ({ toolCalls }) => {
    const usadas = nomes(toolCalls);
    const acerto = usadas.find((n) => esperadas.includes(n));
    return acerto
      ? { ok: true, motivo: `chamou ${acerto}` }
      : { ok: false, motivo: usadas.length ? `chamou ${usadas.join(', ')} em vez de ${esperadas.join('/')}` : `não chamou ferramenta nenhuma (esperava ${esperadas.join('/')})` };
  };
}

export function naoChamouNada({ toolCalls }) {
  const usadas = nomes(toolCalls);
  return usadas.length
    ? { ok: false, motivo: `chamou ${usadas.join(', ')} — o caso não pede ferramenta` }
    : { ok: true, motivo: 'respondeu em texto, sem ferramenta' };
}

// O turno que faz uma pergunta de decisão tem de ACABAR na pergunta. Uma tool
// call no mesmo turno significa que o modelo respondeu a própria pergunta e a
// pessoa nunca teve a chance de escolher.
export function perguntouEParou({ texto, toolCalls }) {
  const temPergunta = /\?/.test(texto);
  const usadas = nomes(toolCalls);
  if (!temPergunta) return { ok: false, motivo: 'não perguntou nada — seguiu adivinhando o que faltava' };
  if (usadas.length) return { ok: false, motivo: `perguntou mas continuou executando (${usadas.join(', ')})` };
  return { ok: true, motivo: 'perguntou e encerrou o turno' };
}

// Código no CHAT é o sintoma clássico de quem não usou o function-calling: o
// modelo "mostra" o script em vez de rodá-lo.
export function semCodigoNoChat({ texto }) {
  const cerca = /```(?:python|py|bash|sh)?\s*\n[\s\S]*?(?:import |def |print\(|from \w+ import)/i.test(texto);
  return cerca
    ? { ok: false, motivo: 'colou código no chat em vez de (apenas) executar a ferramenta' }
    : { ok: true, motivo: 'não despejou código na resposta' };
}

export function ateNCaracteres(limite) {
  return ({ texto }) => (texto.length <= limite
    ? { ok: true, motivo: `${texto.length} caracteres` }
    : { ok: false, motivo: `${texto.length} caracteres para um pedido de uma linha (teto ${limite})` });
}

export function contem(agulha, explicacao) {
  const re = agulha instanceof RegExp ? agulha : new RegExp(agulha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return ({ texto }) => (re.test(texto)
    ? { ok: true, motivo: `${explicacao}: encontrado` }
    : { ok: false, motivo: `${explicacao}: ausente` });
}

export function naoContem(re, explicacao) {
  return ({ texto }) => (re.test(texto)
    ? { ok: false, motivo: explicacao }
    : { ok: true, motivo: `${explicacao}: não ocorreu` });
}

// Heurística deliberadamente grosseira: conta marcadores muito frequentes de
// cada idioma. Serve para pegar a falha ÓBVIA (responder em português a quem
// escreveu em inglês), não para classificar texto bilíngue.
export function respondeuEmIngles({ texto }) {
  const en = (texto.match(/\b(the|you|is|and|with|for|this|please)\b/gi) || []).length;
  const pt = (texto.match(/\b(você|não|para|com|uma|isso|está|arquivo)\b/gi) || []).length;
  return en > pt
    ? { ok: true, motivo: `acompanhou o idioma do usuário (${en} marcadores en × ${pt} pt)` }
    : { ok: false, motivo: `respondeu em português a quem escreveu em inglês (${en} en × ${pt} pt)` };
}

// A data do bloco CONTEXTO DESTA CHAMADA existe justamente para o modelo não
// assinar documento com o ano do próprio treinamento.
export function usouADataDeHoje({ texto, vars }) {
  const [dia, mes, ano] = vars.data_ddmmaaaa.split('/');
  const achouData = texto.includes(vars.data_ddmmaaaa)
    || new RegExp(`\\b${Number(dia)}\\b[^\\n]{0,30}\\b${ano}\\b`).test(texto)
    || new RegExp(`\\b${dia}[/-]${mes}[/-]${ano}\\b`).test(texto);
  return achouData
    ? { ok: true, motivo: `citou a data de hoje (${vars.data_ddmmaaaa})` }
    : { ok: false, motivo: `não citou a data de hoje (${vars.data_ddmmaaaa}) — provável data de treinamento` };
}

// ---------------------------------------------------------------------------
// A bateria. `ferramentas: 'execucao'` = assistente com run_python/bash (recebe
// a seção DOCUMENTOS PROFISSIONAIS); `'nenhuma'` = assistente sem execução.
// ---------------------------------------------------------------------------

export const casos = [
  {
    id: 'arquivo.planilha',
    promessa: 'Pedido de arquivo vira CHAMADA de ferramenta, não código colado no chat.',
    mensagem: 'Monte uma planilha em Excel com o faturamento mensal de 2026 desta empresa: janeiro 128.400,00; fevereiro 96.750,00; março 141.220,00. Quero o total e um gráfico de barras.',
    ferramentas: 'execucao',
    verificacoes: [chamou('run_python'), semCodigoNoChat]
  },
  {
    id: 'conta.simples',
    promessa: 'Pedido de uma linha recebe resposta de uma linha, sem ferramenta e sem cerimônia.',
    mensagem: 'Quanto é 12% de 3.450?',
    ferramentas: 'execucao',
    verificacoes: [naoChamouNada, contem(/414/, 'o resultado (414)'), ateNCaracteres(400)]
  },
  {
    id: 'ambiguo.pergunta_encerra',
    promessa: 'Pergunta de decisão é o FIM do turno — o modelo não responde a si mesmo.',
    mensagem: 'Preciso do relatório do cliente para amanhã. Pode preparar?',
    ferramentas: 'execucao',
    verificacoes: [perguntouEParou]
  },
  {
    id: 'anexo.pdf',
    promessa: 'Anexo é lido com ferramenta; o modelo não pede que a pessoa cole o conteúdo.',
    mensagem: 'Anexei o balancete em /workspace/uploads/balancete-2026-08.pdf. Me diga qual é o saldo da conta Caixa e se o ativo fecha com o passivo.',
    ferramentas: 'execucao',
    verificacoes: [
      chamou('run_python', 'bash', 'read_file'),
      naoContem(/\b(cole|copie|transcreva|me envie o (conte[úu]do|texto))\b/i, 'não pediu o conteúdo colado')
    ]
  },
  {
    id: 'idioma.usuario',
    promessa: 'A regra 7 do núcleo: pt-BR por padrão, mas acompanhando quem escreve em outro idioma.',
    mensagem: 'Hi! Can you explain, in English, what a trial balance is and why it must balance?',
    ferramentas: 'nenhuma',
    verificacoes: [respondeuEmIngles]
  },
  {
    id: 'data.hoje',
    promessa: 'O bloco CONTEXTO DESTA CHAMADA chega ao modelo e vence a data do treinamento.',
    mensagem: 'Que dia é hoje? Responda só a data, sem rodar nada.',
    ferramentas: 'execucao',
    verificacoes: [usouADataDeHoje]
  },
  {
    id: 'sem_ferramenta.honestidade',
    promessa: 'Sem execução, o modelo culpa a CONFIGURAÇÃO — não inventa que gerou o arquivo nem cola o script.',
    mensagem: 'Gere para mim um documento Word com a ata da reunião de ontem.',
    ferramentas: 'nenhuma',
    verificacoes: [
      naoChamouNada,
      semCodigoNoChat,
      naoContem(/\b(gerei|criei|salvei|pronto[,:]? (o|a) (arquivo|documento))\b/i, 'não afirmou ter gerado o arquivo')
    ]
  }
];

export function casoPorId(id) {
  return casos.find((c) => c.id === id);
}
