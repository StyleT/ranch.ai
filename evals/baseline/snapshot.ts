// Zero-shot baseline (docs/FRAMES-AND-BASELINE.md §3): freeze a stratified frame set and record what every current
// model says about it, with no training and no tuning. Later changes are re-run on the same frames and diffed.
//   node evals/baseline/snapshot.ts --n 300 [--since 7d] [--seed 20261020] [--out-media /usr/local/ranch/media/baseline] [--out evals/baseline]
// Writes <out>/<date>/frames.jsonl, predictions.<model>.jsonl (all boxes >= 0.05), manifest.json; images under <out-media>/<date>/<camera>/.
import { parseArgs } from 'node:util';
import { mkdirSync, copyFileSync, writeFileSync, readdirSync, createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { hostname } from 'node:os';
import { config } from '@ranch/config';
import { EventStore, parseSince } from '@ranch/events';
import { Runner } from '../../apps/detector/src/runner.ts';

const { values: a } = parseArgs({ options: {
  n: { type: 'string', default: '300' }, since: { type: 'string', default: '7d' }, seed: { type: 'string', default: '20261020' },
  'out-media': { type: 'string', default: '/usr/local/ranch/media/baseline' }, out: { type: 'string', default: 'evals/baseline' },
  models: { type: 'string', default: '/usr/local/ranch/models' }, threshold: { type: 'string', default: '0.05' }, tz: { type: 'string', default: config.timezone },
  exclude: { type: 'string', default: 'living_room_cam' },
} });

let s = Number(a.seed) >>> 0;
const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hourLocal = (iso: string) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: a.tz! }).format(new Date(iso)));
const period = (iso: string) => { const h = hourLocal(iso); return h >= 7 && h < 18 ? 'day' : 'night'; };
const sha256 = (p: string) => new Promise<string>((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
async function dirSha(p: string): Promise<string> { // package = directory: hash of sorted (relative path, file hash)
  const h = createHash('sha256');
  const walk = async (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) { const q = join(d, e.name); if (e.isDirectory()) await walk(q, rel + e.name + '/'); else h.update(rel + e.name + ' ' + (await sha256(q)) + '\n'); } };
  await walk(p, ''); return h.digest('hex');
}

const date = new Date().toISOString().slice(0, 10);
const store = new EventStore(config.dbPath);
const all = store.frames({ since: parseSince(a.since!), limit: 500000 }).filter((f) => !a.exclude!.split(/\s+/).includes(f.camera));
const buckets = new Map<string, typeof all>();
for (const f of all) { const k = `${f.camera}|${period(f.ts)}`; (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(f); }
const keys = [...buckets.keys()].sort(); const n = Number(a.n); const per = Math.floor(n / keys.length);
const picked: typeof all = [];
for (const k of keys) { const pool = buckets.get(k)!; for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; } picked.push(...pool.slice(0, per)); }
let i = 0; while (picked.length < n && i < keys.length * 100) { const pool = buckets.get(keys[i++ % keys.length]!)!; const next = pool.find((f) => !picked.includes(f)); if (next) picked.push(next); }
picked.sort((u, v) => u.camera.localeCompare(v.camera) || u.ts.localeCompare(v.ts));

const mediaDir = join(a['out-media']!, date); const outDir = join(a.out!, date);
mkdirSync(outDir, { recursive: true });
const rows = picked.map((f) => {
  const dst = join(mediaDir, f.camera, basename(f.path)); mkdirSync(join(mediaDir, f.camera), { recursive: true });
  try { statSync(dst); } catch { copyFileSync(f.path, dst); }
  return { path: dst, source: f.path, frame_id: f.id, camera: f.camera, ts: f.ts, period: period(f.ts), reason: f.reason, width: f.width, height: f.height };
});
writeFileSync(join(outDir, 'frames.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const summary: Record<string, number> = {}; for (const r of rows) summary[`${r.camera}/${r.period}`] = (summary[`${r.camera}/${r.period}`] ?? 0) + 1;
console.log(JSON.stringify({ date, picked: rows.length, pools: Object.fromEntries(keys.map((k) => [k, buckets.get(k)!.length])), chosen: summary }));

const models = readdirSync(a.models!).filter((m) => m.endsWith('.mlpackage')).sort();
const manifest: Record<string, unknown> = { date, host: hostname(), n: rows.length, seed: Number(a.seed), since: a.since, threshold: Number(a.threshold), media_dir: mediaDir, models: {} as Record<string, unknown> };
for (const m of models) {
  const path = join(a.models!, m); const name = m.replace(/\.mlpackage$/, '');
  // RF-DETR fp32 returns zero logits on the Neural Engine (evals/detector/README.md); it runs on the GPU.
  const compute = name.includes('float32') ? 'gpu' : 'ane';
  const runner = new Runner({ model: path, compute, threshold: Number(a.threshold) });
  const info = await runner.info;
  const out: string[] = []; const t0 = Date.now(); let ms = 0;
  for (const r of rows) { const res = await runner.detect(r.path); ms += res.ms; out.push(JSON.stringify({ frame_id: r.frame_id, path: r.path, camera: r.camera, ts: r.ts, model: name, ms: res.ms, detections: res.detections })); }
  runner.close();
  writeFileSync(join(outDir, `predictions.${name}.jsonl`), out.join('\n') + '\n');
  (manifest.models as Record<string, unknown>)[name] = { sha256: await dirSha(path), compute, inputs: info.inputs, outputs: info.outputs, mean_ms: +(ms / rows.length).toFixed(2), wall_s: +((Date.now() - t0) / 1000).toFixed(1) };
  console.log(JSON.stringify({ model: name, frames: rows.length, mean_ms: +(ms / rows.length).toFixed(2) }));
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ out: outDir, models: models.length }));
