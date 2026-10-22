// Live daemon vs packages/contracts (make contract-test). Not CI: it needs the mini.
import * as C from '@ranch/contracts';
const D = process.env.RANCH_DAEMON_URL ?? 'http://127.0.0.1:5091';
const get = async (p: string) => { const r = await fetch(D + p, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json(); };
let failures = 0;
const check = async (name: string, fn: () => Promise<void>) => { try { await fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '-', (e as Error).message); } };
await check('/api/ping', async () => { const p = C.parseContract(C.Ping, await get('/api/ping'), 'ping'); if (p.api !== 1) throw new Error('api version'); });
const status = C.parseContract(C.Status, await get('/api/status'), 'status');
await check('/api/status invariants', async () => { if (!status.label_order.includes('horse')) throw new Error('label_order lacks horse'); if (!status.cameras.length) throw new Error('no cameras'); });
await check('/api/frames', async () => { C.parseContract(C.FramesResponse, await get('/api/frames?since=1h&limit=10'), 'frames'); });
await check('/api/tracks', async () => { C.parseContract(C.Tracks, await get('/api/tracks?since=24h&limit=5'), 'tracks'); });
await check('/api/counts/series minute-aligned', async () => { const s = C.parseContract(C.CountSeries, await get('/api/counts/series?since=6h&bucket=15m'), 'counts'); for (const x of s) for (const p of x.points) if (Date.parse(p.ts) % 900e3 !== 0) throw new Error(`bucket not aligned: ${p.ts}`); });
await check('/api/frames/series', async () => { C.parseContract(C.FrameSeries, await get('/api/frames/series?since=6h&bucket=15m'), 'frames series'); });
await check('/api/taxonomy', async () => { const t = C.parseContract(C.TaxonomyMeta, await get('/api/taxonomy'), 'taxonomy'); if (!t.versions.some((v) => v.active === 1)) throw new Error('no active version'); });
await check('/api/baseline', async () => { C.parseContract(C.BaselineSet.array(), await get('/api/baseline'), 'baseline'); });
await check('/api/frame/<camera>', async () => { for (const c of status.cameras.slice(0, 2)) { const r = await fetch(`${D}/api/frame/${c.name}?w=64`); if (r.status !== 200 && r.status !== 404) throw new Error(`${c.name}: ${r.status}`); } });
console.log(failures ? `${failures} failure(s)` : 'all contracts hold'); process.exit(failures ? 1 : 0);
