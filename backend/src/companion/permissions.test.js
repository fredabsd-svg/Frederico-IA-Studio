import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilitiesForLevel, resolveCapabilities, decide, isDestructiveCommand, SENSITIVE } from './permissions.js';

test('capabilitiesForLevel acumula dos níveis inferiores', () => {
  const l1 = capabilitiesForLevel(1);
  assert.ok(l1.includes('observar') && l1.includes('ler_arquivos'));
  assert.ok(!l1.includes('executar_seguros'));
  const l3 = capabilitiesForLevel(3);
  assert.ok(l3.includes('executar_seguros') && l3.includes('ler_arquivos'));
  const l5 = capabilitiesForLevel(5);
  assert.ok(l5.includes('excluir_arquivos'));
});

test('resolveCapabilities aplica grant/revoke', () => {
  const caps = resolveCapabilities({ level: 1, grant: ['executar_seguros'], revoke: ['ler_arquivos'] });
  assert.ok(caps.includes('executar_seguros'));
  assert.ok(!caps.includes('ler_arquivos'));
});

test('parada de emergência bloqueia tudo', () => {
  const d = decide({ level: 5, emergencyStop: true }, 'ler_arquivos');
  assert.equal(d.allowed, false);
  assert.match(d.reason, /emerg/i);
});

test('modo somente-leitura bloqueia escrita, permite leitura', () => {
  assert.equal(decide({ level: 5, readOnly: true }, 'editar_arquivos').allowed, false);
  assert.equal(decide({ level: 5, readOnly: true }, 'ler_arquivos').allowed, true);
});

test('capacidade acima do nível pede autorização', () => {
  const d = decide({ level: 1 }, 'instalar_deps');
  assert.equal(d.allowed, false);
  assert.equal(d.requiresConfirmation, true);
});

test('capacidade sensível dentro do nível ainda exige confirmação', () => {
  const d = decide({ level: 5 }, 'excluir_arquivos');
  assert.equal(d.allowed, true);
  assert.equal(d.requiresConfirmation, true);
  assert.ok(SENSITIVE.has('excluir_arquivos'));
});

test('criar rotina exige nível 3 e confirmação explícita', () => {
  const low = decide({ level: 1, grant: [], revoke: [] }, 'criar_rotinas');
  assert.equal(low.allowed, false);
  const allowed = decide({ level: 3, grant: [], revoke: [] }, 'criar_rotinas');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.requiresConfirmation, true);
});

test('comando destrutivo exige confirmação; blockList bloqueia', () => {
  assert.ok(isDestructiveCommand('rm -rf /'));
  const d = decide({ level: 5 }, 'executar_seguros', { command: 'rm -rf build' });
  assert.equal(d.requiresConfirmation, true);
  const b = decide({ level: 5 }, 'executar_seguros', { command: 'curl http://evil' , blockList: undefined });
  // blockList vazio: comando não-destrutivo passa
  assert.equal(b.allowed, true);
  const blocked = decide({ level: 5, blockList: ['curl'] }, 'executar_seguros', { command: 'curl http://x' });
  assert.equal(blocked.allowed, false);
});

test('ação simples dentro do nível é permitida sem confirmação', () => {
  const d = decide({ level: 3 }, 'executar_seguros', { command: 'npm test' });
  assert.equal(d.allowed, true);
  assert.equal(d.requiresConfirmation, false);
});
