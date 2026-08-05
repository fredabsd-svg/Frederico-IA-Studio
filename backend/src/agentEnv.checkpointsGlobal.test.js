// F-26: cota global de checkpoints por usuário. Cobre a função pura
// `pruneCheckpointsGlobal` sem precisar de DB nem do backend completo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneCheckpointsGlobal, createCheckpoint } from './agentEnv.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fred-checkpoints-'));
}

// Escreve um checkpoint fake no formato esperado pela função. Não usa
// createCheckpoint porque isso já invoca a poda global — aqui queremos
// controlar o estado de fora pra testar a função isoladamente.
function fakeCheckpoint(convDir, id, isoDate, bytes) {
  fs.mkdirSync(path.join(convDir, id, 'dados'), { recursive: true });
  fs.writeFileSync(path.join(convDir, id, 'meta.json'), JSON.stringify({
    id,
    criado_em: isoDate,
    rotulo: '',
    motivo: 'test',
    arquivos: 1,
    bytes,
    ignorados_por_seguranca_ou_peso: [],
    hashes: { 'foo.txt': 'abc' }
  }));
  // Cria um arquivo dummy do tamanho declarado pra que `du` bata com a meta.
  // Importante: a função usa o `bytes` do META, não do disco, então o tamanho
  // do dummy é cosmético — só não pode estar vazio.
  fs.writeFileSync(path.join(convDir, id, 'dados', 'foo.txt'), 'x');
}

test('sem cota configurada (maxBytes=0): nada é podado', () => {
  const root = tmpdir();
  try {
    const convDir = path.join(root, 'c1');
    fakeCheckpoint(convDir, 'cp1', '2026-01-01T00:00:00Z', 1_000_000_000);
    const r = pruneCheckpointsGlobal(root, { maxBytes: 0 });
    assert.equal(r.reason, 'cota-desligada');
    assert.equal(r.removed, 0);
    assert.ok(fs.existsSync(path.join(convDir, 'cp1')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('abaixo da cota: nenhum checkpoint é removido', () => {
  const root = tmpdir();
  try {
    const convDir = path.join(root, 'c1');
    fakeCheckpoint(convDir, 'cp1', '2026-01-01T00:00:00Z', 100);
    fakeCheckpoint(convDir, 'cp2', '2026-02-01T00:00:00Z', 200);
    const r = pruneCheckpointsGlobal(root, { maxBytes: 1000 });
    assert.equal(r.removed, 0);
    assert.equal(r.totalBytes, 300);
    assert.ok(fs.existsSync(path.join(convDir, 'cp1')));
    assert.ok(fs.existsSync(path.join(convDir, 'cp2')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('acima da cota: remove do mais antigo para o mais novo', () => {
  const root = tmpdir();
  try {
    const convDir = path.join(root, 'c1');
    fakeCheckpoint(convDir, 'cp_old', '2026-01-01T00:00:00Z', 600);
    fakeCheckpoint(convDir, 'cp_mid', '2026-02-01T00:00:00Z', 600);
    fakeCheckpoint(convDir, 'cp_new', '2026-03-01T00:00:00Z', 600);
    // Teto 1000 — precisa remover até sobrar <= 1000. cp_old (600) sai
    // primeiro; ainda passa (600+600=1200), sai cp_mid (600); ainda passa
    // (600 <= 1000). Sobram cp_new só.
    const r = pruneCheckpointsGlobal(root, { maxBytes: 1000 });
    assert.equal(r.removed, 2);
    assert.equal(r.totalBytes, 600);
    assert.ok(!fs.existsSync(path.join(convDir, 'cp_old')), 'cp_old deve ter sido removido');
    assert.ok(!fs.existsSync(path.join(convDir, 'cp_mid')), 'cp_mid deve ter sido removido');
    assert.ok(fs.existsSync(path.join(convDir, 'cp_new')), 'cp_new (mais novo) deve ter sobrado');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('protege o ÚLTIMO checkpoint de cada conversa (piso per-conversa)', () => {
  // Sem esta proteção, a quota global poderia apagar o ÚNICO checkpoint da
  // conversa A para liberar espaço para a conversa B — e a retomada de A
  // deixaria de existir. Aqui A tem 1 checkpoint, B tem 3; cota global
  // alta só permite 1; A deve sobreviver porque é o ÚNICO dela.
  const root = tmpdir();
  try {
    const aDir = path.join(root, 'a');
    const bDir = path.join(root, 'b');
    fakeCheckpoint(aDir, 'cp_a_only', '2026-01-01T00:00:00Z', 1000);
    fakeCheckpoint(bDir, 'cp_b_old', '2026-02-01T00:00:00Z', 100);
    fakeCheckpoint(bDir, 'cp_b_mid', '2026-03-01T00:00:00Z', 100);
    fakeCheckpoint(bDir, 'cp_b_new', '2026-04-01T00:00:00Z', 100);
    // Cota 500: cp_b_old e cp_b_mid saem; cp_b_new sobra; cp_a_only fica
    // (é o único da conversa A — intocável).
    const r = pruneCheckpointsGlobal(root, { maxBytes: 500 });
    assert.ok(fs.existsSync(path.join(aDir, 'cp_a_only')), 'cp_a_only deve ter sido preservado');
    assert.ok(fs.existsSync(path.join(bDir, 'cp_b_new')), 'cp_b_new deve ter sobrado');
    assert.ok(!fs.existsSync(path.join(bDir, 'cp_b_old')));
    assert.ok(!fs.existsSync(path.join(bDir, 'cp_b_mid')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('skipDirName protege um checkpoint recém-criado de ser podado na mesma passada', () => {
  // Cenário: createCheckpoint acabou de gravar em `c1`; queremos garantir que
  // a passada de poda NÃO olha para essa pasta (o checkpoint recém-criado
  // não tem metadado confiável ainda — mas a proteção é mais simples:
  // pular a conversa INTEIRA significa que se o usuário estourou a cota, a
  // única coisa que não é candidata a remoção é a conversa que acabou de
  // criar checkpoint).
  const root = tmpdir();
  try {
    const c1 = path.join(root, 'c1');
    const c2 = path.join(root, 'c2');
    // c1: só o recém-criado (skip alvo). c2: 2 checkpoints velhos.
    fakeCheckpoint(c1, 'cp_novo', '2026-06-01T00:00:00Z', 1000);
    fakeCheckpoint(c2, 'cp2_old', '2026-01-01T00:00:00Z', 600);
    fakeCheckpoint(c2, 'cp2_new', '2026-02-01T00:00:00Z', 600);
    const r = pruneCheckpointsGlobal(root, { maxBytes: 500, skipDirName: 'c1' });
    assert.ok(fs.existsSync(path.join(c1, 'cp_novo')), 'c1 não deve ser tocado quando skipDirName=c1');
    // c2 está acima da cota — o mais antigo sai.
    assert.ok(!fs.existsSync(path.join(c2, 'cp2_old')), 'cp2_old deve ter sido removido');
    assert.ok(fs.existsSync(path.join(c2, 'cp2_new')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('suma checkpoints de TODAS as conversas do usuário', () => {
  const root = tmpdir();
  try {
    // 3 conversas, 3 checkpoints cada (assim o piso per-conversa não trava
    // a poda enquanto há mais antigos para remover).
    for (let i = 0; i < 3; i++) {
      const conv = path.join(root, `c${i}`);
      fakeCheckpoint(conv, `cp${i}_a`, `2026-0${i + 1}-01T00:00:00Z`, 300);
      fakeCheckpoint(conv, `cp${i}_b`, `2026-0${i + 1}-10T00:00:00Z`, 300);
      fakeCheckpoint(conv, `cp${i}_c`, `2026-0${i + 1}-20T00:00:00Z`, 300);
    }
    // Total 2700; cota 1000. Tem que remover até sobrar <= 1000. Como cada
    // conversa tem 3 checkpoints e o piso é 1, sobra espaço para podar até 2
    // por conversa — 2 por conversa × 3 conversas = 6 remoções no total.
    const r = pruneCheckpointsGlobal(root, { maxBytes: 1000 });
    assert.equal(r.removed, 6);
    assert.ok(r.totalBytes <= 1000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
