import OpenAI from 'openai';
import { toolDefinitions, runTool } from './tools.js';
import { db, now } from './db.js';
import { nanoid } from 'nanoid';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
});

export const systemPrompt = `Você é o Frederico AI Studio, um assistente profissional com sandbox Linux.
Responda em português do Brasil. Foque em contabilidade, fiscal, financeiro, Excel, Word, PDF e automação.
Quando o usuário pedir arquivos, gere arquivos reais dentro de /workspace/outputs usando Python.
Para Excel use openpyxl ou xlsxwriter; para Word use python-docx; para PDF use reportlab/weasyprint.
Sempre valide os arquivos gerados listando a pasta outputs. Não invente links: os links serão exibidos pelo sistema.
Não peça para o usuário compilar código quando você pode executar na sandbox.`;

export async function runAgent({ conversationId, userText, model, onEvent }) {
  const chosenModel = model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  saveMessage(conversationId, 'user', userText);
  const history = db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, created_at FROM messages
      WHERE conversation_id=? ORDER BY created_at DESC LIMIT 40
    ) ORDER BY created_at ASC`).all(conversationId);
  const messages = [{ role: 'system', content: systemPrompt }, ...history.map(m => ({ role: m.role, content: m.content }))];

  let finalText = '';
  for (let step = 0; step < 8; step++) {
    onEvent({ type: 'status', content: step === 0 ? 'Pensando...' : 'Executando ferramentas...' });
    const completion = await client.chat.completions.create({
      model: chosenModel,
      messages,
      tools: toolDefinitions,
      tool_choice: 'auto',
      temperature: 0.2
    });
    const msg = completion.choices[0].message;
    // Reenvia só o que a API espera (evita campos extras como reasoning_content)
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
    if (msg.content) {
      finalText += msg.content;
      onEvent({ type: 'delta', content: msg.content });
    }
    if (!msg.tool_calls?.length) break;
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      onEvent({ type: 'tool_start', name });
      let result;
      try { result = await runTool(conversationId, name, args); }
      catch (err) { result = JSON.stringify({ error: err.message }); }
      onEvent({ type: 'tool_result', name, content: result.slice(0, 2000) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  if (!finalText.trim()) finalText = 'Concluído.';
  saveMessage(conversationId, 'assistant', finalText);
  return finalText;
}

export function saveMessage(conversationId, role, content) {
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)')
    .run(nanoid(), conversationId, role, content, now());
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), conversationId);
}
