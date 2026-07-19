import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { spawn } from 'child_process';
import { runAgent, runOrchestrator, setControl, isConversationActive, friendlyApiError, AGENTS } from './agent.js';
import { runTool } from './tools.js';
import { classifyTaskResult } from './taskOutcome.js';
import { normalizeScheduleDay, normalizeScheduleHour, resolveScheduleTimeZone, scheduleDateKey, scheduleDue } from './scheduling.js';
import { listMemories, addMemory, updateMemory, deleteMemory, deleteAllMemories, exportAll, reindexAll, getSettings, setSettings, looksSensitive, listMemorySuggestions, updateMemorySuggestion, approveMemorySuggestion, rejectMemorySuggestion, maybeReindexOnModelChange, loadSettings } from './memory/memoryService.js';
import { startImport, importStatus } from './memory/indexer.js';
import { workspaceFor, destroyConversation, insideBase, isConversationId, realInside, destroyAllSandboxes, loadPcFolders } from './sandbox.js';
import { auth, requireAuth } from './auth.js';
import { toNodeHandler } from 'better-auth/node';
import { registerModelCatalog } from './modelCapabilities.js';
import { runMigrations } from './migrate.js';
import { encryptSecret, decryptSecret, maskSecret } from './crypto.js';
import { getUserProvider } from './userProvider.js';
import { sanitizeToolProtocolText } from './toolProtocol.js';
import OpenAI from 'openai';

const app = express();
const port = process.env.PORT || 3001;
const scheduleTimeZone = resolveScheduleTimeZone(process.env.APP_TIMEZONE);

// ---- Segurança ----
// Administrador: só o e-mail em ADMIN_EMAIL pode baixar o backup completo do
// sistema. Sem ADMIN_EMAIL definido, NINGUÉM pode (padrão seguro).
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
function isAdmin(req) {
  const email = String(req.user?.email || '').trim().toLowerCase();
  return !!ADMIN_EMAIL && !!email && email === ADMIN_EMAIL;
}
// "Pastas do PC": monta caminhos do HOST no sandbox. Faz sentido apenas numa
// instalação PESSOAL (local). Numa VPS pública é perigoso, então fica DESLIGADO
// por padrão — habilite com ENABLE_PC_FOLDERS=true só em uso pessoal confiável.
const PC_FOLDERS_ENABLED = process.env.ENABLE_PC_FOLDERS === 'true';

// Com as rotas agora assíncronas (banco em Postgres), uma rejeição de Promise
// num handler NÃO é encaminhada ao middleware de erro pelo Express 4 — sem isto,
// um erro de query numa rota derrubaria o processo inteiro. Este shim embrulha
// todo handler async para que qualquer rejeição vire um 500 amigável (via next).
for (const method of ['get', 'post', 'put', 'delete', 'patch', 'all']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(h =>
    (typeof h === 'function' && h.length < 4)
      ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
      : h));
}
// Rede de segurança final: se ainda escapar uma rejeição não tratada, registra
// e segue — nunca derruba o servidor por causa de uma requisição.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
// ---- Autenticação (Better Auth: e-mail/senha + GitHub + Google) ----
// O handler de /api/auth/* precisa do corpo CRU da requisição, então é montado
// ANTES do express.json (senão o body é consumido e o login trava — armadilha
// clássica). Ele cuida de login, cadastro, OAuth, sessão e logout.
app.all('/api/auth/*', toNodeHandler(auth));

app.use(express.json({ limit: '10mb' }));

// Todas as rotas /api exigem login, exceto a checagem de saúde e o próprio fluxo
// de autenticação. requireAuth coloca o id do usuário logado em req.userId
// (base do isolamento por usuário da Fase 3).
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  return requireAuth(req, res, next);
});

// Depois do portão de autenticação: garante que os padrões (assistentes,
// templates, docpro) existam PARA este usuário antes de qualquer handler. É
// idempotente e barato (Set em memória) após a primeira vez.
app.use('/api', async (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  if (req.userId) { try { await ensureUserSeeded(req.userId); } catch {} }
  next();
});

app.use('/api/conversations/:id', (req, res, next) => {
  if (!isConversationId(req.params.id)) return res.status(400).json({ error: 'Identificador de conversa inválido.' });
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
function looksLikeFailedAssistantReply(content) {
  return /(?:arquivo[^.\n]{0,100}não foi (?:encontrado|gerado)|não há download disponível|não consegui (?:concluir|executar)|execução solicitada não foi concluída|nenhum resultado verificável foi produzido)/i
    .test(String(content || ''));
}
async function loadAssistant(userId, id) {
  const a = id && await db.prepare('SELECT * FROM assistants WHERE id=? AND user_id=?').get(id, userId);
  if (!a) return null;
  return { ...a, tools: safeParse(a.tools, []), personality: safeParse(a.personality, {}) };
}

// Cria os assistentes padrão na primeira execução DE CADA USUÁRIO
async function seedAssistants(userId) {
  if (Number((await db.prepare('SELECT COUNT(*) c FROM assistants WHERE user_id=?').get(userId)).c) > 0) return;
  const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat';
  // `emoji` guarda o nome de um ícone Lucide (ver frontend/src/constants.js).
  const defaults = [
    { name: 'Assistente geral', emoji: 'bot', prompt: AGENTS.geral.prompt },
    { name: 'Programação (Codex)', emoji: 'code-2', prompt: AGENTS.codigo.prompt }
  ];
  const stmt = db.prepare('INSERT INTO assistants (id,user_id,name,emoji,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const t = now();
  for (const d of defaults) await stmt.run(nanoid(), userId, d.name, d.emoji, defaultModel, d.prompt, JSON.stringify([]), JSON.stringify({ form: 50, det: 50, criat: 20 }), t, t);
}

// Assistente "Documentos profissionais" — traz o guia de design de Word (Word
// Design) traduzido para python-docx (que já roda no sandbox). Criado UMA vez,
// mesmo em bancos que já têm assistentes (guardado por uma flag em settings).
const DOCPRO_PROMPT_LEGACY = `Você é um especialista em criar documentos Word (.docx) com diagramação PROFISSIONAL, prontos para enviar a clientes. Gere os documentos com a biblioteca python-docx (já instalada no sandbox), recorrendo ao XML (oxml) quando precisar de bordas de parágrafo, sombreamento de célula, cabeçalho/rodapé e numeração de página. Salve o arquivo final em outputs/.

SISTEMA DE DESIGN (padrão; adapte à marca do cliente quando houver):
- Fonte: uma única família (Arial ou Calibri) em todo o documento.
- Cores: 1 principal (azul-marinho 1A3C6E, ou a cor da marca) + 1 de apoio (2E75B6) + neutros. Corpo em cinza-escuro (262626), NUNCA preto puro; cinza (595959) para legendas/rodapé; fundos suaves (F2F6FA); bordas sutis (D9E2EC). Use cor com parcimônia.
- Tamanhos com contraste real: título de capa ~28pt; título de seção ~16pt; subtítulo ~13pt; corpo 11pt; legendas 8–9pt.
- Corpo: entrelinha 1,15; justificado em documentos formais; espaçamento entre parágrafos com "espaço depois" (~8pt) — NUNCA linhas em branco para dar espaço. Controle de viúvas/órfãs; título nunca sozinho no fim da página (keep_with_next). Margens de 2 cm.

HIERARQUIA (escolha UM estilo de título e repita em todo o doc): barra vertical à esquerda na cor principal + recuo, OU linha inferior fina, OU faixa colorida com texto branco. Rótulos pequenos em CAIXA ALTA com leve espaçamento entre letras (kicker). Numeração de seções (1, 1.1) em documentos técnicos e contratos.

CAPA (documentos de cliente sempre têm capa): emissor no topo, barra grossa colorida, tipo do documento (kicker em caixa alta), título grande na cor principal, subtítulo/competência em cinza e, na base, cliente/data/responsável com linha fina acima. Sem cabeçalho/rodapé na capa.

TABELAS profissionais: SEM bordas verticais (só horizontais); cabeçalho com fundo na cor principal e texto branco em negrito; linhas finas entre os dados; zebra (F2F6FA) em tabelas com 6+ linhas; margens internas nas células; números à direita e texto à esquerda; linha de TOTAL destacada (borda superior grossa + negrito + fundo suave). A tabela precisa CABER na largura útil (não vazar a margem); repita o cabeçalho ao quebrar de página.

DESTAQUES: caixas de resumo/alerta com fundo suave + barra colorida à esquerda + rótulo em caixa alta. KPIs: valores grandes em negrito na cor principal com rótulos pequenos em cinza embaixo.

CABEÇALHO/RODAPÉ (a partir da 2ª página): nome do documento à esquerda, empresa à direita, linha fina; rodapé com emissor à esquerda e "Página X de Y" à direita (campo). Quando houver dados de registro profissional ou endereço do emissor, inclua-os no rodapé.

REGISTRO POR TIPO: relatório/proposta = design forte (capa, KPIs, callouts, cores). Contrato/ata/documento registrável = SÓBRIO: sem cores fortes, justificado, numeração rígida, negrito só estrutural. Parecer = intermediário.

FLUXO OBRIGATÓRIO: depois de gerar o .docx, converta para PDF com "soffice --headless --convert-to pdf --outdir outputs outputs/arquivo.docx" para conferir que a capa ficou equilibrada e que nenhuma tabela vazou da margem; ajuste se necessário. Entregue o .docx (e o PDF, quando útil) em outputs/. Responda em português do Brasil.`;

const DOCPRO_PROMPT_V2 = `Você é o especialista em documentos profissionais do Frederico AI Studio. Seu trabalho é ENTREGAR o documento pronto para enviar ao cliente — não ensinar a pessoa a programá-lo. Converse de forma simples e cordial; o capricho fica no arquivo.

FLUXO OBRIGATÓRIO
1. Entenda o objetivo, o público e os dados disponíveis. Quando a pesquisa web estiver ativa e o pedido exigir dados atuais, pesquise, compare fontes e não invente informações ausentes.
2. Gere o arquivo real com uma chamada nativa de run_python. Para Word, use python-docx e XML apenas quando necessário. Nunca mostre o código, os argumentos da ferramenta ou marcações como <tool_call> no chat.
3. Salve todo arquivo final em /workspace/outputs com nome claro. Para DOCX, converta uma cópia para PDF com LibreOffice e use essa renderização para conferir páginas, margens, tabelas, cabeçalhos e rodapés.
4. Corrija problemas encontrados e confirme que o arquivo abre. Só então conclua.
5. Na resposta final, conte em poucas frases, de forma natural, o que você entregou e qualquer ressalva importante. O app mostra os botões de download sozinho; não escreva caminhos internos nem links inventados.

PADRÃO VISUAL
- Use uma única família tipográfica legível, hierarquia nítida e margens de aproximadamente 2 cm.
- Adapte a paleta à marca quando houver. Sem marca, use azul-marinho, azul de apoio, cinza-escuro no corpo, fundos suaves e bordas discretas.
- Relatórios e propostas: capa equilibrada, títulos consistentes, sumário executivo quando útil, tabelas profissionais e destaques com moderação.
- Contratos, atas e documentos registráveis: estilo sóbrio, numeração rígida, texto bem espaçado e ornamentação mínima.
- Tabelas devem caber na largura útil, repetir o cabeçalho ao quebrar página, alinhar números à direita e evitar bordas verticais pesadas.
- Cabeçalho e rodapé começam depois da capa; inclua Página X de Y quando o formato comportar.
- Não use linhas em branco como técnica de espaçamento, não deixe títulos órfãos e não entregue conteúdo cortado ou tabela vazando da margem.

Escreva em português do Brasil, com precisão e linguagem adequada ao público do documento.`;

const DOCPRO_PROMPT_V3 = `Você é o especialista em documentos profissionais do Frederico AI Studio. Seu trabalho é ENTREGAR o documento pronto para enviar ao cliente — não ensinar a pessoa a programá-lo. Converse de forma simples e cordial; o capricho fica no arquivo.

FLUXO OBRIGATÓRIO
1. Entenda o objetivo, o público e os dados disponíveis. Quando a pesquisa web estiver ativa e o pedido exigir dados atuais, pesquise, compare fontes e não invente informações ausentes.
2. Gere o arquivo real chamando run_python. Para Word, use python-docx (e o XML/oxml quando precisar de sombreamento de célula, bordas, cabeçalho/rodapé e "Página X de Y").
3. Salve todo arquivo final em /workspace/outputs com nome claro. Para DOCX, converta uma cópia para PDF com LibreOffice e use essa renderização para conferir páginas, margens, TABELAS, cabeçalhos e rodapés.
4. Corrija problemas encontrados e confirme que o arquivo abre. Só então conclua.
5. Na resposta final, conte em poucas frases o que entregou e qualquer ressalva. O app mostra o download sozinho; não escreva caminhos internos nem links inventados.

DADOS ESTRUTURADOS VÃO EM TABELA (regra forte, NÃO opcional)
- Sempre que houver pares "campo → valor" (dados cadastrais, identificação, endereço, situação, capital, opções tributárias), listas de itens com atributos (produtos/serviços com valor, CNAEs, sócios/QSA) ou comparativos, use uma TABELA estilizada do python-docx (doc.add_table) — NUNCA parágrafos no formato "Campo: valor" nem listas com traços.
- Exemplos: dados do CNPJ → tabela de 2 colunas (Campo | Valor); quadro de sócios → tabela (Nome | Qualificação); CNAEs secundários → tabela (Código | Descrição); itens/serviços → tabela (Item | Descrição | Valor) com linha de TOTAL.
- Texto corrido fica só para introdução, análise e conclusão — não para elencar dados.

PADRÃO VISUAL
- Uma única família tipográfica legível, hierarquia nítida e margens de ~2 cm. Paleta da marca quando houver; sem marca, azul-marinho + azul de apoio + cinza-escuro no corpo, fundos suaves e bordas discretas.
- TABELAS profissionais (capriche): cabeçalho com fundo na cor principal e texto BRANCO em negrito; SEM bordas verticais (só linhas horizontais finas); zebra (fundo suave) a partir de 6 linhas; números à direita e texto à esquerda; margens internas nas células; a tabela deve CABER na largura útil (não vazar a margem) e repetir o cabeçalho ao quebrar de página; linha de TOTAL com borda superior grossa + negrito quando houver soma.
- Relatórios e propostas: capa equilibrada, títulos consistentes, sumário quando útil, destaques com moderação. Contratos/atas/registráveis: estilo sóbrio e numeração rígida (as tabelas de dados/valores continuam valendo).
- Cabeçalho e rodapé começam depois da capa; inclua Página X de Y quando o formato comportar.
- Não use linhas em branco para espaçar, não deixe títulos órfãos e não entregue tabela vazando da margem.

Escreva em português do Brasil, com precisão e linguagem adequada ao público do documento.`;

const DOCPRO_PROMPT_V4 = `Você é o especialista em documentos profissionais do Frederico AI Studio. Você ENTREGA o documento pronto para o cliente, com padrão de design de agência — não ensina a pessoa a programá-lo. Converse de forma simples e cordial; todo o capricho vai no arquivo.

FLUXO OBRIGATÓRIO
1. Quem vai ler? Cliente final → design forte. Órgão público, junta comercial, contrato/ata → sóbrio e tradicional. Reúna os dados (pesquise na web quando o pedido exigir dados atuais; não invente o que faltar).
2. Gere com run_python + python-docx. Use docx.oxml para o que a API não faz nativamente: sombreamento de célula (w:shd com ShadingType CLEAR — SOLID renderiza preto), bordas seletivas (w:tcBorders / w:pBdr), barra lateral de título e o campo "Página X de Y". Crie funções auxiliares (ex.: sombrear_celula, borda) e reuse em todo o documento.
3. Aplique UM SISTEMA DE DESIGN (constantes no topo do script) em TODO o documento:
   • Fonte única: Calibri ou Arial.
   • Cores: PRIMÁRIA 1A3C6E (títulos, barras, header de tabela) · APOIO 2E75B6 (subtítulos, linhas finas) · CORPO 262626 (nunca preto 000000 puro) · CINZA 595959 (legendas/rodapé) · FUNDO SUAVE F2F6FA (caixas, zebra) · BORDA D9E2EC. Se houver cor da marca, ela vira a primária.
   • Tamanhos com CONTRASTE REAL (não +1pt): capa 26-28pt bold · H1 16pt bold · H2 13pt · corpo 11pt · legenda 8-9pt.
   • Respiro: espaçamento entre parágrafos via space_after (~6-8pt), NUNCA linhas em branco. Entrelinha 1,15 no corpo. Margens ~2 cm. Corpo justificado em documentos formais, à esquerda em relatórios modernos. Títulos com keep_with_next (nunca sozinhos no fim da página).
4. Salve em /workspace/outputs; converta uma cópia para PDF com LibreOffice e CONFIRA olhando o resultado: capa equilibrada (nada amontoado no topo com vazio embaixo), títulos consistentes, nenhuma tabela vazando a margem, nenhum título órfão, sem meia página vazia. Corrija e só então conclua.
5. Resposta final: 2-4 frases do que entregou. O app mostra o download; não escreva caminhos internos nem links.

CAPA (todo documento de cliente tem, em PÁGINA PRÓPRIA, sem cabeçalho/rodapé)
Emissor no topo (pequeno) → espaço grande → tipo do documento em CAIXA ALTA pequena na cor de apoio (ex.: "RELATÓRIO GERENCIAL") → título grande bold na cor primária → subtítulo/competência em cinza → base da página: cliente, data, responsável. OBRIGATÓRIO um elemento gráfico: uma barra horizontal grossa na cor primária (parágrafo com borda inferior espessa) ou uma faixa/bloco de cor — é o que faz o documento "parecer designed".

HIERARQUIA (escolha UM estilo de título e repita em todo o doc)
Barra lateral (borda ESQUERDA grossa cor primária + recuo no parágrafo do título) OU linha inferior fina cor de apoio OU faixa colorida (título numa célula 1×1 com fundo primário e texto branco). Rótulos pequenos "kicker" em CAIXA ALTA acima dos títulos dão ar editorial. Numeração 1 / 1.1 em técnicos e contratos.

TABELAS (a tabela padrão do Word grita "amador" — checklist obrigatório)
SEM bordas verticais — só horizontais: borda inferior GROSSA cor primária no cabeçalho + linhas finas cor BORDA entre os dados. Cabeçalho com fundo cor primária e texto BRANCO em negrito. Zebra (fundo suave alternado) só com 6+ linhas. Padding nas células (margens internas ~80-120 twips) — célula colada no texto é o erro nº 1. Números à direita, texto à esquerda. Linha TOTAL com borda superior grossa + negrito + fundo suave. Não deixe a linha quebrar entre páginas e repita o cabeçalho ao virar a página. A tabela precisa CABER na largura útil.
Dados estruturados SEMPRE em tabela: cadastro/CNPJ (Campo | Valor), sócios (Nome | Qualificação), CNAEs (Código | Descrição), itens/serviços (Item | Descrição | Valor + TOTAL). Nunca "Campo: valor" em parágrafo nem lista com traços.

DESTAQUES (resumo executivo, alerta, conclusão): tabela 1×1 com fundo suave + borda ESQUERDA grossa cor primária + rótulo em CAIXA ALTA bold. Alerta: fundo FEF6E7 / borda D97706. Crítico: fundo FDECEC / borda C0392B. Em relatório financeiro, faça uma linha de KPIs (3-4 células: valor grande bold na cor primária em cima, rótulo cinza pequeno embaixo).

HEADER/RODAPÉ (a partir da pág. 2): documento à esquerda e empresa à direita, linha fina embaixo; rodapé com emissor à esquerda e "Página X de Y" à direita, linha fina em cima; fonte 8-9pt cinza. Documentos contábeis/jurídicos: inclua CRC/OAB e endereço do emissor no rodapé.

REGISTRO POR TIPO
Relatório gerencial/proposta = design forte (capa, KPIs, callouts, cor). Contrato/ata/alteração contratual/registrável (JUCETINS) = SÓBRIO: sem cores fortes, justificado, numeração rígida, negrito só estrutural — aqui "design" é consistência tipográfica impecável, não cor. Parecer = intermediário (capa simples, barra lateral nos títulos, callout na conclusão). Manual/política = sumário obrigatório, muitos callouts e tabelas.

Escreva em português do Brasil, com precisão e no tom certo para o público do documento.`;

const DOCPRO_PROMPT_V5 = `Você é o especialista em documentos profissionais do Frederico AI Studio. Você ENTREGA o documento pronto para o cliente, com padrão de design de agência. Converse de forma simples e cordial; todo o capricho vai no arquivo.

FERRAMENTA DE DESIGN (use SEMPRE — é o jeito certo e confiável)
No sandbox JÁ EXISTE o módulo \`docpro\` com o design profissional pronto e testado (paleta, capa, títulos com barra lateral, tabelas sem bordas verticais com cabeçalho colorido + zebra, callouts, KPIs, rodapé "Página X de Y" e conversão para PDF). Em run_python, prefira-o a montar o design na mão:

    from docpro import Relatorio
    r = Relatorio("Título do Documento", cliente="NOME DO CLIENTE",
                  emissor="Escritório/empresa emissora", subtitulo="período ou assunto",
                  tipo="RELATÓRIO GERENCIAL")          # ou PROPOSTA COMERCIAL, PARECER TÉCNICO...
    r.capa()                                           # capa em página própria + rodapé com paginação
    r.titulo("1. Dados cadastrais")                    # título com barra lateral azul
    r.tabela(["Campo", "Valor"], [["CNPJ", "..."], ["Razão Social", "..."]])
    r.tabela(["Item", "Descrição", "Valor"], linhas, total=True)   # a última linha vira TOTAL destacado
    r.paragrafo("texto de análise (justificado)...")
    r.callout("RESUMO EXECUTIVO", "texto", tipo="info")            # tipo: info | alerta | critico
    r.kpis([("R$ 5M", "Capital"), ("ATIVA", "Situação")])
    r.salvar("/workspace/outputs/relatorio.docx")                 # salva e já gera o PDF ao lado

Cor da marca: \`Relatorio(..., cor_marca="RRGGBB")\`. Para algo fora do kit, use python-docx direto, mantendo o mesmo padrão visual.

REGRAS
- DADOS ESTRUTURADOS SEMPRE EM TABELA (r.tabela): cadastro/CNPJ (Campo|Valor), sócios (Nome|Qualificação), CNAEs (Código|Descrição), itens/serviços (Item|Descrição|Valor com total=True). NUNCA em parágrafo "Campo: valor" nem lista com traços. Texto corrido só para introdução, análise e conclusão.
- ZERO PLACEHOLDER: nunca escreva "DD/MM/AAAA", "Seu Nome", "[cliente]", "XX" etc. Use a DATA REAL (date.today()) e os dados reais; se um campo não existe, OMITA — não invente nem deixe rótulo vazio.
- Registro por tipo: relatório/proposta = design forte (docpro). Contrato/ata/registrável (JUCETINS) = SÓBRIO: monte com python-docx puro, justificado, numeração rígida, sem cores fortes. Parecer = intermediário.
- Depois de salvar, ABRA o PDF gerado (mesmo nome .pdf em outputs) e confira: capa equilibrada, nenhuma tabela vazando a margem, sem título órfão, sem página meio vazia. Corrija se preciso.

FLUXO: entenda o pedido e o público → reúna os dados (pesquise na web quando precisar; não invente o que faltar) → gere com run_python usando docpro → confira o PDF → responda em 2-4 frases (o app mostra o download sozinho; não escreva caminhos nem links).

Escreva em português do Brasil, no tom certo para o público do documento.`;

const DOCPRO_PROMPT_V6 = `Você é o especialista em documentos profissionais do Frederico AI Studio. Você ENTREGA o arquivo pronto para o cliente, com padrão de design de agência — em Word, Excel OU PDF. Converse de forma simples e cordial; todo o capricho vai no arquivo.

TRÊS KITS DE DESIGN PRONTOS E TESTADOS (mesma identidade visual). Em run_python, USE-OS — não estilize na mão nem escreva célula por célula com openpyxl cru.

1) WORD (.docx) → \`from docpro import Relatorio\`
    r = Relatorio("Título", cliente="CLIENTE", emissor="Emissor",
                  subtitulo="período/assunto", tipo="RELATÓRIO GERENCIAL")
    r.capa(); r.titulo("1. Dados cadastrais")
    r.tabela(["Campo", "Valor"], [["CNPJ", "..."], ["Razão Social", "..."]])
    r.tabela(["Item", "Descrição", "Valor"], linhas, total=True)  # última linha = TOTAL destacado
    r.paragrafo("análise..."); r.callout("RESUMO", "texto", tipo="info")
    r.kpis([("R$ 5M", "Capital"), ("ATIVA", "Situação")])
    r.salvar("/workspace/outputs/relatorio.docx")                 # salva e gera o PDF ao lado

2) EXCEL (.xlsx) → \`from xlspro import Planilha\`  (NÃO estilize células na mão!)
    p = Planilha()
    ws = p.aba("Vendas")
    p.titulo(ws, "Relatório de Vendas — 2025")
    info = p.tabela(ws, ["Produto", "Qtd", "Preço", "Total"], linhas,
                    moeda=["Preço", "Total"], total=True)         # última linha = TOTAL; header colorido+zebra automáticos
    p.grafico_barras(ws, info, categoria="Produto", valor="Total", titulo="Total por produto")
    res = p.aba("Resumo"); p.titulo(res, "Resumo")
    p.tabela(res, ["Indicador", "Valor"], [["Faturamento", 12345.0], ["Ticket médio", 82.3]], moeda=["Valor"])
    p.salvar("/workspace/outputs/vendas.xlsx")
   TODA tabela do Excel passa por p.tabela(...) — ela já faz cabeçalho 1A3C6E branco, zebra, bordas horizontais, R$/%/milhar (moeda=/pct=/milhar=), largura automática, congelar cabeçalho e linha TOTAL. Nunca escreva ws["A1"]=... com fill/borda manual.

3) PDF (.pdf) → \`from pdfpro import RelatorioPDF\`
    r = RelatorioPDF("/workspace/outputs/proposta.pdf", titulo="Proposta Comercial",
                     cliente="CLIENTE", emissor="Emissor", subtitulo="assunto", tipo="PROPOSTA COMERCIAL")
    r.capa(); r.titulo("1. Escopo"); r.paragrafo("texto...")
    r.tabela(["Serviço", "Valor"], [["Contabilidade", "R$ 1.200,00"], ["TOTAL", "R$ 1.200,00"]], total=True)
    r.callout("OBSERVAÇÃO", "texto", tipo="info"); r.salvar()

Escolha o formato pelo pedido: relatório/parecer/contrato/carta → Word; planilha/dados/cálculo/base → Excel; proposta/documento para imprimir e enviar fixo → PDF (ou o formato que a pessoa pedir). Cor da marca em todos: \`cor_marca="RRGGBB"\`.

REGRAS
- DADOS ESTRUTURADOS SEMPRE EM TABELA do kit (r.tabela / p.tabela): cadastro/CNPJ (Campo|Valor), sócios (Nome|Qualificação), CNAEs (Código|Descrição), itens/serviços (Item|Descrição|Valor com total=True). NUNCA em parágrafo "Campo: valor", lista com traços, nem célula solta estilizada na mão.
- FÓRMULAS DO EXCEL corretas: referencie as células REAIS que contêm os números (confira a coluna/linha que você escreveu). Nada de fórmula apontando para célula vazia. Prefira já calcular o valor em Python e escrever o número; use fórmula só quando a pessoa quiser a planilha "viva". O app recalcula e valida as fórmulas — se acusar erro, corrija antes de entregar.
- ZERO PLACEHOLDER: nunca "DD/MM/AAAA", "Seu Nome", "[cliente]", "XX". Use a DATA REAL (date.today()) e dados reais; campo inexistente, OMITA — não invente nem deixe rótulo vazio.
- Registro por tipo: relatório/proposta = design forte (docpro/pdfpro). Contrato/ata/registrável (JUCETINS) = SÓBRIO: python-docx puro, justificado, numeração rígida, sem cores fortes. Parecer = intermediário.
- Depois de salvar, CONFIRA: Word/PDF abra o resultado (capa equilibrada, nenhuma tabela vazando a margem, sem título órfão, sem página meio vazia); Excel confira que as tabelas têm o cabeçalho colorido e que as fórmulas não deram erro. Corrija se preciso.

FLUXO: entenda o pedido, o público e o FORMATO → reúna os dados (pesquise na web quando precisar; não invente o que faltar) → gere com run_python usando o kit certo → confira → responda em 2-4 frases (o app mostra o download sozinho; não escreva caminhos nem links).

Escreva em português do Brasil, no tom certo para o público do documento.`;

const DOCPRO_PROMPT_V7 = `Você é o especialista em documentos profissionais do Frederico AI Studio. Você ENTREGA o arquivo pronto para o cliente, com padrão de design de agência — em Word, Excel OU PDF. Converse de forma simples e cordial; todo o capricho vai no arquivo.

TRÊS KITS DE DESIGN PRONTOS E TESTADOS (mesma identidade visual). Em run_python, USE-OS — não estilize na mão nem escreva célula por célula com openpyxl cru.

1) WORD (.docx) → \`from docpro import Relatorio\`
    r = Relatorio("Título", cliente="CLIENTE", emissor="Emissor",
                  subtitulo="período/assunto", tipo="RELATÓRIO GERENCIAL")
    r.capa(); r.titulo("1. Dados cadastrais")
    r.tabela(["Campo", "Valor"], [["CNPJ", "..."], ["Razão Social", "..."]])
    r.tabela(["Item", "Descrição", "Valor"], linhas, total=True)  # última linha = TOTAL destacado
    r.paragrafo("análise..."); r.callout("RESUMO", "texto", tipo="info")
    r.kpis([("R$ 5M", "Capital"), ("ATIVA", "Situação")])
    r.salvar("/workspace/outputs/relatorio.docx")                 # salva e gera o PDF ao lado

2) EXCEL (.xlsx) → \`from xlspro import Planilha\`  (NÃO estilize células na mão!)
    p = Planilha()
    ws = p.aba("Vendas")
    p.titulo(ws, "Relatório de Vendas — 2025")
    info = p.tabela(ws, ["Produto", "Qtd", "Preço", "Total"], linhas,
                    moeda=["Preço", "Total"], total=True)         # última linha = TOTAL; header colorido+zebra automáticos
    p.grafico_barras(ws, info, categoria="Produto", valor="Total", titulo="Total por produto")
    res = p.aba("Resumo"); p.titulo(res, "Resumo")
    p.tabela(res, ["Indicador", "Valor"], [["Faturamento", 12345.0], ["Ticket médio", 82.3]], moeda=["Valor"])
    p.salvar("/workspace/outputs/vendas.xlsx")
   TODA tabela do Excel passa por p.tabela(...) — ela já faz cabeçalho 1A3C6E branco, zebra, bordas horizontais, R$/%/milhar (moeda=/pct=/milhar=), largura automática, congelar cabeçalho e linha TOTAL. Nunca escreva ws["A1"]=... com fill/borda manual.
   PREENCHA TODAS AS COLUNAS de cada linha: cada linha precisa ter o MESMO número de valores que o cabeçalho. Coluna calculada (ex.: Total = Qtd × Preço) você CALCULA em Python e coloca o número na linha — nunca deixe a coluna do cabeçalho vazia. Se o pedido fala em "somar", "total geral" ou "totais", inclua a última linha somando as colunas numéricas e chame p.tabela(..., total=True). O gráfico deve apontar para uma coluna que tem números (senão sai vazio).

3) PDF (.pdf) → \`from pdfpro import RelatorioPDF\`
    r = RelatorioPDF("/workspace/outputs/proposta.pdf", titulo="Proposta Comercial",
                     cliente="CLIENTE", emissor="Emissor", subtitulo="assunto", tipo="PROPOSTA COMERCIAL")
    r.capa(); r.titulo("1. Escopo"); r.paragrafo("texto...")
    r.tabela(["Serviço", "Valor"], [["Contabilidade", "R$ 1.200,00"], ["TOTAL", "R$ 1.200,00"]], total=True)
    r.callout("OBSERVAÇÃO", "texto", tipo="info"); r.salvar()

Escolha o formato pelo pedido: relatório/parecer/contrato/carta → Word; planilha/dados/cálculo/base → Excel; proposta/documento para imprimir e enviar fixo → PDF (ou o formato que a pessoa pedir). Cor da marca em todos: \`cor_marca="RRGGBB"\`.

REGRAS
- DADOS ESTRUTURADOS SEMPRE EM TABELA do kit (r.tabela / p.tabela): cadastro/CNPJ (Campo|Valor), sócios (Nome|Qualificação), CNAEs (Código|Descrição), itens/serviços (Item|Descrição|Valor com total=True). NUNCA em parágrafo "Campo: valor", lista com traços, nem célula solta estilizada na mão.
- FÓRMULAS DO EXCEL corretas: referencie as células REAIS que contêm os números (confira a coluna/linha que você escreveu). Nada de fórmula apontando para célula vazia. Prefira já calcular o valor em Python e escrever o número; use fórmula só quando a pessoa quiser a planilha "viva". O app recalcula e valida as fórmulas — se acusar erro, corrija antes de entregar.
- ZERO PLACEHOLDER: nunca "DD/MM/AAAA", "Seu Nome", "[cliente]", "XX". Use a DATA REAL (date.today()) e dados reais; campo inexistente, OMITA — não invente nem deixe rótulo vazio.
- Registro por tipo: relatório/proposta = design forte (docpro/pdfpro). Contrato/ata/registrável (JUCETINS) = SÓBRIO: python-docx puro, justificado, numeração rígida, sem cores fortes. Parecer = intermediário.
- Depois de salvar, CONFIRA: Word/PDF abra o resultado (capa equilibrada, nenhuma tabela vazando a margem, sem título órfão, sem página meio vazia); Excel confira que as tabelas têm o cabeçalho colorido e que as fórmulas não deram erro. Corrija se preciso.

FLUXO: entenda o pedido, o público e o FORMATO → reúna os dados (pesquise na web quando precisar; não invente o que faltar) → gere com run_python usando o kit certo → confira → responda em 2-4 frases (o app mostra o download sozinho; não escreva caminhos nem links).

Escreva em português do Brasil, no tom certo para o público do documento.`;

const DOCPRO_PROMPT_V8 = `Você é o especialista em documentos profissionais do Frederico AI Studio. Você ENTREGA o arquivo pronto para o cliente, com padrão de design de agência — em Word, Excel OU PDF. Converse de forma simples e cordial; todo o capricho vai no arquivo.

TRÊS KITS DE DESIGN PRONTOS E TESTADOS (mesma identidade visual). Em run_python, USE-OS — não estilize na mão nem escreva célula por célula com openpyxl cru.

1) WORD (.docx) → \`from docpro import Relatorio\`
    r = Relatorio("Título", cliente="CLIENTE", emissor="Emissor",
                  subtitulo="período/assunto", tipo="RELATÓRIO GERENCIAL")
    r.capa(); r.titulo("1. Dados cadastrais")
    r.tabela(["Campo", "Valor"], [["CNPJ", "..."], ["Razão Social", "..."]])
    r.tabela(["Item", "Descrição", "Valor"], linhas, total=True)  # última linha = TOTAL destacado
    r.paragrafo("análise..."); r.callout("RESUMO", "texto", tipo="info")
    r.kpis([("R$ 5M", "Capital"), ("ATIVA", "Situação")])
    r.salvar("/workspace/outputs/relatorio.docx")                 # salva e gera o PDF ao lado

2) EXCEL (.xlsx) → \`from xlspro import Planilha\`  (NÃO estilize células na mão!)
    p = Planilha()
    ws = p.aba("Vendas")
    p.titulo(ws, "Relatório de Vendas — 2025")
    info = p.tabela(ws, ["Produto", "Qtd", "Preço", "Total"], linhas,
                    moeda=["Preço", "Total"], total=True)         # última linha = TOTAL; header colorido+zebra automáticos
    p.grafico_barras(ws, info, categoria="Produto", valor="Total", titulo="Total por produto")
    res = p.aba("Resumo"); p.titulo(res, "Resumo")
    p.tabela(res, ["Indicador", "Valor"], [["Faturamento", 12345.0], ["Ticket médio", 82.3]], moeda=["Valor"])
    p.salvar("/workspace/outputs/vendas.xlsx")
   TODA tabela do Excel passa por p.tabela(...) — ela já faz cabeçalho 1A3C6E branco, zebra, bordas horizontais, R$/%/milhar (moeda=/pct=/milhar=), largura automática, congelar cabeçalho e linha TOTAL. Nunca escreva ws["A1"]=... com fill/borda manual.
   PREENCHA TODAS AS COLUNAS de cada linha: cada linha precisa ter o MESMO número de valores que o cabeçalho. Coluna calculada (ex.: Total = Qtd × Preço) você CALCULA em Python e coloca o número na linha — nunca deixe a coluna do cabeçalho vazia. Se o pedido fala em "somar", "total geral" ou "totais", inclua a última linha somando as colunas numéricas e chame p.tabela(..., total=True). O gráfico deve apontar para uma coluna que tem números (senão sai vazio). Para GRÁFICO DE PIZZA/participação por categoria, monte uma tabela em formato LONGO (uma linha por categoria, ex.: colunas Produto | Total) e faça p.grafico_pizza sobre ELA (categoria="Produto", valor="Total") — nunca aponte a pizza para uma coluna de totais por mês/período. Se os dados estão em formato largo (produtos nas colunas, meses nas linhas), crie essa tabelinha Produto|Total à parte (ex.: na aba Resumo) para o gráfico.

3) PDF (.pdf) → \`from pdfpro import RelatorioPDF\`
    r = RelatorioPDF("/workspace/outputs/proposta.pdf", titulo="Proposta Comercial",
                     cliente="CLIENTE", emissor="Emissor", subtitulo="assunto", tipo="PROPOSTA COMERCIAL")
    r.capa(); r.titulo("1. Escopo"); r.paragrafo("texto...")
    r.tabela(["Serviço", "Valor"], [["Contabilidade", "R$ 1.200,00"], ["TOTAL", "R$ 1.200,00"]], total=True)
    r.callout("OBSERVAÇÃO", "texto", tipo="info"); r.salvar()

Escolha o formato pelo pedido: relatório/parecer/contrato/carta → Word; planilha/dados/cálculo/base → Excel; proposta/documento para imprimir e enviar fixo → PDF (ou o formato que a pessoa pedir). Cor da marca em todos: \`cor_marca="RRGGBB"\`.

REGRAS
- DADOS ESTRUTURADOS SEMPRE EM TABELA do kit (r.tabela / p.tabela): cadastro/CNPJ (Campo|Valor), sócios (Nome|Qualificação), CNAEs (Código|Descrição), itens/serviços (Item|Descrição|Valor com total=True). NUNCA em parágrafo "Campo: valor", lista com traços, nem célula solta estilizada na mão.
- FÓRMULAS DO EXCEL corretas: referencie as células REAIS que contêm os números (confira a coluna/linha que você escreveu). Nada de fórmula apontando para célula vazia. Prefira já calcular o valor em Python e escrever o número; use fórmula só quando a pessoa quiser a planilha "viva". O app recalcula e valida as fórmulas — se acusar erro, corrija antes de entregar.
- ZERO PLACEHOLDER: nunca "DD/MM/AAAA", "Seu Nome", "[cliente]", "XX". Use a DATA REAL (date.today()) e dados reais; campo inexistente, OMITA — não invente nem deixe rótulo vazio.
- Registro por tipo: relatório/proposta = design forte (docpro/pdfpro). Contrato/ata/registrável (JUCETINS) = SÓBRIO: python-docx puro, justificado, numeração rígida, sem cores fortes. Parecer = intermediário.
- Depois de salvar, CONFIRA: Word/PDF abra o resultado (capa equilibrada, nenhuma tabela vazando a margem, sem título órfão, sem página meio vazia); Excel confira que as tabelas têm o cabeçalho colorido e que as fórmulas não deram erro. Corrija se preciso.

FLUXO: entenda o pedido, o público e o FORMATO → reúna os dados (pesquise na web quando precisar; não invente o que faltar) → gere com run_python usando o kit certo → confira → responda em 2-4 frases (o app mostra o download sozinho; não escreva caminhos nem links).

Escreva em português do Brasil, no tom certo para o público do documento.`;

const DOCPRO_PROMPT = `Você é o especialista em documentos profissionais do Frederico AI Studio. Você ENTREGA o arquivo pronto para o cliente, com padrão de design de agência — em Word, Excel OU PDF. Converse de forma simples e cordial; todo o capricho vai no arquivo.

TRÊS KITS DE DESIGN PRONTOS E TESTADOS (mesma identidade visual). Em run_python, USE-OS — não estilize na mão nem escreva célula por célula com openpyxl cru.

1) WORD (.docx) → \`from docpro import Relatorio\`
    r = Relatorio("Título", cliente="CLIENTE", emissor="Emissor",
                  subtitulo="período/assunto", tipo="RELATÓRIO GERENCIAL")
    r.capa(); r.titulo("1. Dados cadastrais")
    r.tabela(["Campo", "Valor"], [["CNPJ", "..."], ["Razão Social", "..."]])
    r.tabela(["Item", "Descrição", "Valor"], linhas, total=True)  # última linha = TOTAL destacado
    r.paragrafo("análise..."); r.callout("RESUMO", "texto", tipo="info")
    r.kpis([("R$ 5M", "Capital"), ("ATIVA", "Situação")])
    r.salvar("/workspace/outputs/relatorio.docx")                 # salva e gera o PDF ao lado

2) EXCEL (.xlsx) → \`from xlspro import Planilha\`  (NÃO estilize células na mão!)
    p = Planilha()
    ws = p.aba("Vendas")
    p.titulo(ws, "Relatório de Vendas — 2025")
    info = p.tabela(ws, ["Produto", "Qtd", "Preço", "Total"], linhas,
                    moeda=["Preço", "Total"], total=True)         # última linha = TOTAL; header colorido+zebra automáticos
    p.grafico_barras(ws, info, categoria="Produto", valor="Total", titulo="Total por produto")
    res = p.aba("Resumo"); p.titulo(res, "Resumo")
    p.tabela(res, ["Indicador", "Valor"], [["Faturamento", 12345.0], ["Ticket médio", 82.3]], moeda=["Valor"])
    p.salvar("/workspace/outputs/vendas.xlsx")
   TODA tabela do Excel passa por p.tabela(...) — ela já faz cabeçalho 1A3C6E branco, zebra, bordas horizontais, R$/%/milhar (moeda=/pct=/milhar=), largura automática, congelar cabeçalho e linha TOTAL. Nunca escreva ws["A1"]=... com fill/borda manual.
   PREENCHA TODAS AS COLUNAS de cada linha: cada linha precisa ter o MESMO número de valores que o cabeçalho. Coluna calculada (ex.: Total = Qtd × Preço) você CALCULA em Python e coloca o número na linha — nunca deixe a coluna do cabeçalho vazia. Se o pedido fala em "somar", "total geral" ou "totais", inclua a última linha somando as colunas numéricas e chame p.tabela(..., total=True). O gráfico deve apontar para uma coluna que tem números (senão sai vazio). Para GRÁFICO DE PIZZA/participação por categoria, monte uma tabela em formato LONGO (uma linha por categoria, ex.: colunas Produto | Total) e faça p.grafico_pizza sobre ELA (categoria="Produto", valor="Total") — nunca aponte a pizza para uma coluna de totais por mês/período. Se os dados estão em formato largo (produtos nas colunas, meses nas linhas), crie essa tabelinha Produto|Total à parte (ex.: na aba Resumo) para o gráfico.

3) PDF (.pdf) → \`from pdfpro import RelatorioPDF\`
    r = RelatorioPDF("/workspace/outputs/proposta.pdf", titulo="Proposta Comercial",
                     cliente="CLIENTE", emissor="Emissor", subtitulo="assunto", tipo="PROPOSTA COMERCIAL")
    r.capa(); r.titulo("1. Escopo"); r.paragrafo("texto...")
    r.tabela(["Serviço", "Valor"], [["Contabilidade", "R$ 1.200,00"], ["TOTAL", "R$ 1.200,00"]], total=True)
    r.callout("OBSERVAÇÃO", "texto", tipo="info"); r.salvar()

Escolha o formato pelo pedido: relatório/parecer/contrato/carta → Word; planilha/dados/cálculo/base → Excel; proposta/documento para imprimir e enviar fixo → PDF (ou o formato que a pessoa pedir). Cor da marca em todos: \`cor_marca="RRGGBB"\`.

REGRAS
- DADOS ESTRUTURADOS SEMPRE EM TABELA do kit (r.tabela / p.tabela): cadastro/CNPJ (Campo|Valor), sócios (Nome|Qualificação), CNAEs (Código|Descrição), itens/serviços (Item|Descrição|Valor com total=True). NUNCA em parágrafo "Campo: valor", lista com traços, nem célula solta estilizada na mão.
- FÓRMULAS DO EXCEL corretas: referencie as células REAIS que contêm os números (confira a coluna/linha que você escreveu). Nada de fórmula apontando para célula vazia. Prefira já calcular o valor em Python e escrever o número; use fórmula só quando a pessoa quiser a planilha "viva". O app recalcula e valida as fórmulas — se acusar erro, corrija antes de entregar.
- ZERO PLACEHOLDER: nunca "DD/MM/AAAA", "Seu Nome", "[cliente]", "XX" — e também nada de preenchimento GEOGRÁFICO/genérico vago tipo "Cidade/Estado", "Bairro Novo", "Rua Nova, nº 456", "CEP 00000-000". Use a DATA REAL (date.today()) e dados concretos e plausíveis (ex.: para JUCETINS/Tocantins, "Palmas/TO" e uma rua real da cidade); se um campo realmente não existe, OMITA — não invente rótulo vazio nem deixe genérico.
- Registro por tipo: relatório/proposta = design forte (docpro/pdfpro). Contrato/ata/alteração contratual/registrável (JUCETINS) = SÓBRIO: monte com python-docx puro (SEM docpro), numeração rígida, negrito só estrutural, ZERO cor. Aqui o "capricho" é tipográfico: aplique alinhamento JUSTIFICADO em cada parágrafo do corpo (p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY) — texto à esquerda "solto" destoa de documento registrável. Parecer = intermediário.
- Depois de salvar, CONFIRA: Word/PDF abra o resultado (capa equilibrada, nenhuma tabela vazando a margem, sem título órfão, sem página meio vazia; em documento sóbrio, corpo justificado e sem cor); Excel confira que as tabelas têm o cabeçalho colorido e que as fórmulas não deram erro. Corrija se preciso.

FLUXO: entenda o pedido, o público e o FORMATO → reúna os dados (pesquise na web quando precisar; não invente o que faltar) → gere com run_python usando o kit certo → confira → responda em 2-4 frases (o app mostra o download sozinho; não escreva caminhos nem links).

Escreva em português do Brasil, no tom certo para o público do documento.`;

// Semeadura POR USUÁRIO (multi-tenant). Cria o assistente "Documentos
// profissionais" deste usuário com o prompt atual; se ele já existe mas ainda
// tem o prompt padrão ANTIGO (LEGACY), atualiza para o novo — sem tocar em
// versões personalizadas pelo usuário. A antiga flag global
// (settings.docpro_prompt_version) foi removida: o gating agora é por usuário.
async function seedDocProAssistant(userId) {
  try {
    const exists = await db.prepare('SELECT id,system_prompt FROM assistants WHERE name=? AND user_id=?').get('Documentos profissionais', userId);
    if (!exists) {
      const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat';
      const t = now();
      await db.prepare('INSERT INTO assistants (id,user_id,name,emoji,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(nanoid(), userId, 'Documentos profissionais', 'file-pen-line', defaultModel, DOCPRO_PROMPT, JSON.stringify([]), JSON.stringify({ form: 60, det: 60, criat: 30 }), t, t);
    } else if (!String(exists.system_prompt || '').trim() || exists.system_prompt === DOCPRO_PROMPT_LEGACY || exists.system_prompt === DOCPRO_PROMPT_V2 || exists.system_prompt === DOCPRO_PROMPT_V3 || exists.system_prompt === DOCPRO_PROMPT_V4 || exists.system_prompt === DOCPRO_PROMPT_V5 || exists.system_prompt === DOCPRO_PROMPT_V6 || exists.system_prompt === DOCPRO_PROMPT_V7 || exists.system_prompt === DOCPRO_PROMPT_V8) {
      // Migra dos prompts padrão anteriores (LEGACY, V2, V3, V4, V5, V6, V7 e V8) para o atual —
      // sem tocar em versões personalizadas pelo usuário.
      await db.prepare('UPDATE assistants SET system_prompt=?, updated_at=? WHERE id=? AND user_id=?')
        .run(DOCPRO_PROMPT, now(), exists.id, userId);
    }
  } catch (e) { console.error('[seed docpro]', e.message); }
}

// Biblioteca inicial de templates de pedido (o usuário pode criar os seus)
async function seedTemplates(userId) {
  if (Number((await db.prepare('SELECT COUNT(*) c FROM templates WHERE user_id=?').get(userId)).c) > 0) return;
  const seeds = [
    { name: '📊 Planilha a partir de dados', content: 'Analise o arquivo enviado (CSV, Excel, texto ou PDF) e gere uma planilha Excel bem organizada: uma aba de dados limpos, uma aba de resumo com totais e indicadores, e gráficos quando fizer sentido. Formate profissionalmente (cabeçalhos congelados, números alinhados à direita) e explique o que fez.' },
    { name: '📄 Proposta comercial', content: 'Crie um documento Word com uma proposta comercial profissional contendo: capa com título e data, apresentação da empresa, escopo dos serviços, cronograma, investimento (tabela de valores), condições de pagamento, validade da proposta e espaço para assinaturas. Use linguagem formal e formatação elegante.' },
    { name: '📝 Contrato de prestação de serviços', content: 'Crie um documento Word com um contrato de prestação de serviços completo: qualificação das partes (CONTRATANTE e CONTRATADA com espaços para dados), objeto, obrigações de cada parte, valor e forma de pagamento, prazo e vigência, rescisão, multas, confidencialidade, foro e assinaturas com testemunhas. Linguagem clara.' },
    { name: '✉️ E-mail profissional', content: 'Escreva um e-mail profissional a partir do assunto e dos pontos que eu indicar. Me pergunte o objetivo, o destinatário e o tom desejado (formal ou cordial), e devolva o texto pronto para enviar, com assunto sugerido.' },
    { name: '📈 Relatório mensal', content: 'Analise os arquivos enviados e gere um relatório mensal em PDF com: capa, sumário executivo com os principais números, análise por seção com tabelas e gráficos, destaques e pontos de atenção do período, e conclusão com recomendações. Visual profissional e limpo.' }
  ];
  const stmt = db.prepare('INSERT INTO templates (id,user_id,name,content,created_at) VALUES (?,?,?,?,?)');
  const t = now();
  for (const s of seeds) await stmt.run(nanoid(), userId, s.name, s.content, t);
}

// Semeadura idempotente por usuário. Guardada por um Set em memória para ser
// barata a cada requisição; os próprios seeds também checam no banco (por
// usuário), então é seguro mesmo entre reinícios / múltiplos processos.
const seededUsers = new Set();
async function ensureUserSeeded(userId) {
  if (!userId || seededUsers.has(userId)) return;
  await seedAssistants(userId);
  await seedDocProAssistant(userId);
  await seedTemplates(userId);
  seededUsers.add(userId);
}

// Cria/verifica a conversa PARA o usuário informado. A checagem de existência é
// escopada por user_id (uma conversa de outro usuário não é reutilizada nem
// "adotada"); o INSERT grava o user_id.
async function ensureConversation(userId, id, model) {
  const existing = await db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
  if (existing) return existing;
  // Se o id já existe mas é de OUTRO usuário, NÃO cria (evita colisão de PK e o
  // acesso indevido): retorna null → o chamador responde 404.
  if (await db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id)) return null;
  const t = now();
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, 'Nova conversa', model || process.env.DEEPSEEK_MODEL || 'deepseek-chat', t, t);
  workspaceFor(id);
  return db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
}

// ---- Limite diário de mensagens por usuário (proteção numa SaaS) ----
// RATE_MSGS_PER_DAY = 0 (padrão) → sem limite (bom para instância pessoal).
// > 0 → cada usuário pode enviar no máximo N mensagens por dia. Registrado em
// usage_daily (contador por usuário e por dia, no fuso do app).
const RATE_MSGS_PER_DAY = Math.max(0, Number(process.env.RATE_MSGS_PER_DAY || 0));

// Contabiliza uma mensagem do usuário no dia de hoje e devolve o total já usado.
// Faz UPSERT atômico (INSERT ... ON CONFLICT ... RETURNING) para não perder
// contagem em envios simultâneos.
async function bumpDailyUsage(userId) {
  const day = scheduleDateKey(new Date(), scheduleTimeZone);
  const row = await db.prepare(
    `INSERT INTO usage_daily (user_id, day, msgs) VALUES (?,?,1)
     ON CONFLICT (user_id, day) DO UPDATE SET msgs = usage_daily.msgs + 1
     RETURNING msgs`
  ).get(userId, day);
  return Number(row?.msgs || 0);
}

// Aplica o limite ANTES de rodar o agente. Se estourar, devolve a mensagem de
// erro amigável (string); caso contrário devolve null (pode prosseguir).
async function enforceDailyLimit(userId) {
  if (!RATE_MSGS_PER_DAY) return null; // sem limite configurado
  const used = await bumpDailyUsage(userId);
  if (used > RATE_MSGS_PER_DAY) {
    return `Você atingiu o limite de ${RATE_MSGS_PER_DAY} mensagens por dia deste plano. O contador zera amanhã. Se precisar de mais, fale com o administrador.`;
  }
  return null;
}

app.get('/api/health', (_, res) => res.json({ ok: true, name: 'Frederico AI Studio', auth: true, scheduleTimeZone }));

// Dados do usuário logado + flags que a interface usa (ex.: mostrar o botão de
// backup só para o administrador; esconder "Pastas do PC" quando desligado).
app.get('/api/me', (req, res) => res.json({
  id: req.userId,
  email: req.user?.email || null,
  name: req.user?.name || null,
  isAdmin: isAdmin(req),
  pcFoldersEnabled: PC_FOLDERS_ENABLED
}));

// Lista os modelos disponíveis no provedor configurado (ex.: catálogo do
// OpenRouter). Marca quais suportam "tools" (necessário p/ gerar arquivos).
let modelsCache = null, modelsCacheAt = 0;
app.get('/api/models', async (_, res) => {
  if (modelsCache && Date.now() - modelsCacheAt < 10 * 60 * 1000) return res.json({ models: modelsCache });
  try {
    const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ''}` } });
    const data = await r.json();
    const models = registerModelCatalog(data.data || [])
      .sort((a, b) => a.name.localeCompare(b.name));
    modelsCache = models; modelsCacheAt = Date.now();
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

// ---- Assistentes (Assistant Studio) ----
app.get('/api/assistants', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM assistants WHERE user_id=? ORDER BY created_at ASC').all(req.userId))
    .map(a => ({ ...a, tools: safeParse(a.tools, []), personality: safeParse(a.personality, {}) })));
});

app.post('/api/assistants', async (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim() || !b.system_prompt?.trim()) return res.status(400).json({ error: 'Nome e instruções são obrigatórios.' });
  const id = nanoid();
  const t = now();
  await db.prepare('INSERT INTO assistants (id,user_id,name,emoji,color,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, b.name.trim(), b.emoji || 'bot', b.color || null, b.model || process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat', b.system_prompt, JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), t, t);
  res.json(await loadAssistant(req.userId, id));
});

app.put('/api/assistants/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await db.prepare('SELECT id FROM assistants WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  await db.prepare('UPDATE assistants SET name=?, emoji=?, color=?, model=?, system_prompt=?, tools=?, personality=?, updated_at=? WHERE id=? AND user_id=?')
    .run(b.name?.trim() || 'Assistente', b.emoji || 'bot', b.color || null, b.model || null, b.system_prompt || '', JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), now(), req.params.id, req.userId);
  res.json(await loadAssistant(req.userId, req.params.id));
});

app.delete('/api/assistants/:id', async (req, res) => {
  const r = await db.prepare('DELETE FROM assistants WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ ok: true });
});

// ---- Pastas do Computador (acesso do assistente a pastas reais do PC) ----
// Rejeita raízes de disco e pastas de sistema (Windows e Linux) — inclusive
// qualquer subpasta delas — para o assistente nunca montar o SO inteiro nem
// diretórios sensíveis (ex.: /var/run com o docker.sock).
function isDangerousHostPath(raw) {
  const p = String(raw || '').trim();
  if (!p) return true;
  // Rejeita qualquer travessia de diretório ("..") — sem isso a blocklist
  // abaixo é burlável (ex.: /home/x/../../etc). Não há caso legítimo com "..".
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p)) return true;
  const stripped = p.replace(/[\\/]+$/, '');
  if (stripped === '' || stripped === '.') return true;              // raiz POSIX "/" ou "\"
  if (/^[a-z]:$/i.test(stripped)) return true;                        // "C:"
  if (/^\\\\[^\\]+\\?[^\\]*$/.test(stripped)) return true;            // UNC "\\servidor\share"
  const norm = stripped.replace(/\\/g, '/').toLowerCase();
  const winSys = /^[a-z]:\/(windows|program files( \(x86\))?|programdata|\$recycle\.bin)(\/|$)/;
  if (winSys.test(norm)) return true;
  const posixSys = /^\/(etc|root|proc|sys|dev|boot|bin|sbin|lib|lib64|usr|var|run)(\/|$)/;
  if (posixSys.test(norm)) return true;
  return false;
}
// Numa VPS pública o recurso fica DESLIGADO (montar caminhos do host é
// perigoso). Habilite só em uso pessoal com ENABLE_PC_FOLDERS=true.
function requirePcFolders(res) {
  if (PC_FOLDERS_ENABLED) return true;
  res.status(403).json({ error: 'O recurso "Pastas do PC" está desativado nesta instalação (uso pessoal apenas).' });
  return false;
}
app.get('/api/pc-folders', async (req, res) => {
  if (!PC_FOLDERS_ENABLED) return res.json([]);
  res.json(await db.prepare('SELECT id, label, host_path, writable FROM pc_folders WHERE user_id=? ORDER BY created_at ASC').all(req.userId));
});
app.post('/api/pc-folders', async (req, res) => {
  if (!requirePcFolders(res)) return;
  const label = (req.body?.label || '').trim();
  const hostPath = (req.body?.host_path || '').trim();
  if (!label || !hostPath) return res.status(400).json({ error: 'Nome e caminho da pasta são obrigatórios.' });
  if (isDangerousHostPath(hostPath)) return res.status(400).json({ error: 'Por segurança, não é permitido liberar a raiz do disco nem pastas do sistema (Windows, Arquivos de Programas, /etc, /var etc.). Escolha uma pasta específica de trabalho.' });
  const id = nanoid();
  await db.prepare('INSERT INTO pc_folders (id,user_id,label,host_path,writable,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.userId, label, hostPath, req.body?.writable ? 1 : 0, now());
  await destroyAllSandboxes(); // aplica o novo mount às conversas em andamento
  res.json({ id, label, host_path: hostPath, writable: req.body?.writable ? 1 : 0 });
});
app.put('/api/pc-folders/:id', async (req, res) => {
  if (!requirePcFolders(res)) return;
  await db.prepare('UPDATE pc_folders SET writable=? WHERE id=? AND user_id=?').run(req.body?.writable ? 1 : 0, req.params.id, req.userId);
  await destroyAllSandboxes();
  res.json({ ok: true });
});
app.delete('/api/pc-folders/:id', async (req, res) => {
  if (!requirePcFolders(res)) return;
  await db.prepare('DELETE FROM pc_folders WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  await destroyAllSandboxes();
  res.json({ ok: true });
});

// ---- Caixa de entrada de documentos (por cliente) ----
// Um lugar para acumular documentos de um cliente e, com 1 clique, abrir uma
// conversa nova já com todos anexados para a IA processar.
const inboxRoot = path.join(path.resolve(process.env.DATA_DIR || './data'), 'inbox');
function inboxDir(userId, client) {
  // Escopo por usuário: um usuário não pode ler a caixa de entrada de outro.
  const uKey = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_') || 'anon';
  const key = String(client || 'geral').replace(/[^a-zA-Z0-9_-]/g, '_') || 'geral';
  const d = path.join(inboxRoot, uKey, key);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
app.get('/api/inbox/:client', (req, res) => {
  const d = inboxDir(req.userId, req.params.client);
  const files = fs.readdirSync(d).map(n => {
    let size = 0; try { size = fs.statSync(path.join(d, n)).size; } catch { return null; }
    return { stored: n, name: n.replace(/^\d+_/, ''), size };
  }).filter(Boolean);
  res.json(files);
});
app.post('/api/inbox/:client/upload', upload.array('files'), (req, res) => {
  const d = inboxDir(req.userId, req.params.client);
  let count = 0;
  for (const file of req.files || []) {
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe = original.replace(/[^a-zA-Z0-9._ -]/g, '_');
    fs.writeFileSync(path.join(d, `${Date.now()}_${count}_${nanoid(6)}_${safe}`), file.buffer);
    count++;
  }
  res.json({ ok: true, count });
});
app.delete('/api/inbox/:client/:stored', (req, res) => {
  const d = inboxDir(req.userId, req.params.client);
  const target = path.join(d, path.basename(req.params.stored)); // basename evita traversal
  try { fs.rmSync(target, { force: true }); } catch {}
  res.json({ ok: true });
});
app.post('/api/inbox/:client/to-conversation', async (req, res) => {
  const d = inboxDir(req.userId, req.params.client);
  const files = fs.readdirSync(d);
  if (!files.length) return res.status(400).json({ error: 'A caixa de entrada está vazia.' });
  const convId = nanoid();
  const t = now();
  const clientId = req.params.client === 'geral' ? null : req.params.client;
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(convId, req.userId, `Documentos recebidos — ${t.slice(0, 10)}`, process.env.DEEPSEEK_MODEL || 'deepseek-chat', clientId, t, t);
  const ws = workspaceFor(convId);
  for (const n of files) {
    const original = n.replace(/^\d+_\d+_(?:[A-Za-z0-9_-]+_)?/, '');
    const dest = path.join(ws.uploads, n);
    try {
      fs.copyFileSync(path.join(d, n), dest);
      try { fs.chownSync(dest, 1000, 1000); } catch {}
      const size = fs.statSync(dest).size;
      await db.prepare('INSERT INTO files (id,conversation_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(nanoid(), convId, 'upload', original, `uploads/${n}`, size, now());
      fs.rmSync(path.join(d, n), { force: true }); // move: some da caixa para não reprocessar
    } catch {}
  }
  res.json({ id: convId });
});

// ---- Clientes / Projetos ----
app.get('/api/clients', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM clients WHERE user_id=? ORDER BY name ASC').all(req.userId));
});

app.post('/api/clients', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
  const id = nanoid();
  await db.prepare('INSERT INTO clients (id,user_id,name,created_at) VALUES (?,?,?,?)').run(id, req.userId, name, now());
  res.json({ id, name });
});

app.delete('/api/clients/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM clients WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  // Não destrutivo p/ as conversas: elas voltam para "Geral". Mas o conteúdo
  // PRIVADO indexado do cliente (memórias e trechos) é REMOVIDO — nunca
  // promovido a 'global', senão vazaria para as outras conversas.
  await db.prepare('UPDATE conversations SET client_id=NULL WHERE client_id=? AND user_id=?').run(req.params.id, req.userId);
  await db.prepare('DELETE FROM conversation_chunks WHERE scope=? AND user_id=?').run(`client:${req.params.id}`, req.userId);
  await db.prepare("DELETE FROM memory WHERE scope=? AND user_id=?").run(`client:${req.params.id}`, req.userId);
  await db.prepare("DELETE FROM memory_suggestions WHERE scope=? AND user_id=?").run(`client:${req.params.id}`, req.userId);
  await db.prepare('DELETE FROM clients WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- Templates de pedido ----
app.get('/api/templates', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM templates WHERE user_id=? ORDER BY created_at ASC').all(req.userId));
});

app.post('/api/templates', async (req, res) => {
  const name = (req.body?.name || '').trim();
  const content = (req.body?.content || '').trim();
  if (!name || !content) return res.status(400).json({ error: 'Nome e conteúdo são obrigatórios.' });
  const id = nanoid();
  await db.prepare('INSERT INTO templates (id,user_id,name,content,created_at) VALUES (?,?,?,?,?)').run(id, req.userId, name, content, now());
  res.json({ id, name, content });
});

app.delete('/api/templates/:id', async (req, res) => {
  await db.prepare('DELETE FROM templates WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- Memória de longo prazo (Cérebro do Assistente) ----
app.get('/api/memories', async (req, res) => {
  try {
    res.json(await listMemories(req.userId, { query: req.query.query || '', type: req.query.type || '', scope: req.query.scope || '' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memories', async (req, res) => {
  try {
    const b = req.body || {};
    if (looksSensitive(b.content)) return res.status(400).json({ error: 'Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.' });
    res.json(await addMemory(req.userId, { content: b.content, type: b.type || 'manual', scope: b.scope || 'global', importance: Number(b.importance) || 3, pinned: b.pinned ? 1 : 0, tags: b.tags || null, source_type: 'manual' }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/memories/:id', async (req, res) => {
  try {
    const m = await updateMemory(req.userId, req.params.id, req.body || {});
    if (!m) return res.status(404).json({ error: 'Não encontrado' });
    res.json(m);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/memories/:id', async (req, res) => { await deleteMemory(req.userId, req.params.id); res.json({ ok: true }); });

app.delete('/api/memories', async (req, res) => {
  await deleteAllMemories(req.userId, { scope: req.query.scope || null, source_type: req.query.source_type || null });
  res.json({ ok: true });
});

app.get('/api/memory-suggestions', async (req, res) => {
  res.json(await listMemorySuggestions(req.userId, { status: req.query.status || 'pending', limit: req.query.limit || 100 }));
});

app.put('/api/memory-suggestions/:id', async (req, res) => {
  try {
    const s = await updateMemorySuggestion(req.userId, req.params.id, req.body || {});
    if (!s) return res.status(404).json({ error: 'Não encontrado' });
    res.json(s);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/memory-suggestions/:id/approve', async (req, res) => {
  try {
    const r = await approveMemorySuggestion(req.userId, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/memory-suggestions/:id/reject', async (req, res) => {
  const s = await rejectMemorySuggestion(req.userId, req.params.id);
  if (!s) return res.status(404).json({ error: 'Não encontrado' });
  res.json(s);
});

app.get('/api/memories/export', async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="memoria-frederico-ai.json"');
  res.json(await exportAll(req.userId));
});

app.post('/api/memories/reindex', async (req, res) => {
  try { res.json(await reindexAll(req.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Inicia a importação em segundo plano; o progresso é consultado via /import-status
app.post('/api/memories/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const r = startImport(req.userId, Buffer.from(req.file.originalname, 'latin1').toString('utf8'), req.file.buffer, req.query.scope || 'global');
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ started: true });
});

app.get('/api/memories/import-status', (_, res) => res.json(importStatus));

app.get('/api/memory-config', (_, res) => res.json(getSettings()));
app.put('/api/memory-config', async (req, res) => res.json(await setSettings(req.body || {})));

// ---- BYOK: provedor de IA por usuário (chave própria, cifrada) ----
// GET nunca devolve a chave inteira — só uma máscara e o estado.
app.get('/api/provider', async (req, res) => {
  const row = await db.prepare('SELECT api_key_enc, base_url, model FROM user_settings WHERE user_id=?').get(req.userId);
  let keyMask = '';
  if (row?.api_key_enc) { const dec = decryptSecret(row.api_key_enc); keyMask = dec ? maskSecret(dec) : ''; }
  const prov = await getUserProvider(req.userId);
  res.json({ hasKey: prov.hasKey, source: prov.source, keyMask, base_url: row?.base_url || '', model: row?.model || '' });
});

// PUT salva/atualiza. apiKey ausente = mantém a atual; apiKey '' = remove.
app.put('/api/provider', async (req, res) => {
  const b = req.body || {};
  try {
    const existing = await db.prepare('SELECT api_key_enc FROM user_settings WHERE user_id=?').get(req.userId);
    let api_key_enc = existing?.api_key_enc || null;
    if (b.apiKey !== undefined) api_key_enc = String(b.apiKey).trim() ? encryptSecret(String(b.apiKey).trim()) : null;
    const base_url = (b.base_url || '').trim() || null;
    const model = (b.model || '').trim() || null;
    const t = now();
    await db.prepare(`INSERT INTO user_settings (user_id, api_key_enc, base_url, model, created_at, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT (user_id) DO UPDATE SET api_key_enc=excluded.api_key_enc, base_url=excluded.base_url, model=excluded.model, updated_at=excluded.updated_at`)
      .run(req.userId, api_key_enc, base_url, model, t, t);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Não foi possível salvar. Verifique se a ENCRYPTION_KEY está configurada no servidor.' });
  }
});

// POST testa a chave com uma chamada leve (lista de modelos).
app.post('/api/provider/test', async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  const baseURL = String(req.body?.base_url || '').trim() || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  let client;
  if (apiKey) {
    // Testa a chave que a pessoa acabou de digitar (ainda não salva).
    client = new OpenAI({ apiKey, baseURL });
  } else {
    // Sem chave nova no corpo: testa a configuração já salva.
    const prov = await getUserProvider(req.userId);
    client = prov.client;
  }
  if (!client) return res.status(400).json({ ok: false, error: 'Nenhuma chave configurada.' });
  try { await client.models.list(); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: friendlyApiError(e) }); }
});

// Rotas legadas (compatibilidade com versões antigas da interface)
app.get('/api/memory', async (req, res) => {
  res.json(await listMemories(req.userId, { scope: req.query.scope || 'global' }));
});
app.post('/api/memory', async (req, res) => {
  try { res.json(await addMemory(req.userId, { content: req.body?.content, scope: req.body?.scope || 'global' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/memory/:id', async (req, res) => { await deleteMemory(req.userId, req.params.id); res.json({ ok: true }); });

// ---- Analytics de uso (mensagens e tokens) ----
app.get('/api/analytics', async (req, res) => {
  const totals = await db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens FROM usage WHERE user_id=?').get(req.userId);
  totals.messages = Number(totals.messages);
  totals.tokens = Number(totals.tokens);
  totals.prompt_tokens = Number(totals.prompt_tokens);
  totals.completion_tokens = Number(totals.completion_tokens);
  const byAssistant = (await db.prepare(`
    SELECT COALESCE(a.name,'(sem assistente / equipe)') name, a.emoji,
           COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN assistants a ON a.id=u.assistant_id
    WHERE u.user_id=?
    GROUP BY u.assistant_id, a.name, a.emoji ORDER BY tokens DESC`).all(req.userId))
    .map(r => ({ ...r, messages: Number(r.messages), tokens: Number(r.tokens) }));
  const byModel = (await db.prepare('SELECT model, COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens FROM usage WHERE user_id=? GROUP BY model ORDER BY tokens DESC').all(req.userId))
    .map(r => ({ ...r, messages: Number(r.messages), tokens: Number(r.tokens) }));
  const byConversation = (await db.prepare(`
    SELECT COALESCE(c.title,'(conversa apagada)') title, COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN conversations c ON c.id=u.conversation_id
    WHERE u.user_id=?
    GROUP BY u.conversation_id, c.title ORDER BY tokens DESC LIMIT 15`).all(req.userId))
    .map(r => ({ ...r, messages: Number(r.messages), tokens: Number(r.tokens) }));
  res.json({ totals, byAssistant, byModel, byConversation });
});

app.get('/api/conversations', async (req, res) => {
  if (req.query.all === '1') return res.json(await db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(req.userId));
  const clientId = req.query.client || null;
  const rows = clientId
    ? await db.prepare('SELECT * FROM conversations WHERE user_id=? AND client_id=? ORDER BY updated_at DESC').all(req.userId, clientId)
    : await db.prepare('SELECT * FROM conversations WHERE user_id=? AND client_id IS NULL ORDER BY updated_at DESC').all(req.userId);
  res.json(rows);
});

app.post('/api/conversations', async (req, res) => {
  const id = nanoid();
  const t = now();
  const title = req.body?.title || 'Nova conversa';
  const model = req.body?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const clientId = req.body?.clientId || null;
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, req.userId, title, model, clientId, t, t);
  workspaceFor(id);
  res.json({ id, title, model, client_id: clientId, created_at: t, updated_at: t });
});

app.get('/api/conversations/:id', async (req, res) => {
  // Verifica a POSSE antes de tocar nas mensagens (isolamento): se a conversa
  // não é do usuário logado, 404 — nunca cria nem revela dados de outro dono.
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conversation) return res.status(404).json({ error: 'Não encontrado' });
  const messages = await db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC, seq ASC').all(req.params.id);
  // Anexa a cada mensagem os arquivos que ela gerou
  const byMsg = {};
  for (const f of await db.prepare('SELECT id,name,path,size,message_id FROM files WHERE conversation_id=? AND message_id IS NOT NULL').all(req.params.id)) {
    (byMsg[f.message_id] ||= []).push(f);
  }
  messages.forEach((m, index) => {
    if (m.role === 'assistant') {
      m.content = sanitizeToolProtocolText(m.content);
      if (looksLikeFailedAssistantReply(m.content)) {
        const previousUser = [...messages.slice(0, index)].reverse().find(item => item.role === 'user');
        m.failed = true;
        m.retryText = previousUser?.content || '';
      }
    }
    m.files = byMsg[m.id] || [];
    if (m.memory_meta) {
      try { m.memory = JSON.parse(m.memory_meta); } catch {}
    }
    delete m.memory_meta;
  });
  res.json({ conversation, messages });
});

app.delete('/api/conversations/:id', async (req, res) => {
  const id = req.params.id;
  const existing = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  if (isConversationActive(id)) {
    return res.status(409).json({ error: 'Esta conversa ainda está concluindo uma resposta. Aguarde terminar ou interrompa o processamento antes de apagá-la.' });
  }
  await db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(id, req.userId); // cascade: messages + files
  // Privacidade: remove o índice de memória e os fatos extraídos desta conversa
  await db.prepare('DELETE FROM conversation_chunks WHERE conversation_id=? AND user_id=?').run(id, req.userId);
  await db.prepare("DELETE FROM memory WHERE source_type='auto' AND source_id=? AND user_id=?").run(id, req.userId);
  await destroyConversation(id); // remove container e pasta do workspace
  res.json({ ok: true });
});

app.post('/api/conversations/:id/upload', upload.array('files'), async (req, res) => {
  if (!await ensureConversation(req.userId, req.params.id)) return res.status(404).json({ error: 'Não encontrado' });
  const ws = workspaceFor(req.params.id);
  const saved = [];
  for (const file of req.files || []) {
    // multer/busboy entrega originalname em latin1; reconverte para UTF-8
    // para não corromper acentos (ex.: "Razão.pdf" virava "RazÃ£o.pdf").
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe = original.replace(/[^a-zA-Z0-9._ -]/g, '_');
    const name = `${Date.now()}_${nanoid(8)}_${safe}`;
    const target = path.join(ws.uploads, name);
    fs.writeFileSync(target, file.buffer);
    try { fs.chownSync(target, 1000, 1000); } catch {}
    const id = nanoid();
    await db.prepare('INSERT INTO files (id,conversation_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.params.id, 'upload', original, `uploads/${name}`, file.size, now());
    saved.push({ id, name: original, path: `uploads/${name}`, size: file.size });
  }
  res.json({ files: saved });
});

app.get('/api/conversations/:id/files', async (req, res) => {
  if (!await ensureConversation(req.userId, req.params.id)) return res.status(404).json({ error: 'Não encontrado' });
  const ws = workspaceFor(req.params.id);
  const outputFiles = walk(ws.outputs).map(p => {
    if (!realInside(ws.base, p)) return null;
    const rel = path.relative(ws.base, p).replaceAll('\\', '/');
    let size = 0;
    try { size = fs.statSync(p).size; } catch { return null; } // arquivo removido no meio da varredura
    return { id: Buffer.from(rel).toString('base64url'), kind: 'output', name: path.basename(p), path: rel, size };
  }).filter(Boolean);
  const uploaded = await db.prepare('SELECT id,kind,name,path,size,created_at FROM files WHERE conversation_id=?').all(req.params.id);
  res.json([...uploaded, ...outputFiles]);
});

app.delete('/api/conversations/:id/files/*', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const ws = workspaceFor(req.params.id);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!insideBase(ws.base, target) || !realInside(ws.base, target)) return res.status(400).json({ error: 'Caminho inválido' });
  try { fs.rmSync(target, { force: true }); } catch {}
  await db.prepare('DELETE FROM files WHERE conversation_id=? AND path=?').run(req.params.id, rel.replaceAll('\\', '/'));
  res.json({ ok: true });
});

app.get('/api/conversations/:id/download/*', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).send('Arquivo não encontrado');
  const ws = workspaceFor(req.params.id);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!insideBase(ws.base, target) || !realInside(ws.base, target) || !fs.existsSync(target)) return res.status(404).send('Arquivo não encontrado');
  res.download(target);
});

// ---- Fila de tarefas (execução em segundo plano) ----
let taskWorkerBusy = false;
async function processTasks() {
  if (taskWorkerBusy) return;
  taskWorkerBusy = true;
  try {
    while (true) {
      const t = await db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
      if (!t) break;
      await db.prepare("UPDATE tasks SET status='running', started_at=?, progress_text='Iniciando...' WHERE id=?").run(now(), t.id);
      const setProg = async (txt) => { try { await db.prepare('UPDATE tasks SET progress_text=? WHERE id=?').run(String(txt).slice(0, 200), t.id); } catch {} };
      try {
        await ensureConversation(t.user_id, t.conversation_id, t.model);
        const assistant = await loadAssistant(t.user_id, t.assistant_id);
        const onEvent = (ev) => {
          if (ev.type === 'status') setProg(ev.content);
          else if (ev.type === 'tool_start') setProg(`Executando ${ev.name}...`);
        };
        const result = await runAgent({ userId: t.user_id, conversationId: t.conversation_id, userText: t.prompt, model: t.model, assistant, webSearch: !!t.web_search, onEvent });
        if (result?.usage) {
          await db.prepare('INSERT INTO usage (id,user_id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(nanoid(), t.user_id, t.conversation_id, t.assistant_id, result.model, 'tarefa', result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, now());
        }
        const outcome = classifyTaskResult(result);
        await db.prepare("UPDATE tasks SET status=?, finished_at=?, result_text=?, progress_text=?, error=? WHERE id=?")
          .run(outcome.status, now(), String(result?.text || '').slice(0, 300), outcome.progress, outcome.error, t.id);
      } catch (err) {
        console.error('[tarefa]', err);
        await db.prepare("UPDATE tasks SET status='error', finished_at=?, error=? WHERE id=?").run(now(), friendlyApiError(err), t.id);
      }
    }
  } finally { taskWorkerBusy = false; }
}

// (o reenfileiramento de tarefas e o disparo do worker acontecem no boot, ao
// final do arquivo, depois que as migrations garantem que as tabelas existem)

app.post('/api/tasks', async (req, res) => {
  const message = (req.body?.message || '').trim();
  const convId = req.body?.conversationId;
  if (!message) return res.status(400).json({ error: 'Mensagem vazia.' });
  if (!convId) return res.status(400).json({ error: 'Conversa não informada.' });
  if (!isConversationId(convId)) return res.status(400).json({ error: 'Identificador de conversa inválido.' });
  if (isConversationActive(convId)) return res.status(409).json({ error: 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de criar uma tarefa nela.' });
  // Escopo por usuário: só cria a tarefa se a conversa for do próprio usuário
  // (conversa de outro → 404, nunca "adotada").
  if (!await ensureConversation(req.userId, convId, req.body?.model)) return res.status(404).json({ error: 'Não encontrado' });
  const limitMsg = await enforceDailyLimit(req.userId);
  if (limitMsg) return res.status(429).json({ error: limitMsg });
  const id = nanoid();
  await db.prepare('INSERT INTO tasks (id,user_id,conversation_id,assistant_id,model,web_search,prompt,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, convId, req.body?.assistantId || null, req.body?.model || null, req.body?.webSearch ? 1 : 0, message, 'queued', now());
  processTasks().catch(() => {});
  res.json({ id, status: 'queued' });
});

app.get('/api/tasks', async (req, res) => {
  res.json(await db.prepare(`
    SELECT t.*, c.title conv_title FROM tasks t
    LEFT JOIN conversations c ON c.id=t.conversation_id
    WHERE t.user_id=?
    ORDER BY t.created_at DESC LIMIT 20`).all(req.userId));
});

app.post('/api/tasks/:id/cancel', async (req, res) => {
  const t = await db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!t) return res.status(404).json({ error: 'Não encontrado' });
  if (t.status === 'queued') await db.prepare("UPDATE tasks SET status='canceled', finished_at=? WHERE id=?").run(now(), t.id);
  else if (t.status === 'running') setControl(t.conversation_id, 'stop');
  res.json({ ok: true });
});

// ---- Rotinas agendadas (geram tarefas automaticamente na hora marcada) ----
async function runSchedule(s, d, markRun = true) {
  const convId = nanoid();
  const t = now();
  const runDate = scheduleDateKey(d, scheduleTimeZone);
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(convId, s.user_id, `Rotina: ${s.title} — ${runDate}`, s.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat', s.client_id || null, t, t);
  workspaceFor(convId);
  await db.prepare('INSERT INTO tasks (id,user_id,conversation_id,assistant_id,model,web_search,prompt,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(nanoid(), s.user_id, convId, s.assistant_id || null, s.model || null, s.web_search ? 1 : 0, s.prompt, 'queued', t);
  if (markRun) await db.prepare('UPDATE schedules SET last_run=? WHERE id=?').run(scheduleDateKey(d, scheduleTimeZone), s.id);
}
async function checkSchedules() {
  try {
    const d = new Date();
    let any = false;
    for (const s of await db.prepare('SELECT * FROM schedules WHERE enabled=1').all()) {
      if (scheduleDue(s, d, scheduleTimeZone)) { await runSchedule(s, d); any = true; }
    }
    if (any) processTasks().catch(() => {});
  } catch (e) { console.error('[rotinas]', e.message); }
}
setInterval(checkSchedules, 60 * 1000).unref();
setTimeout(checkSchedules, 5000);

app.get('/api/schedules', async (req, res) => res.json(await db.prepare('SELECT * FROM schedules WHERE user_id=? ORDER BY created_at DESC').all(req.userId)));
app.post('/api/schedules', async (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').trim();
  const prompt = (b.prompt || '').trim();
  if (!title || !prompt) return res.status(400).json({ error: 'Dê um nome e uma instrução para a rotina.' });
  const cadence = ['daily', 'weekly', 'monthly'].includes(b.cadence) ? b.cadence : 'monthly';
  const id = nanoid();
  await db.prepare('INSERT INTO schedules (id,user_id,title,prompt,assistant_id,model,client_id,web_search,cadence,day,hour,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, title, prompt, b.assistant_id || null, b.model || null, b.client_id || null, b.web_search ? 1 : 0, cadence, normalizeScheduleDay(cadence, b.day), normalizeScheduleHour(b.hour), 1, now());
  res.json(await db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').get(id, req.userId));
});
app.put('/api/schedules/:id', async (req, res) => {
  if (typeof req.body?.enabled !== 'undefined') await db.prepare('UPDATE schedules SET enabled=? WHERE id=? AND user_id=?').run(req.body.enabled ? 1 : 0, req.params.id, req.userId);
  res.json({ ok: true });
});
app.delete('/api/schedules/:id', async (req, res) => { await db.prepare('DELETE FROM schedules WHERE id=? AND user_id=?').run(req.params.id, req.userId); res.json({ ok: true }); });
app.post('/api/schedules/:id/run', async (req, res) => {
  const s = await db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!s) return res.status(404).json({ error: 'Não encontrado' });
  await runSchedule(s, new Date(), false); // execução manual não bloqueia a agendada do dia
  processTasks().catch(() => {});
  res.json({ ok: true });
});

// Exporta a conversa como PDF ou Word (gerado dentro do sandbox)
const PY_EXPORT = [
  'import json',
  "d = json.load(open('/workspace/.export.json'))",
  "fmt = '__FMT__'",
  "out = '/workspace/outputs/__OUT__'",
  "role = {'user': 'Voce', 'assistant': 'Assistente'}",
  "if fmt == 'docx':",
  '    from docx import Document',
  '    doc = Document()',
  "    doc.add_heading(d['title'], 0)",
  "    for m in d['messages']:",
  '        p = doc.add_paragraph()',
  "        r = p.add_run(role.get(m['role'], m['role']) + ' - ' + m['created_at'][:16].replace('T', ' '))",
  '        r.bold = True',
  "        doc.add_paragraph(m['content'])",
  '    doc.save(out)',
  'else:',
  '    from reportlab.lib.pagesizes import A4',
  '    from reportlab.lib.styles import getSampleStyleSheet',
  '    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer',
  '    from xml.sax.saxutils import escape',
  '    styles = getSampleStyleSheet()',
  "    story = [Paragraph(escape(d['title']), styles['Title']), Spacer(1, 12)]",
  "    for m in d['messages']:",
  "        story.append(Paragraph('<b>' + role.get(m['role'], m['role']) + '</b> - ' + m['created_at'][:16].replace('T', ' '), styles['Heading4']))",
  "        for line in m['content'].split('\\n'):",
  '            if line.strip():',
  "                story.append(Paragraph(escape(line), styles['BodyText']))",
  '        story.append(Spacer(1, 10))',
  '    SimpleDocTemplate(out, pagesize=A4).build(story)',
  "print('OK')"
].join('\n');

app.post('/api/conversations/:id/export', async (req, res) => {
  try {
    const format = req.body?.format === 'docx' ? 'docx' : 'pdf';
    const conv = await db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
    if (!conv) return res.status(404).json({ error: 'Não encontrado' });
    const messages = (await db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC, seq ASC').all(req.params.id))
      .map(message => ({
        ...message,
        content: message.role === 'assistant'
          ? sanitizeToolProtocolText(message.content)
          : message.content
      }));
    if (!messages.length) return res.status(400).json({ error: 'A conversa ainda não tem mensagens.' });
    const ws = workspaceFor(req.params.id);
    const jsonPath = path.join(ws.base, '.export.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: conv.title, messages }), 'utf8');
    try { fs.chownSync(jsonPath, 1000, 1000); } catch {}
    const slug = (conv.title || 'conversa').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'conversa';
    const name = `conversa-${slug}.${format}`;
    const result = JSON.parse(await runTool(req.params.id, 'run_python', { code: PY_EXPORT.replace('__FMT__', format).replace('__OUT__', name) }));
    try { fs.rmSync(jsonPath, { force: true }); } catch {}
    if (result.exitCode !== 0) return res.status(500).json({ error: 'Falha ao exportar: ' + String(result.output).slice(-200) });
    res.json({ ok: true, path: `outputs/${name}`, name });
  } catch (err) {
    console.error('[export]', err);
    res.status(500).json({ error: 'Falha ao exportar a conversa.' });
  }
});

// Backup completo (banco + workspaces) num .tar.gz para download.
// O banco agora é PostgreSQL: geramos um dump com pg_dump e o empacotamos junto
// com os workspaces. (Requer o cliente `pg_dump` no ambiente — incluído na
// imagem do backend.)
app.get('/api/backup', (req, res) => {
  // Backup = banco INTEIRO + todos os workspaces (dados de TODOS os usuários).
  // Só o administrador pode baixar.
  if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas o administrador pode baixar o backup completo.' });
  const stamp = new Date().toISOString().slice(0, 10);
  const wsRoot = path.resolve(process.env.WORKSPACE_ROOT || './workspaces');
  const dumpName = `frederico-db-${stamp}.sql`;
  const dumpPath = path.join('/tmp', dumpName);
  const dbUrl = process.env.DATABASE_URL || 'postgres://studio:studio@postgres:5432/studio';

  // 1) Dump do PostgreSQL para um arquivo temporário.
  const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '-f', dumpPath, dbUrl]);
  dump.stderr.on('data', () => {});
  dump.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Backup do banco falhou (pg_dump indisponível?).' }); });
  dump.on('close', (dumpCode) => {
    if (dumpCode !== 0) { if (!res.headersSent) res.status(500).json({ error: 'Falha ao exportar o banco de dados.' }); return; }

    // 2) Empacota o dump do banco + os workspaces num .tar.gz e transmite.
    const args = ['-czf', '-', '-C', '/tmp', dumpName];
    if (fs.existsSync(wsRoot)) args.push('-C', path.dirname(wsRoot), path.basename(wsRoot));
    const tar = spawn('tar', args);
    let headersSent = false;
    const cleanup = () => { try { fs.rmSync(dumpPath, { force: true }); } catch {} };
    const sendHeaders = () => {
      if (headersSent) return;
      headersSent = true;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="frederico-backup-${stamp}.tar.gz"`);
    };
    tar.stderr.on('data', () => {}); // drena o stderr (senão o buffer enche e o tar trava)
    tar.stdout.on('data', (chunk) => { sendHeaders(); if (!res.write(chunk)) tar.stdout.pause(); });
    res.on('drain', () => tar.stdout.resume());
    tar.stdout.on('end', () => { if (headersSent) res.end(); cleanup(); });
    // Falha antes de qualquer byte (ex.: tar ausente): responde erro JSON em vez
    // de um .tar.gz truncado que o usuário baixaria sem perceber.
    tar.on('error', (err) => { console.error('[backup]', err); cleanup(); if (!headersSent) res.status(500).json({ error: 'Falha ao gerar o backup (tar indisponível?).' }); else res.end(); });
    tar.on('close', (code) => { if (!headersSent && code !== 0) { cleanup(); res.status(500).json({ error: 'Falha ao gerar o backup.' }); } });
  });
});

// Edição de mensagem (estilo ChatGPT): remove a mensagem indicada e TUDO que
// veio depois dela na conversa, incluindo os arquivos gerados por essas
// mensagens — a conversa é regravada a partir dali.
app.post('/api/conversations/:id/truncate', async (req, res) => {
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const msg = await db.prepare('SELECT id, seq FROM messages WHERE id=? AND conversation_id=?').get(req.body?.messageId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
  // "Desta mensagem em diante" = mesma ordem de inserção ou posterior (seq).
  const fromMessage = 'seq >= ?';
  const doomed = (await db.prepare(`SELECT id FROM messages WHERE conversation_id=? AND ${fromMessage}`)
    .all(req.params.id, msg.seq)).map(r => r.id);
  if (doomed.length) {
    const ws = workspaceFor(req.params.id);
    const ph = doomed.map(() => '?').join(',');
    const orphanFiles = await db.prepare(`SELECT path FROM files WHERE conversation_id=? AND message_id IN (${ph})`).all(req.params.id, ...doomed);
    for (const f of orphanFiles) {
      const target = path.resolve(ws.base, f.path);
      if (insideBase(ws.base, target)) { try { fs.rmSync(target, { force: true }); } catch {} }
    }
    await db.prepare(`DELETE FROM files WHERE conversation_id=? AND message_id IN (${ph})`).run(req.params.id, ...doomed);
  }
  await db.prepare(`DELETE FROM messages WHERE conversation_id=? AND ${fromMessage}`)
    .run(req.params.id, msg.seq);
  // Privacidade: limpa o índice e os resumos derivados das mensagens removidas
  // (os chunks serão reindexados conforme a conversa continuar)
  await db.prepare('DELETE FROM conversation_chunks WHERE conversation_id=? AND user_id=?').run(req.params.id, req.userId);
  await db.prepare('UPDATE conversations SET summary_short=NULL, summary_long=NULL WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true, removed: doomed.length });
});

// Pausar / continuar / parar o processamento em andamento
app.post('/api/conversations/:id/control', async (req, res) => {
  const action = req.body?.action;
  if (!['pause', 'resume', 'stop'].includes(action)) return res.status(400).json({ error: 'Ação inválida.' });
  const conv = await db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  const control = setControl(req.params.id, action);
  if (!control) return res.status(409).json({ error: 'Não há processamento ativo nesta conversa.' });
  res.json({ ok: true, action, paused: control.paused, stopped: control.stopped });
});

app.post('/api/conversations/:id/chat', async (req, res) => {
  const text = String(req.body?.message || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensagem vazia.' });
  if (text.length > 100_000) return res.status(400).json({ error: 'A mensagem é grande demais. Envie em partes menores.' });
  if (isConversationActive(req.params.id)) {
    return res.status(409).json({ error: 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de enviar outra mensagem.' });
  }
  if (!await ensureConversation(req.userId, req.params.id, req.body?.model)) return res.status(404).json({ error: 'Não encontrado' });
  const limitMsg = await enforceDailyLimit(req.userId);
  if (limitMsg) return res.status(429).json({ error: limitMsg });
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // clientGone: o usuário saiu da página/minimizou (conexão SSE fechada). A
  // partir daí, as escritas SSE viram no-op — mas a TAREFA continua rodando.
  let clientGone = false;
  const send = (event) => {
    if (clientGone || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch { clientGone = true; }
  };
  // Pulso (heartbeat): comentário SSE a cada 15s para a conexão nunca ficar
  // "ociosa" durante esperas longas (modelo pensando, pesquisa na web). Sem
  // isso, proxies/gateways cortam com "Upstream idle timeout exceeded". O
  // cliente ignora linhas que não começam com "data:".
  const heartbeat = setInterval(() => { if (!clientGone && !res.writableEnded) { try { res.write(': ping\n\n'); } catch { clientGone = true; } } }, 15000);
  // Se o navegador desconectar (TROCAR DE ABA, MINIMIZAR no celular, rede
  // oscilando), a tarefa NÃO é mais interrompida: ela continua rodando e o
  // resultado é salvo na conversa, então ao voltar o usuário encontra o
  // arquivo/resposta prontos (antes, sair da página abortava tudo com "conexão
  // interrompida" — o bug relatado). Só cancelamos ao desconectar se
  // CANCEL_ON_DISCONNECT=true (comportamento antigo, para economizar tokens).
  // IMPORTANTE: usar o 'close' da RESPOSTA (res), não do pedido (req) — o
  // 'close' do req dispara assim que o corpo do POST termina de chegar.
  const cancelOnDisconnect = String(process.env.CANCEL_ON_DISCONNECT || '').toLowerCase() === 'true';
  res.on('close', () => {
    clientGone = true;
    clearInterval(heartbeat);
    if (cancelOnDisconnect && !res.writableEnded) setControl(req.params.id, 'stop');
  });
  try {
    const text = String(req.body?.message || '').trim();
    // Título automático: usa o início da 1ª mensagem em vez de "Nova conversa"
    const conv = await db.prepare('SELECT title FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.userId);
    if (conv && (!conv.title?.trim() || conv.title === 'Nova conversa')) {
      const autoTitle = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (autoTitle) await db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?').run(autoTitle, req.params.id, req.userId);
    }
    let result, kind = 'chat', usageAssistantId = req.body?.assistantId || null;
    if (req.body?.orchestrate) {
      const assistants = (await Promise.all((req.body?.orchestrateIds || []).map(id => loadAssistant(req.userId, id)))).filter(Boolean);
      kind = 'orquestrador'; usageAssistantId = null;
      const executor = await loadAssistant(req.userId, req.body?.assistantId);
      result = await runOrchestrator({
        userId: req.userId,
        conversationId: req.params.id,
        userText: text,
        model: req.body?.model,
        assistants,
        executor,
        webSearch: !!req.body?.webSearch,
        effort: req.body?.effort,
        developer: req.body?.developer,
        onEvent: send
      });
    } else {
      const assistant = await loadAssistant(req.userId, req.body?.assistantId);
      result = await runAgent({ userId: req.userId, conversationId: req.params.id, userText: text, model: req.body?.model, assistant, webSearch: !!req.body?.webSearch, effort: req.body?.effort, developer: req.body?.developer, onEvent: send });
    }
    const chatOutcome = classifyTaskResult(result);
    if (chatOutcome.status === 'error') {
      send({ type: 'execution_failed', content: chatOutcome.error });
    }
    // Registra o consumo de tokens para o painel de análises
    if (result?.usage) {
      await db.prepare('INSERT INTO usage (id,user_id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(nanoid(), req.userId, req.params.id, usageAssistantId, result.model, kind, result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, now());
    }
    send({ type: 'done' });
  } catch (err) {
    console.error('[chat]', err);
    send({ type: 'error', content: friendlyApiError(err) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}

// 404 padrão para rotas de API desconhecidas
app.use('/api', (_, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Tratador global de erros: loga o detalhe no servidor e devolve mensagem
// limpa ao cliente (sem stack trace).
app.use((err, req, res, _next) => {
  console.error('[erro]', req.method, req.path, err);
  if (res.headersSent) return res.end();
  const status = err.type === 'entity.parse.failed' ? 400 : err.status || 500;
  res.status(status).json({ error: status === 400 ? 'Requisição inválida (JSON malformado).' : 'Erro interno do servidor.' });
});

(async () => {
  // 1) Migrations criam/atualizam o schema ANTES de qualquer query.
  await runMigrations();
  // 2) Aquece os caches em memória (settings e pastas do PC).
  await loadSettings();
  await loadPcFolders();
  try { await maybeReindexOnModelChange(); } catch {}
  // 3) Os seeds agora são POR USUÁRIO (ensureUserSeeded), disparados sob demanda
  //    pelo middleware após a autenticação — não há mais seed global no boot.
  // 4) Tarefas que estavam "rodando" quando o servidor caiu voltam para a fila.
  try { await db.prepare("UPDATE tasks SET status='queued', progress_text='Reenfileirada após reinício' WHERE status='running'").run(); } catch {}
  // 5) Sobe o servidor e dispara o worker de tarefas em segundo plano.
  app.listen(port, () => console.log(`Frederico AI Studio backend em http://localhost:${port}`));
  setTimeout(() => processTasks().catch(() => {}), 2000);
})().catch((e) => { console.error('Falha no boot do backend:', e); process.exit(1); });
