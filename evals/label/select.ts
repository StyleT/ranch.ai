// Pick the Phase 1 label set: N frames stratified by camera x (day|night), sampled at random with a fixed
// seed from the seed recorder's directory. Writes evals/golden/frames.jsonl and copies the files into
// evals/golden/frames/<camera>/ so the set is self-contained (that directory is git-ignored).
//   node evals/label/select.ts --n 100 --seed-dir /usr/local/ranch/media/seed --out evals/golden
import { parseArgs } from 'node:util';
import { readdirSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { values: a } = parseArgs({ options: {
  n: { type: 'string', default: '100' }, 'seed-dir': { type: 'string', default: '/usr/local/ranch/media/seed' },
  out: { type: 'string', default: 'evals/golden' }, exclude: { type: 'string', default: 'living_room_cam' },
  tz: { type: 'string', default: 'America/New_York' }, seed: { type: 'string', default: '20261016' }, 'min-bytes': { type: 'string', default: '60000' },
} });

// Deterministic PRNG so the pick is reproducible from the same seed directory.
let s = Number(a.seed) >>> 0;
const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hourLocal = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: a.tz }).format(d));
const period = (d: Date) => { const h = hourLocal(d); return h >= 7 && h < 18 ? 'day' : 'night'; };

interface Cand { path: string; camera: string; ts: string; period: 'day' | 'night'; bytes: number }
const cameras = readdirSync(a['seed-dir']!).filter((c) => !a.exclude!.split(/\s+/).includes(c)).sort();
const buckets = new Map<string, Cand[]>();
for (const camera of cameras) {
  for (const f of readdirSync(join(a['seed-dir']!, camera))) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.jpg$/.exec(f);
    if (!m) continue;
    const path = join(a['seed-dir']!, camera, f);
    const bytes = statSync(path).size;
    if (bytes < Number(a['min-bytes'])) continue; // truncated or black frame
    const ts = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
    const p = period(new Date(ts));
    const key = `${camera}|${p}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push({ path, camera, ts, period: p, bytes });
  }
}
const n = Number(a.n);
const keys = [...buckets.keys()].sort();
const per = Math.floor(n / keys.length);
const picked: Cand[] = [];
for (const k of keys) {
  const pool = buckets.get(k)!;
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  picked.push(...pool.slice(0, per));
}
// top up to n from the largest remaining pools, round-robin
let i = 0;
while (picked.length < n) {
  const k = keys[i++ % keys.length]!; const pool = buckets.get(k)!;
  const next = pool.find((c) => !picked.includes(c)); if (next) picked.push(next);
  if (i > keys.length * 50) break;
}
picked.sort((u, v) => u.camera.localeCompare(v.camera) || u.ts.localeCompare(v.ts));
mkdirSync(a.out!, { recursive: true });
const rows = picked.map((c) => {
  const dst = join(a.out!, 'frames', c.camera, c.path.split('/').pop()!);
  mkdirSync(join(a.out!, 'frames', c.camera), { recursive: true });
  copyFileSync(c.path, dst);
  return { path: dst, source: c.path, camera: c.camera, ts: c.ts, period: c.period };
});
writeFileSync(join(a.out!, 'frames.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const summary: Record<string, number> = {};
for (const r of rows) summary[`${r.camera}/${r.period}`] = (summary[`${r.camera}/${r.period}`] ?? 0) + 1;
console.log(JSON.stringify({ picked: rows.length, buckets: Object.fromEntries(keys.map((k) => [k, buckets.get(k)!.length])), chosen: summary }, null, 2));
