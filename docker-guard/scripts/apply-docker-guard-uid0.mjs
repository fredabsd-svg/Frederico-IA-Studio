#!/usr/bin/env node
// WHY: User "0"/"0:0" is numeric root — string "root" alone left F-04 exec hole.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const polPath = path.join(root, 'docker-guard/src/policy.js');
const testPath = path.join(root, 'docker-guard/src/policy.test.js');
let pol = fs.readFileSync(polPath, 'utf8');
let test = fs.readFileSync(testPath, 'utf8');
if (pol.includes('isRootExecUser')) { console.log('policy já corrigida'); process.exit(0); }
const old = `// Exec: o container já é do app (posse conferida). Só barramos escalada.
export function validateExec(body) {
  if (body && body.Privileged) return deny('exec Privileged não é permitido');
  if (body && String(body.User || '') === 'root') return deny('exec como root não é permitido');
  return { allow: true };
}
`;
const neu = `// Exec: o container já é do app (posse conferida). Só barramos escalada.
// WHY: \`User: "0"\` / \`"0:0"\` é root numérico — barrar só a string "root"
// deixava a fuga F-04 por exec. UID 0 (com ou sem grupo) é recusado.
export function isRootExecUser(user) {
  const raw = String(user || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'root' || raw.startsWith('root:')) return true;
  const uid = raw.split(':')[0];
  return uid === '0';
}

export function validateExec(body) {
  if (body && body.Privileged) return deny('exec Privileged não é permitido');
  if (body && isRootExecUser(body.User)) return deny('exec como root não é permitido');
  return { allow: true };
}
`;
if (!pol.includes(old)) throw new Error('policy âncora ausente');
pol = pol.replace(old, neu);
const oldT = `test('exec privilegiado ou como root é recusado', () => {
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { Privileged: true } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: 'root' } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: 'sandbox' } }, limits).allow, true);
});
`;
const neuT = `test('exec privilegiado ou como root é recusado', () => {
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { Privileged: true } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: 'root' } }, limits).allow, false);
  // WHY: UID 0 numérico (e root:grupo) também é root — não só a string "root".
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: '0' } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: '0:0' } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: 'root:root' } }, limits).allow, false);
  assert.equal(evaluateRequest({ method: 'POST', path: '/containers/abc/exec', body: { User: 'sandbox' } }, limits).allow, true);
});
`;
if (!test.includes(oldT)) throw new Error('test âncora ausente');
test = test.replace(oldT, neuT);
fs.writeFileSync(polPath, pol);
fs.writeFileSync(testPath, test);
console.log('OK: docker-guard uid0 + testes');
