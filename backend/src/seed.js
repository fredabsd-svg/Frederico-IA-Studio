// Semeadura POR USUÁRIO (multi-tenant): assistentes padrão, o assistente
// "Documentos profissionais" (DocPro) e a biblioteca inicial de templates.
// Movido do server.js na modularização — mesma lógica, mesmo comportamento.
//
// Os prompts do DocPro agora vivem em backend/prompts/docpro/*.txt (item 7 da
// revisão técnica): `atual.txt` é a versão vigente; os demais (legacy, v2…v9)
// existem SÓ para reconhecer instalações antigas e migrá-las para a atual sem
// tocar em prompts personalizados pelo usuário.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { AGENTS } from './agent.js';

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'docpro');
export const DOCPRO_PROMPT = fs.readFileSync(path.join(promptsDir, 'atual.txt'), 'utf8');
// Versões antigas do prompt padrão (para a migração em seedDocProAssistant).
const OLD_DOCPRO_PROMPTS = fs.readdirSync(promptsDir)
  .filter((f) => f.endsWith('.txt') && f !== 'atual.txt')
  .map((f) => fs.readFileSync(path.join(promptsDir, f), 'utf8'));

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

// Cria o assistente "Documentos profissionais" deste usuário com o prompt
// atual; se ele já existe mas ainda tem um prompt padrão ANTIGO, atualiza para
// o novo — sem tocar em versões personalizadas pelo usuário. A antiga flag
// global (settings.docpro_prompt_version) foi removida: o gating é por usuário.
async function seedDocProAssistant(userId) {
  try {
    const exists = await db.prepare('SELECT id,system_prompt FROM assistants WHERE name=? AND user_id=?').get('Documentos profissionais', userId);
    if (!exists) {
      const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat';
      const t = now();
      await db.prepare('INSERT INTO assistants (id,user_id,name,emoji,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(nanoid(), userId, 'Documentos profissionais', 'file-pen-line', defaultModel, DOCPRO_PROMPT, JSON.stringify([]), JSON.stringify({ form: 60, det: 60, criat: 30 }), t, t);
    } else if (!String(exists.system_prompt || '').trim() || OLD_DOCPRO_PROMPTS.includes(exists.system_prompt)) {
      // Migra dos prompts padrão anteriores (legacy, v2…v9) para o atual —
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
export async function ensureUserSeeded(userId) {
  if (!userId || seededUsers.has(userId)) return;
  await seedAssistants(userId);
  await seedDocProAssistant(userId);
  await seedTemplates(userId);
  seededUsers.add(userId);
}
