// Detector benchmark (Post 1 table). For each model x compute unit: latency p50/p95, fps, peak RSS of the
// runner, and, when a golden label file is given, per-class precision/recall at IoU 0.5.
//   node apps/detector/src/bench.ts --frames evals/golden/frames.jsonl --labels evals/golden/labels.jsonl \
//        --model /usr/local/ranch/models/yolo11n.mlpackage --model ... --compute ane,gpu,cpu --out bench.json
// frames.jsonl: {"path": ...} per line (labels.jsonl rows also work). labels.jsonl: {"path", "boxes": [{label,x,y,w,h}]}.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Runner, type RunnerDetection } from './runner.ts';

const { values: a } = parseArgs({ options: {
  frames: { type: 'string' }, labels: { type: 'string' }, model: { type: 'string', multiple: true },
  compute: { type: 'string', default: 'ane' }, threshold: { type: 'string', default: '0.25' }, iou: { type: 'string', default: '0.5' },
  bin: { type: 'string', default: '/usr/local/ranch/bin/detector' }, out: { type: 'string' }, warmup: { type: 'string', default: '5' },
} });
if (!a.model?.length || !(a.frames || a.labels)) { console.error('need --model and --frames or --labels'); process.exit(2); }

interface Box { label: string; x: number; y: number; w: number; h: number }
const readJsonl = <T,>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
const labels = a.labels ? new Map(readJsonl<{ path: string; boxes: Box[] }>(a.labels).map((r) => [r.path, r.boxes])) : undefined;
const frames = (a.frames ? readJsonl<{ path: string }>(a.frames) : [...labels!.keys()].map((path) => ({ path }))).map((f) => f.path);

const iou = (p: Box, q: Box): number => {
  const x1 = Math.max(p.x, q.x), y1 = Math.max(p.y, q.y), x2 = Math.min(p.x + p.w, q.x + q.w), y2 = Math.min(p.y + p.h, q.y + q.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (p.w * p.h + q.w * q.h - inter);
};
const pct = (xs: number[], p: number) => { const s = [...xs].sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };

interface ClassStat { tp: number; fp: number; fn: number }
function score(pred: RunnerDetection[], gold: Box[], thr: number, stats: Map<string, ClassStat>): void {
  const used = new Set<number>();
  const labelsSeen = new Set([...pred.map((d) => d.label), ...gold.map((g) => g.label)]);
  for (const label of labelsSeen) {
    const st = stats.get(label) ?? { tp: 0, fp: 0, fn: 0 };
    const g = gold.map((b, i) => [b, i] as const).filter(([b]) => b.label === label);
    for (const d of pred.filter((d) => d.label === label).sort((u, v) => v.confidence - u.confidence)) {
      let best = -1; let bestIou = thr;
      for (const [b, i] of g) { if (used.has(i)) continue; const v = iou(d, b); if (v >= bestIou) { best = i; bestIou = v; } }
      if (best >= 0) { used.add(best); st.tp++; } else st.fp++;
    }
    st.fn += g.filter(([, i]) => !used.has(i)).length;
    stats.set(label, st);
  }
}

const results: Record<string, unknown>[] = [];
for (const model of a.model) {
  for (const compute of a.compute!.split(',') as ('ane' | 'gpu' | 'cpu' | 'all')[]) {
    const runner = new Runner({ bin: a.bin, model, compute, threshold: Number(a.threshold) });
    const info = await runner.info;
    const warm = frames.slice(0, Number(a.warmup));
    for (const p of warm) await runner.detect(p);
    const ms: number[] = []; let peakRss = info.rss_mb; const stats = new Map<string, ClassStat>();
    const t0 = Date.now();
    for (const p of frames) {
      const r = await runner.detect(p);
      ms.push(r.ms); peakRss = Math.max(peakRss, r.rss_mb);
      if (labels) score(r.detections, labels.get(p) ?? [], Number(a.iou), stats);
    }
    const wall = (Date.now() - t0) / 1000;
    runner.close();
    const perClass = Object.fromEntries([...stats].map(([label, s]) => [label, { ...s, precision: s.tp / Math.max(1, s.tp + s.fp), recall: s.tp / Math.max(1, s.tp + s.fn) }]));
    const row = { model: basename(model), compute, frames: frames.length, compiled_ms: info.compiled_ms ?? null,
      p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), mean_ms: ms.reduce((s, v) => s + v, 0) / ms.length, fps_wall: frames.length / wall, peak_rss_mb: peakRss,
      ...(labels ? { classes: perClass } : {}) };
    results.push(row);
    const h = perClass.horse as { precision: number; recall: number } | undefined;
    console.log(`${row.model.padEnd(22)} ${compute.padEnd(4)} p50 ${row.p50_ms.toFixed(1)} ms  p95 ${row.p95_ms.toFixed(1)} ms  ${row.fps_wall.toFixed(1)} fps  rss ${peakRss} MB` + (h ? `  horse P ${h.precision.toFixed(2)} R ${h.recall.toFixed(2)}` : ''));
  }
}
if (a.out) writeFileSync(a.out, JSON.stringify({ ts: new Date().toISOString(), threshold: Number(a.threshold), iou: Number(a.iou), results }, null, 2) + '\n');
