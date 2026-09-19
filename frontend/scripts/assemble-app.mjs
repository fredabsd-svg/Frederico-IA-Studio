#!/usr/bin/env node
/**
 * Monta frontend/src/App.jsx a partir de frontend/src/app_assembly/part*.txt.
 * Usado só quando o App.jsx monolítico não cabe no payload do MCP; o resultado
 * montado É o App.jsx canônico versionado após `npm run assemble:app` no CI/local.
 * Prefira editar App.jsx direto quando o push monolítico for possível.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const partsDir = path.join(root, 'src', 'app_assembly');
const outFile = path.join(root, 'src', 'App.jsx');

const parts = fs.readdirSync(partsDir)
  .filter((f) => /^part\d+\.txt$/.test(f))
  .sort();
if (!parts.length) {
  console.error('assemble-app: nenhuma part*.txt em', partsDir);
  process.exit(1);
}
const content = parts.map((f) => fs.readFileSync(path.join(partsDir, f), 'utf8')).join('');
if (!content.includes('export default function App') || !content.includes('seedDeveloperSessionFromActive')) {
  console.error('assemble-app: conteúdo montado não parece o App com wiring Dev');
  process.exit(1);
}
fs.writeFileSync(outFile, content);
console.log(`assemble-app: ${parts.length} partes → App.jsx (${content.length} chars)`);
