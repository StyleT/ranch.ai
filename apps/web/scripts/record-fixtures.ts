// Record daemon responses as test fixtures (docs/WEB-DASHBOARD.md). Run from the laptop against the mini over an
// ssh tunnel: `make fixtures-record`. Each response is validated against @ranch/contracts (refuses to write on a
// violation), redacted (IPs, host, log lines), and written pretty under apps/web/test/fixtures/daemon/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '@ranch/contracts';

const DAEMON = process.argv.includes('--daemon') ? process.argv[process.argv.indexOf('--daemon') + 1]! : 'http://127.0.0.1:5090';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'daemon');
mkdirSync(OUT, { recursive: true });

const redactIp = (s: string) => s.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (_m, a, b, c, d) => (a === '127' ? `${a}.${b}.${c}.${d}` : `10.0.0.${Number(d) % 250 + 1}`));
function redact(v: unknown): unknown {
  if (typeof v === 'string') return redactIp(v).replace(/ranch-ai[\w.-]*/g, 'ranch-ai');
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === 'log' && typeof x === 'string' ? redactIp(x).slice(0, 200) : redact(x)]));
  return v;
}
async function get(path: string): Promise<unknown> { const r = await fetch(DAEMON + path, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
async function post(path: string, body: unknown): Promise<unknown> { const r = await fetch(DAEMON + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) }); if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`); return r.json(); }
const write = (name: string, data: unknown) => { writeFileSync(join(OUT, name), JSON.stringify(redact(data), null, 2) + '\n'); console.log('wrote', name); };

const status = C.parseContract(C.Status, await get('/api/status'), 'status'); write('status.json', status);
write('ping.json', C.parseContract(C.Ping, await get('/api/ping'), 'ping'));
const frames = C.parseContract(C.FramesResponse, await get('/api/frames?since=24h&limit=20'), 'frames'); write('frames.json', frames);
write('frames-moving.json', C.parseContract(C.FramesResponse, await get('/api/frames?since=24h&moving=1&limit=10'), 'frames moving'));
const burstHead = frames.find((f) => f.burst.length > 0) ?? frames[0];
if (burstHead) write('frame-head.json', C.parseContract(C.FrameHead, await get(`/api/frames/${burstHead.id}`), 'frame head'));
write('tracks.json', C.parseContract(C.Tracks, await get('/api/tracks?since=24h&limit=30'), 'tracks'));
write('counts-series.json', C.parseContract(C.CountSeries, await get('/api/counts/series?since=24h&bucket=15m'), 'counts series'));
write('frames-series.json', C.parseContract(C.FrameSeries, await get('/api/frames/series?since=24h&bucket=15m'), 'frames series'));
const tax = C.parseContract(C.TaxonomyMeta, await get('/api/taxonomy'), 'taxonomy'); write('taxonomy.json', tax);
write('taxonomy-versions.json', C.parseContract(C.TaxonomyVersionItem.array(), await get('/api/taxonomy/versions'), 'taxonomy versions'));
write('taxonomy-version.json', C.parseContract(C.TaxonomyVersionFull, await get(`/api/taxonomy/versions/${tax.active.id}`), 'taxonomy version'));
const sets = C.parseContract(C.BaselineSet.array(), await get('/api/baseline'), 'baseline'); write('baseline.json', sets);
if (sets[0]) write('baseline-set.json', C.parseContract(C.BaselineFrame.array(), await get(`/api/baseline/${sets[0].date}?model=${encodeURIComponent(sets[0].models.find((m) => !m.startsWith('labels:')) ?? '')}&camera=donkey_cam`), 'baseline set'));
write('score.json', C.parseContract(C.ScoreResponse, await post('/api/taxonomy/score', { taxonomy: tax.taxonomy }), 'score'));
const draft = structuredClone(tax.taxonomy) as { mappings: Record<string, Record<string, { threshold: number }>> }; draft.mappings.coco!.person!.threshold = 0.7;
write('score-draft.json', C.parseContract(C.ScoreResponse, await post('/api/taxonomy/score', { taxonomy: draft }), 'score draft'));
// two small images for the overlay tests
for (const [name, path] of [['frame-640.jpg', `/api/frame/${burstHead?.id ?? status.cameras[0]?.name}?w=640`], ['frame-320.jpg', `/api/frame/${status.cameras[0]?.name}?w=320`]] as const) {
  const r = await fetch(DAEMON + path); if (r.ok) { writeFileSync(join(OUT, '..', 'images', name), Buffer.from(await r.arrayBuffer())); console.log('wrote images/' + name); }
}
console.log('done');
