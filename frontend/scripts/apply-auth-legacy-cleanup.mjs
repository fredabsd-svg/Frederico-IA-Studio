#!/usr/bin/env node
// Remove o rastro de APP_PASSWORD /api/login do App.jsx (Better Auth é o único
// caminho). MCP não republica o monolito ~115 KB — rode com git local:
//   node frontend/scripts/apply-auth-legacy-cleanup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appPath = path.join(root, 'frontend/src/App.jsx');
let src = fs.readFileSync(appPath, 'utf8');
const before = src;

const removals = [
  [
    /  const \[unprotected, setUnprotected\] = useState\(false\);\n/,
    '',
  ],
  [
    /  const \[authWarnHidden, setAuthWarnHidden\] = useState\(\(\) => localStorage\.getItem\('fred_authwarn_hidden'\) === '1'\);\n/,
    '',
  ],
  [
    /  const \[password, setPassword\] = useState\(''\);\n/,
    '',
  ],
  [
    /  const \[loginError, setLoginError\] = useState\(''\);\n/,
    '',
  ],
  [
    /      try \{ const h = await \(await fetch\(`\$\{API\}\/api\/health`\)\)\.json\(\); setUnprotected\(h && h\.auth === false\); \} catch \{\}\n/,
    '      try { await (await fetch(`${API}/api/health`)).json(); } catch {}\n',
  ],
  [
    /\n  async function doLogin\(e\) \{\n    e\?\.preventDefault\(\);\n    setLoginError\(''\);\n    try \{\n      const res = await fetch\(`\$\{API\}\/api\/login`, \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ password \}\) \}\);\n      const data = await res\.json\(\)\.catch\(\(\) => \(\{\}\)\);\n      if \(!res\.ok\) \{ setLoginError\(data\.error \|\| 'Senha incorreta\.'\); return; \}\n      setPassword\(''\);\n      setNeedLogin\(false\);\n      init\(\);\n    \} catch \{\n      setLoginError\('Não foi possível conectar ao servidor\.'\);\n    \}\n  \}\n/,
    '\n  // WHY: /api/login e APP_PASSWORD foram removidos — sessão só via Better Auth (AuthGate).\n',
  ],
  [
    /      \{unprotected && !authWarnHidden && <div className="authWarn">\n        <span>🔓 <b>Sem senha de acesso\.<\/b> Use apenas na sua rede local — não exponha na internet sem definir <code>APP_PASSWORD<\/code>\.<\/span>\n        <button onClick=\{\(\) => \{ setAuthWarnHidden\(true\); localStorage\.setItem\('fred_authwarn_hidden', '1'\); \}\} aria-label="Dispensar aviso"><X size=\{14\}\/><\/button>\n      <\/div>\}\n/,
    '',
  ],
];

let applied = 0;
for (const [re, rep] of removals) {
  if (!re.test(src)) {
    console.warn('âncora não encontrada (já aplicado?):', re.toString().slice(0, 80));
    continue;
  }
  src = src.replace(re, rep);
  applied++;
}

if (src === before) {
  console.log('Nada a fazer — App.jsx já sem legado APP_PASSWORD/api/login.');
  process.exit(0);
}
fs.writeFileSync(appPath, src);
console.log(`OK: ${applied} edição(ões) em frontend/src/App.jsx`);
