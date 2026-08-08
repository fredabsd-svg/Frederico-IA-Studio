// Arquivos de saída da conversa (/workspace/outputs): listagem, recuperação de
// caminhos alternativos, detecção de referências no texto da resposta e
// validação automática dos arquivos gerados.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runTool } from '../tools.js';
import { execInSandbox, realInside, workspaceFor } from '../sandbox.js';

// Lista os arquivos da pasta outputs (para detectar os que foram gerados)
export function listOutputs(userId, conversationId) {
  const ws = workspaceFor(conversationId, userId);
  const acc = [];
  const walk = (dir) => { try { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, d.name); d.isDirectory() ? walk(full) : acc.push(full); } } catch {} };
  walk(ws.outputs);
  return acc.flatMap(f => {
    try {
      if (!realInside(ws.base, f)) return [];
      const st = fs.statSync(f);
      if (!st.isFile()) return [];
      return [{ path: path.relative(ws.base, f).replaceAll('\\', '/'), name: path.basename(f), size: st.size, mtimeMs: st.mtimeMs }];
    } catch {
      return [];
    }
  });
}

export function mentionsOutputPath(text) {
  return /(?:sandbox:)?(?:\/workspace\/|\/mnt\/user-data\/)?outputs\//i.test(String(text || ''));
}

export async function recoverAlternateOutputs(conversationId, sandboxOptions = {}) {
  const script = [
    'mkdir -p /workspace/outputs',
    'target="$(readlink -f /workspace/outputs)"',
    'for d in /mnt/user-data/outputs /mnt/data/outputs /mnt/data; do',
    '  [ -d "$d" ] || continue',
    '  src="$(readlink -f "$d" 2>/dev/null || true)"',
    '  [ "$src" = "$target" ] && continue',
    '  find "$d" -maxdepth 1 -type f -print0 | while IFS= read -r -d "" f; do cp -f "$f" "/workspace/outputs/$(basename "$f")"; done',
    'done'
  ].join('\n');
  try { await execInSandbox(conversationId, script, 15000, sandboxOptions); } catch {}
}

export function referencedOutputFiles(text, files) {
  const byPath = new Map(files.map(f => [String(f.path || '').toLowerCase(), f]));
  const byName = new Map(files.map(f => [String(f.name || '').toLowerCase(), f]));
  const picked = new Map();
  const re = /(?:sandbox:)?(?:\/workspace\/|\/mnt\/user-data\/)?outputs\/([^\)\]\n\r]+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const claimed = String(m[1] || '').trim()
      .replace(/[\u0060"'*.,;:!?]+$/, '')
      .replace(/^[/\\]+/, '')
      .replaceAll('\\', '/');
    let rel = `outputs/${claimed}`;
    try { rel = decodeURI(rel); } catch {}
    rel = rel.replace(/^outputs\/outputs\//i, 'outputs/');
    const found = byPath.get(rel.toLowerCase()) || byName.get(path.basename(rel).toLowerCase());
    if (found) picked.set(found.path, found);
  }
  return [...picked.values()];
}

// Assinatura de um arquivo de saída para detectar "novo/alterado nesta resposta".
// Usa mtime E tamanho: só o mtime falha quando o modelo REGENERA um arquivo com
// o MESMO nome e o sistema de arquivos tem granularidade grosseira de mtime —
// aí o arquivo novo não era detectado (falso "não gerado"). O tamanho quase
// sempre difere numa regeneração, cobrindo esse caso.
export function fileSignature(file) {
  return `${file?.mtimeMs}:${file?.size}`;
}

// Valida automaticamente os arquivos gerados (abre? abas? erros de fórmula?).
// IMPORTANTE: para .xlsx/.xlsm, o openpyxl lê a STRING da fórmula, não o valor
// calculado — e um arquivo recém-gerado não tem valor em cache. Por isso, sem
// recálculo, um #REF!/#DIV/0! NUNCA aparecia e a validação dava um "ok" falso.
// Aqui recalculamos com o LibreOffice (headless, com recálculo-ao-abrir) para
// materializar os valores e detectar erros de verdade; além disso fazemos um
// "lint" das strings de fórmula (pega referências quebradas como =#REF!*2) e
// varremos os valores literais. Se o recálculo não estiver disponível, a
// verificação é rotulada como PARCIAL — nunca mais alegamos "sem erros" sem ter
// de fato recalculado.
const VALIDATABLE = /\.(xlsx|xlsm|pdf|docx)$/i;
const VALIDATE_TIMEOUT_MS = Math.max(15000, Number(process.env.VALIDATE_TIMEOUT_MS || 60000));

// Seleciona os arquivos VALIDÁVEIS a partir da lista de outputs. Limite
// conservador: validar 5 planilhas grandes custa ~30s e a maioria das
// respostas gera 1-2 arquivos. Pura e testável — separada para poder
// cobrir o filtro de extensão sem precisar do sandbox.
//
// Edge cases cobertos:
//   - entradas sem `name`: ignoradas (não há como decidir o tipo)
//   - extensões em CAIXA ALTA: `.XLSX`, `.Pdf` etc. — valem
//   - extensões compostas (`.xlsx.bak`, `.tar.gz`): NÃO valem (regex é
//     ancorado no fim do nome)
//   - arquivos em subpastas (`.outputs/sub/x.xlsx`): o `name` é só o
//     basename, então a regex casa corretamente
export function pickValidatableFiles(files, limit = 5) {
  if (!Array.isArray(files)) return [];
  return files.filter(f => f && typeof f.name === 'string' && VALIDATABLE.test(f.name)).slice(0, limit);
}
// O validador dos artefatos é Python e mora em `sandbox/validar_artefato.py`,
// não aqui dentro. Ele já foi 233 linhas de Python numa template string deste
// arquivo — onde nenhum teste alcançava, que é o que o F-23 da auditoria
// apontava. Como arquivo, ele é exercitado com .xlsx/.docx/.pdf de verdade por
// `sandbox/validar_artefato_test.py`.
//
// O backend LÊ o arquivo e manda o texto para o `run_python`; quem executa é o
// sandbox. Por isso o `Dockerfile` copia esse .py para a imagem do backend —
// sem ele, a validação não roda. `outputs.validatorSeam.test.js` é a catraca
// que cobra o caminho, para um rename falhar no CI em vez de em produção.
const VALIDATOR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sandbox', 'validar_artefato.py');
let _validatorSource = null;
export function validatorSource() {
  // Lê uma vez e guarda: o arquivo não muda em tempo de execução. A leitura é
  // preguiçosa (e não no import) para o backend não deixar de subir por causa
  // dela — mas o erro é ALTO, porque validação que some em silêncio é o defeito
  // do F-10 de volta: a entrega diria "verificado" sem ter verificado nada.
  if (_validatorSource === null) _validatorSource = fs.readFileSync(VALIDATOR_PATH, 'utf8');
  return _validatorSource;
}
export const _validatorPathForTests = VALIDATOR_PATH;

export async function validateOutputs(conversationId, files, onEvent, sandboxOptions = {}) {
  const targets = pickValidatableFiles(files, 5);
  if (!targets.length) return {};
  onEvent({ type: 'status', content: 'Validando arquivos gerados...' });
  const listJson = JSON.stringify(targets.map(f => f.path));
  const code = `${validatorSource()}
print(json.dumps(validar(json.loads('''${listJson}'''))))`;
  try {
    const raw = await runTool(conversationId, 'run_python', { code }, sandboxOptions, { timeoutMs: VALIDATE_TIMEOUT_MS });
    const r = JSON.parse(raw);
    if (r.exitCode !== 0) return {};
    const line = String(r.output || '').trim().split('\n').pop();
    return Object.fromEntries(JSON.parse(line).map(x => [x.path, { ok: x.ok, info: x.info }]));
  } catch { return {}; }
}
