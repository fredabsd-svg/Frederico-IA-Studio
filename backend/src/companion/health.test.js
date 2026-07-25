import assert from 'node:assert/strict';
import test from 'node:test';
import { detectMemoryTrend, collectHealth } from './health.js';

const MB = 1024 * 1024;
const HOUR = 3_600_000;

test('detectMemoryTrend: memória estável não acusa vazamento', () => {
  const now = 10 * HOUR;
  const samples = Array.from({ length: 12 }, (_, i) => ({ t: now - (12 - i) * 5 * 60_000, rss: 200 * MB }));
  const r = detectMemoryTrend(samples, now);
  assert.equal(r.leaking, false);
});

test('detectMemoryTrend: crescimento sustentado acusa possível vazamento', () => {
  const now = 10 * HOUR;
  // 12 amostras ao longo de ~1h, subindo ~100 MB/h de forma monotônica
  const samples = Array.from({ length: 12 }, (_, i) => ({ t: now - (12 - i) * 5 * 60_000, rss: (200 + i * 9) * MB }));
  const r = detectMemoryTrend(samples, now);
  assert.equal(r.leaking, true);
  assert.ok(r.growthMbPerHour > 25);
});

test('detectMemoryTrend: poucas amostras não decide (seguro)', () => {
  const now = 10 * HOUR;
  const r = detectMemoryTrend([{ t: now, rss: 100 * MB }], now);
  assert.equal(r.leaking, false);
  assert.equal(r.samples, 1);
});

test('collectHealth devolve métricas reais coerentes', async () => {
  const h = await collectHealth();
  assert.ok(h.memory.rssMb > 0);
  assert.ok(h.cpu.cores >= 1);
  assert.ok(['ok', 'atencao', 'critico'].includes(h.status));
  assert.ok(Array.isArray(h.alerts));
  assert.ok(typeof h.uptimeSec === 'number');
});
