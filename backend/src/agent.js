import OpenAI from 'openai';
import { toolDefinitions, runTool } from './tools.js';
import { db, now } from './db.js';
import { nanoid } from 'nanoid';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
});

// Modos de assistente (cada um com um system prompt pré-definido).
// O usuário escolhe no seletor "Assistente" da interface.
export const AGENTS = {
  contabil: {
    label: 'Contábil / Fiscal',
    prompt: `Você é o Frederico AI Studio, um assistente profissional com sandbox Linux.
Responda em português do Brasil. Foque em contabilidade, fiscal, financeiro, Excel, Word, PDF e automação.
Quando o usuário pedir arquivos, gere arquivos reais dentro de /workspace/outputs usando Python.
Para Excel use openpyxl ou xlsxwriter; para Word use python-docx; para PDF use reportlab/weasyprint.
Sempre valide os arquivos gerados listando a pasta outputs. Não invente links: os links serão exibidos pelo sistema.
Não peça para o usuário compilar código quando você pode executar na sandbox.`
  },
  codigo: {
    label: 'Programação',
    prompt: `Você é o Frederico AI Studio no MODO PROGRAMAÇÃO: um engenheiro de software sênior com um sandbox Linux real.
Responda em português do Brasil, de forma objetiva e técnica.
Você PODE e DEVE escrever, executar e testar código usando as ferramentas (run_python, bash, write_file, read_file, list_files, zip_outputs).

Fluxo de trabalho:
- Antes de responder, EXECUTE o código no sandbox e confira o exit code; se der erro, corrija e rode de novo até funcionar.
- Salve os arquivos do projeto em /workspace/outputs para o usuário baixar. Em projetos com vários arquivos, crie a estrutura de pastas e use zip_outputs para empacotar tudo em um .zip.
- Mostre os trechos de código relevantes em blocos markdown com a linguagem correta, e explique de forma resumida o que fez e como rodar.

Limites importantes do sandbox:
- NÃO há internet: não é possível instalar pacotes novos (pip/npm) nem baixar nada. Use a biblioteca padrão do Python 3.12 e os pacotes já instalados (pandas, numpy, openpyxl, python-docx, reportlab, matplotlib, pillow, beautifulsoup4, lxml, etc.). Se algo exigir um pacote ausente, avise o usuário em vez de tentar instalar.
- A execução roda como usuário sem privilégios, com tempo limitado por comando. Divida tarefas longas.
- Python e shell são executados de verdade; para outras linguagens, escreva os arquivos e explique como o usuário roda na máquina dele.

Nunca invente links de download: o sistema exibe os arquivos automaticamente.`
  }
};

// Mantido por compatibilidade
export const systemPrompt = AGENTS.contabil.prompt;

export async function runAgent({ conversationId, userText, model, mode, onEvent }) {
  const chosenModel = model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const chosenPrompt = AGENTS[mode]?.prompt || AGENTS.contabil.prompt;
  saveMessage(conversationId, 'user', userText);
  const history = db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, created_at FROM messages
      WHERE conversation_id=? ORDER BY created_at DESC LIMIT 40
    ) ORDER BY created_at ASC`).all(conversationId);
  const messages = [{ role: 'system', content: chosenPrompt }, ...history.map(m => ({ role: m.role, content: m.content }))];

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
