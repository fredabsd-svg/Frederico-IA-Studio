// Saúde e observabilidade (seções 10 e 11). Coleta métricas REAIS do processo e
// do sistema (nada de números inventados — seção 27): memória, CPU, disco,
// uptime, lag do event loop, e detecta DEGRADAÇÃO gradual (ex.: memória que só
// sobe = possível vazamento), não apenas falhas completas.
import os from 'node:os';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { healthMetrics } from '../healthMetrics.js';

// Medidor contínuo do atraso do event loop (indica sobrecarga/travamento).
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

// Buffer circular de amostras de memória (para detectar tendência de vazamento).
const MAX_SAMPLES = 180; // ~3h em amostras de 1/min
const memSamples = []; // { t, rss }

export function sampleHealth(nowMs = Date.now()) {
  const rss = process.memoryUsage().rss;
  memSamples.push({ t: nowMs, rss });
  while (memSamples.length > MAX_SAMPLES) memSamples.shift();
  return { t: nowMs, rss };
}

// Detecção de tendência (pura/testável): a série de RSS cresce de forma
// consistente sem recuar? Retorna { leaking, growthMbPerHour, samples }.
export function detectMemoryTrend(samples = memSamples, nowMs = Date.now()) {
  const pts = samples.filter(s => nowMs - s.t <= 3 * 60 * 60 * 1000);
  if (pts.length < 6) return { leaking: false, growthMbPerHour: 0, samples: pts.length };
  const first = pts[0], last = pts[pts.length - 1];
  const hours = Math.max(1 / 60, (last.t - first.t) / 3_600_000);
  const growthMb = (last.rss - first.rss) / (1024 * 1024);
  const growthMbPerHour = growthMb / hours;
  // "Só sobe": a maioria das amostras é >= a anterior e o crescimento é relevante.
  let ups = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].rss >= pts[i - 1].rss) ups++;
  const monotonic = ups / (pts.length - 1) >= 0.7;
  const leaking = monotonic && growthMbPerHour > 25; // >25 MB/h sustentado
  return { leaking, growthMbPerHour: Math.round(growthMbPerHour), samples: pts.length };
}

async function diskInfo(dir = process.env.DATA_DIR || '.') {
  try {
    const s = await fs.promises.statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bfree * s.bsize;
    return { totalGb: +(total / 1e9).toFixed(1), freeGb: +(free / 1e9).toFixed(1), usedPct: total ? Math.round((1 - free / total) * 100) : null };
  } catch { return { totalGb: null, freeGb: null, usedPct: null }; }
}

// Snapshot completo de saúde (assíncrono por causa do disco).
export async function collectHealth() {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem(), freeMem = os.freemem();
  const cpus = os.cpus()?.length || 1;
  const load = os.loadavg(); // [1m, 5m, 15m]
  const disk = await diskInfo();
  const trend = detectMemoryTrend();
  const loopMeanMs = +(loopDelay.mean / 1e6).toFixed(1);
  const loopMaxMs = +(loopDelay.max / 1e6).toFixed(1);

  // Alertas de degradação (com evidência).
  const alerts = [];
  if (trend.leaking) alerts.push({ level: 'aviso', kind: 'memoria', msg: `A memória do processo cresce ~${trend.growthMbPerHour} MB/h de forma sustentada — possível vazamento.` });
  if (disk.usedPct != null && disk.usedPct >= 90) alerts.push({ level: 'critico', kind: 'disco', msg: `Disco em ${disk.usedPct}% — espaço quase esgotado.` });
  if (loopMeanMs > 200) alerts.push({ level: 'aviso', kind: 'event_loop', msg: `Event loop com atraso médio de ${loopMeanMs} ms — processo sobrecarregado.` });
  if (load[0] / cpus > 2) alerts.push({ level: 'aviso', kind: 'cpu', msg: `Carga de CPU alta (${load[0].toFixed(1)} para ${cpus} núcleos).` });

  return {
    uptimeSec: Math.round(process.uptime()),
    bootAt: healthMetrics.bootAt,
    unhandledRejections: healthMetrics.unhandledRejections,
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      systemUsedPct: Math.round((1 - freeMem / totalMem) * 100),
      trend,
    },
    cpu: { cores: cpus, load1: +load[0].toFixed(2), load5: +load[1].toFixed(2), load15: +load[2].toFixed(2) },
    disk,
    eventLoop: { meanMs: loopMeanMs, maxMs: loopMaxMs },
    alerts,
    status: alerts.some(a => a.level === 'critico') ? 'critico' : (alerts.length ? 'atencao' : 'ok'),
  };
}

// Inicia a amostragem periódica (chamada no boot).
export function startHealthSampling(intervalMs = 60_000) {
  sampleHealth();
  const id = setInterval(() => { try { sampleHealth(); } catch {} }, intervalMs);
  if (id.unref) id.unref();
  return id;
}

export function healthHistory() {
  return memSamples.map(s => ({ t: s.t, rssMb: Math.round(s.rss / 1048576) }));
}
