// A deterministic fake status daemon for e2e and `dev:mock`: serves the recorded fixtures, images, an SSE stream
// (status every 2 s plus scripted mqtt events), the buffer endpoints, and taxonomy writes with `x-ranch-token:
// test-token` (apply appends a version). `?scenario=sse-stall` on /api/events sends nothing after the first status.
//   node --experimental-strip-types test/fixture-server.ts [port]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(FX, 'daemon', `${name}.json`), 'utf8')) as T;
const img320 = readFileSync(join(FX, 'images', 'frame-320.jpg')); const img640 = readFileSync(join(FX, 'images', 'frame-640.jpg'));
const PORT = Number(process.argv[2] ?? process.env.FIXTURE_PORT ?? 5095);
const TOKEN = 'test-token';

type Version = { id: number; created: string; author: string; note: string | null; parent_id: number | null; gate: string | null; active: number; score_summary: unknown };
const taxonomy = fx<{ active: { id: number }; versions: Version[]; taxonomy: unknown }>('taxonomy');
let versions: Version[] = taxonomy.versions.map((v) => ({ ...v })); let active = taxonomy.taxonomy; let activeId = taxonomy.active.id;
const contents = new Map<number, unknown>(versions.map((v) => [v.id, taxonomy.taxonomy]));
const status = fx<Record<string, unknown>>('status');

const json = (res: import('node:http').ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req: import('node:http').IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname;
  if (p === '/api/ping') return json(res, 200, fx('ping'));
  if (p === '/api/status') return json(res, 200, { ...status, ts: new Date().toISOString() });
  if (p === '/api/frames') return json(res, 200, fx(url.searchParams.get('moving') === '1' ? 'frames-moving' : 'frames'));
  if (/^\/api\/frames\/\d+$/.test(p)) { const id = Number(p.split('/').pop()); const head = fx<{ id: number }[]>('frames').find((f) => f.id === id) ?? (id === 999999 ? null : fx('frame-head')); return head ? json(res, 200, head) : json(res, 404, { error: 'no such frame' }); }
  if (p === '/api/tracks') return json(res, 200, fx('tracks'));
  if (p === '/api/counts/series') return json(res, 200, fx('counts-series'));
  if (p === '/api/frames/series') return json(res, 200, fx('frames-series'));
  if (p === '/api/baseline') return json(res, 200, fx('baseline'));
  if (/^\/api\/baseline\/\d{4}-\d{2}-\d{2}$/.test(p)) return json(res, 200, fx('baseline-set'));
  if (p === '/api/taxonomy' && req.method === 'GET') return json(res, 200, { ...taxonomy, active: { ...versions.find((v) => v.active)!, score_json: undefined }, versions, taxonomy: active, matches_repo: activeId === taxonomy.active.id });
  if (p === '/api/taxonomy/versions') return json(res, 200, versions);
  if (/^\/api\/taxonomy\/versions\/\d+$/.test(p)) { const id = Number(p.split('/').pop()); const v = versions.find((x) => x.id === id); return v ? json(res, 200, { ...v, taxonomy: contents.get(id) ?? active, score: null }) : json(res, 404, { error: 'no such version' }); }
  if (p.startsWith('/api/taxonomy/') && req.method === 'POST') {
    const action = p.split('/')[3]; const body = await readBody(req);
    if (action === 'validate') return json(res, 200, { ok: true });
    if (action === 'score') { await new Promise((r) => setTimeout(r, 300)); return json(res, 200, { ...fx<Record<string, unknown>>('score-draft'), draft_taxonomy: body.taxonomy }); }
    if (req.headers['x-ranch-token'] !== TOKEN) return json(res, 403, { error: 'bad or missing x-ranch-token' });
    if (action === 'apply' || action === 'revert') {
      const id = Math.max(...versions.map((v) => v.id)) + 1; const sc = body.score as { gate?: { pass: boolean }; draft?: unknown } | null | undefined;
      for (const v of versions) v.active = 0;
      versions = [{ id, created: new Date().toISOString(), author: 'ui:test', note: action === 'revert' ? `revert to v${body.id}: ${body.note ?? ''}` : String(body.note ?? ''), parent_id: activeId, gate: sc?.gate ? (sc.gate.pass ? 'pass' : 'fail') : null, active: 1, score_summary: sc?.draft ?? null }, ...versions];
      active = action === 'apply' ? body.taxonomy : (contents.get(Number(body.id)) ?? active); contents.set(id, active); activeId = id; return json(res, 200, { ok: true, id });
    }
    return json(res, 404, { error: 'unknown action' });
  }
  if (/^\/api\/buffer\/[a-z0-9_]+\/stream$/.test(p)) { res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' }); const t = setInterval(() => { res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${img640.length}\r\n\r\n`); res.write(img640); res.write('\r\n'); }, 500); req.on('close', () => clearInterval(t)); return; }
  if (/^\/api\/buffer\/[a-z0-9_]+$/.test(p) || p.startsWith('/api/frame/') || p.startsWith('/api/baseline-frame/')) { const w = Number(url.searchParams.get('w') ?? 640); res.writeHead(200, { 'content-type': 'image/jpeg', 'x-frame-id': '1', 'x-frame-ts': new Date().toISOString() }); return res.end(w <= 320 ? img320 : img640); }
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': connected\n\n');
    const send = (ev: string, data: unknown) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    send('status', { ...status, ts: new Date().toISOString() });
    if (url.searchParams.get('scenario') === 'sse-stall' || process.env.FIXTURE_SCENARIO === 'sse-stall') { req.on('close', () => undefined); return; }
    let n = 0; const t = setInterval(() => { n++; send('mqtt', { topic: 'ranch/frames/donkey_cam', payload: { id: 1000 + n, ts: new Date().toISOString(), camera: 'donkey_cam', reason: 'floor' } }); if (n % 4 === 0) send('status', { ...status, ts: new Date().toISOString() }); if (n % 6 === 0) send('mqtt', { topic: 'ranch/tracks/donkey_cam', payload: { burst_id: 1000 + n, camera: 'donkey_cam', frames: 3, tracks: [{ track: 1, label: 'horse', raw_label: 'horse', seen: 3, dx: 0.05, dy: 0, moving: true, stable: true, confidence: 0.9 }] } }); }, 500);
    req.on('close', () => clearInterval(t)); return;
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`fixture daemon on http://127.0.0.1:${PORT}`));
