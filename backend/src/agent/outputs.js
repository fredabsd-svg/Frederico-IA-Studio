// Arquivos de saída da conversa (/workspace/outputs): listagem, recuperação de
// caminhos alternativos, detecção de referências no texto da resposta e
// validação automática dos arquivos gerados.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import fs from 'fs';
import path from 'path';
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
export async function validateOutputs(conversationId, files, onEvent, sandboxOptions = {}) {
  const targets = pickValidatableFiles(files, 5);
  if (!targets.length) return {};
  onEvent({ type: 'status', content: 'Validando arquivos gerados...' });
  const listJson = JSON.stringify(targets.map(f => f.path));
  const code = `import json, os, subprocess, tempfile, shutil, zipfile, re
files = json.loads('''${listJson}''')
ERRS = ("#REF!", "#VALUE!", "#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#SPILL!", "#CALC!")
MAX_CELLS = int(os.environ.get("VALIDATE_MAX_CELLS", "40000"))
RECALC_ENABLED = os.environ.get("VALIDATE_RECALC", "true").lower() == "true"
RECALC_TIMEOUT = int(os.environ.get("SANDBOX_RECALC_TIMEOUT_S", "25"))
RECALC_MAX_FILES = int(os.environ.get("RECALC_MAX_FILES", "2"))
_recalc_budget = [RECALC_MAX_FILES]

def scan_errors(wb, cap):
    errs = scanned = 0
    capped = False
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if scanned >= cap:
                    capped = True
                    break
                v = c.value
                if v is not None:
                    scanned += 1
                if isinstance(v, str) and any(e in v for e in ERRS):
                    errs += 1
            if capped:
                break
        if capped:
            break
    return errs, capped

def recalc(path):
    tmp = tempfile.mkdtemp(prefix="lo_recalc_")
    prof = os.path.join(tmp, "profile", "user")
    os.makedirs(prof, exist_ok=True)
    with open(os.path.join(prof, "registrymodifications.xcu"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>'
                '<oor:items xmlns:oor="http://openoffice.org/2001/registry" '
                'xmlns:xs="http://www.w3.org/2001/XMLSchema" '
                'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
                '<item oor:path="/org.openoffice.Office.Calc/Formula/Load">'
                '<prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>'
                '<item oor:path="/org.openoffice.Office.Calc/Formula/Load">'
                '<prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>'
                '</oor:items>')
    outdir = os.path.join(tmp, "out")
    os.makedirs(outdir, exist_ok=True)
    try:
        subprocess.run(["soffice", "-env:UserInstallation=file://" + os.path.join(tmp, "profile"),
                        "--headless", "--calc", "--convert-to", "xlsx:Calc MS Excel 2007 XML",
                        "--outdir", outdir, path],
                       timeout=RECALC_TIMEOUT, capture_output=True, check=False)
    except Exception:
        return None, tmp
    cand = os.path.join(outdir, os.path.splitext(os.path.basename(path))[0] + ".xlsx")
    return (cand if os.path.exists(cand) else None), tmp

def recalc_took(orig, calc):
    keys = set()
    for ws in orig.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and c.value.startswith("="):
                    keys.add((ws.title, c.coordinate))
                    if len(keys) > 40:
                        break
            if len(keys) > 40:
                break
        if len(keys) > 40:
            break
    if not keys:
        return True
    for ws in calc.worksheets:
        for row in ws.iter_rows():
            for c in row:
                # Qualquer valor em cache (número OU string de erro tipo #DIV/0!)
                # prova que o recálculo aconteceu. Antes exigia só numérico, o
                # que descartava o recálculo quando TODAS as fórmulas viravam
                # erro — exatamente o caso que mais precisamos detectar.
                if (ws.title, c.coordinate) in keys and c.value is not None:
                    return True
    return False

def _col_to_num(col):
    n = 0
    for ch in col.upper():
        n = n * 26 + (ord(ch) - 64)
    return n

def _parse_ref(ref):
    m = re.match(r"^(?:'([^']+)'|([^!]+))!(.+)$", ref.strip())
    if not m:
        return None
    sheet = m.group(1) or m.group(2)
    rng = m.group(3).replace("$", "")
    cells = rng.split(":")
    def cell(c):
        mm = re.match(r"^([A-Za-z]+)(\\d+)$", c)
        return (_col_to_num(mm.group(1)), int(mm.group(2))) if mm else None
    a = cell(cells[0])
    b = cell(cells[-1]) if len(cells) > 1 else a
    if not a or not b:
        return (sheet, None)
    return (sheet, (a[0], a[1], b[0], b[1]))

def _range_has_number(wb, sheet, coords):
    # True se houver ao menos uma célula NUMÉRICA no intervalo. Usado para pegar
    # gráfico cuja série de VALORES aponta para um intervalo sem números (ex.:
    # coluna "Total" declarada no cabeçalho mas deixada vazia pelo modelo).
    try:
        ws = wb[sheet]
    except Exception:
        return True  # na dúvida, não acusa
    c1, r1, c2, r2 = coords
    for r in range(r1, r2 + 1):
        for c in range(c1, c2 + 1):
            v = ws.cell(row=r, column=c).value
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return True
            if isinstance(v, str) and v.startswith("="):
                return True  # fórmula: assume que produz número
    return False

def check_charts(p, wb):
    # Valida os GRÁFICOS do .xlsx (openpyxl descarta charts ao carregar, então
    # lemos o XML direto do zip). Modelos geram gráficos com referências
    # quebradas — intervalos INVERTIDOS (ex.: C2:B2), aba inexistente, sem série
    # ou uma série de VALORES apontando para um intervalo vazio (coluna sem
    # dados) — que abririam vazios/errados no Excel, e nada verificava isso.
    sheetnames = wb.sheetnames
    problems = []
    n = 0
    try:
        z = zipfile.ZipFile(p)
    except Exception:
        return 0, problems
    for cn in [x for x in z.namelist() if re.match(r"xl/charts/chart\\d+\\.xml", x)]:
        n += 1
        try:
            xml = z.read(cn).decode("utf-8", "replace")
        except Exception:
            continue
        refs = re.findall(r"<(?:\\w+:)?f>([^<]+)</(?:\\w+:)?f>", xml)
        sers = len(re.findall(r"<(?:\\w+:)?ser>", xml))
        # referências que são SÉRIE DE VALORES (dentro de <val>...</val>) — só
        # essas precisam ter números; categorias podem ser texto.
        val_refs = []
        for blk in re.findall(r"<(?:\\w+:)?val>(.*?)</(?:\\w+:)?val>", xml, re.S):
            val_refs += re.findall(r"<(?:\\w+:)?f>([^<]+)</(?:\\w+:)?f>", blk)
        if not refs:
            problems.append("grafico sem referencias de dados")
            continue
        if sers == 0:
            problems.append("grafico sem series")
        for ref in refs:
            parsed = _parse_ref(ref)
            if not parsed:
                continue
            sheet, coords = parsed
            if sheet not in sheetnames:
                problems.append("grafico referencia aba inexistente '" + sheet + "'")
                continue
            if coords:
                c1, r1, c2, r2 = coords
                if c1 > c2 or r1 > r2:
                    problems.append("grafico com intervalo invertido/degenerado (" + ref + ")")
                    continue
                if ref in val_refs and not _range_has_number(wb, sheet, coords):
                    problems.append("grafico com serie de valores vazia (" + ref + ")")
    return n, problems

def check_xlsx(p):
    from openpyxl import load_workbook
    wb = load_workbook(p)
    sheets = len(wb.sheetnames)
    errs_lint, capped = scan_errors(wb, MAX_CELLS)
    errs_calc = 0
    did_recalc = False
    if RECALC_ENABLED and _recalc_budget[0] > 0:
        _recalc_budget[0] -= 1
        calc_path, tmp = recalc(p)
        try:
            if calc_path:
                calc_wb = load_workbook(calc_path, data_only=True)
                if recalc_took(wb, calc_wb):
                    did_recalc = True
                    errs_calc, _ = scan_errors(calc_wb, MAX_CELLS)
        except Exception:
            pass
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    total = errs_lint + errs_calc
    chart_n, chart_problems = check_charts(p, wb)
    parts = [str(sheets) + " abas"]
    if total:
        parts.append(str(total) + " celula(s) com erro de formula")
    elif did_recalc:
        parts.append("formulas recalculadas: sem erros")
    else:
        parts.append("formulas NAO recalculadas (verificacao parcial)")
    if chart_problems:
        parts.append(str(len(chart_problems)) + " problema(s) em grafico: " + chart_problems[0])
    elif chart_n:
        parts.append(str(chart_n) + " grafico(s) ok")
    if capped:
        parts.append("varredura limitada a " + str(MAX_CELLS) + " celulas")
    return {"ok": total == 0 and not chart_problems, "info": "; ".join(parts)}

def check_docx(p):
    from docx import Document
    d = Document(p)
    n_par = len([x for x in d.paragraphs if x.text.strip()])
    empty = (n_par == 0 and len(d.tables) == 0 and len(d.inline_shapes) == 0)
    return {"ok": not empty, "info": str(len(d.paragraphs)) + " paragrafos, " + str(len(d.tables)) + " tabelas" + (" - documento vazio" if empty else "")}

out = []
for rel in files:
    p = "/workspace/" + rel
    r = {"path": rel, "ok": True, "info": ""}
    try:
        ext = rel.lower().rsplit(".", 1)[-1]
        if ext in ("xlsx", "xlsm"):
            r.update(check_xlsx(p))
        elif ext == "pdf":
            from pypdf import PdfReader
            n = len(PdfReader(p).pages)
            r["info"] = str(n) + " paginas"
            r["ok"] = n > 0
        elif ext == "docx":
            r.update(check_docx(p))
    except Exception as e:
        r["ok"] = False
        r["info"] = ("nao abre: " + str(e))[:120]
    out.append(r)
print(json.dumps(out))`;
  try {
    const raw = await runTool(conversationId, 'run_python', { code }, sandboxOptions, { timeoutMs: VALIDATE_TIMEOUT_MS });
    const r = JSON.parse(raw);
    if (r.exitCode !== 0) return {};
    const line = String(r.output || '').trim().split('\n').pop();
    return Object.fromEntries(JSON.parse(line).map(x => [x.path, { ok: x.ok, info: x.info }]));
  } catch { return {}; }
}
