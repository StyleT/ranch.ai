// Status page for the ranch pipeline (docs/STATUS-DASHBOARD.md). One node:http server:
//   GET /                  the page
//   GET /api/status        everything the page shows, JSON (5 s cache)
//   GET /api/frame/<cam>   latest kept frame for that camera; /api/frame/<id>?w=1280 a specific frame, resized on the fly
//   GET /frames, /api/frames  the frame browser (docs/FRAMES-AND-BASELINE.md §2)
//   GET /api/baseline, /api/baseline/<date>?model=, /api/baseline-frame/<date>/<camera>/<file>  zero-shot baseline sets (§3)
//   GET /api/events        server-sent events: every MQTT message on ranch/# plus a status document every 15 s
import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { config } from '@ranch/config';
import { EventStore, parseSince, type FrameReason } from '@ranch/events';
import { connectBus } from '@ranch/bus';
import { collect, type Status } from './collect.ts';
import { page } from './page.ts';
import { framesPage } from './frames.ts';
import sharp from 'sharp';

const PORT = Number(process.env.RANCH_STATUS_PORT ?? 5090);
const HOST = process.env.RANCH_STATUS_HOST ?? '0.0.0.0';
const BASELINE_DIR = process.env.RANCH_BASELINE_DIR ?? '/usr/local/ranch/app/evals/baseline';
const LABELS_DIR = process.env.RANCH_LABELS_DIR ?? '/usr/local/ranch/app/evals/golden';
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'status', msg, ...extra }) + '\n');

const store = new EventStore(config.dbPath);
const bus = await connectBus('status');
const mqttStatus = new Map<string, Record<string, unknown>>();
const sse = new Set<ServerResponse>();
const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

await bus.subscribe('ranch/#', (topic, payload) => {
  if (topic.startsWith('ranch/status/') && payload && typeof payload === 'object') mqttStatus.set(topic.slice('ranch/status/'.length), payload as Record<string, unknown>);
  for (const res of sse) send(res, 'mqtt', { topic, payload });
});

let cache: { at: number; value: Promise<Status> } | undefined;
const status = (): Promise<Status> => {
  if (!cache || Date.now() - cache.at > 5000) cache = { at: Date.now(), value: collect(store, mqttStatus) };
  return cache.value;
};

setInterval(async () => {
  if (sse.size === 0) return;
  try { const s = await status(); for (const res of sse) send(res, 'status', s); } catch (e) { log('status failed', { error: String(e) }); }
}, 15_000);
setInterval(() => { for (const res of sse) res.write(': keep-alive\n\n'); }, 20_000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page);
    } else if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(await status()));
    } else if (url.pathname === '/frames') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(framesPage);
    } else if (url.pathname === '/api/frames') {
      const p = url.searchParams;
      const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
      const since = p.get('since') ? parseSince(p.get('since')!) : undefined;
      const rows = store.framesWithDetections({
        ...(p.get('camera') ? { camera: p.get('camera')! } : {}), ...(since ? { since } : {}), ...(p.get('until') ? { until: p.get('until')! } : {}),
        ...(p.get('label') ? { label: p.get('label')! } : {}), ...(num('min_conf') !== undefined ? { minConf: num('min_conf')! } : {}),
        ...(p.get('reason') ? { reason: p.get('reason') as FrameReason } : {}), withDetections: p.get('with_detections') === '1',
        ...(num('limit') !== undefined ? { limit: num('limit')! } : {}), ...(num('before') !== undefined ? { before: num('before')! } : {}),
      });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(rows));
    } else if (url.pathname === '/api/baseline') {
      const sets = existsSync(BASELINE_DIR) ? readdirSync(BASELINE_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(BASELINE_DIR, d, 'manifest.json'))).sort().reverse() : [];
      const labelSets = existsSync(LABELS_DIR) ? readdirSync(LABELS_DIR).filter((f) => /^labels-.*\.jsonl$/.test(f)).map((f) => 'labels:' + f.replace(/\.jsonl$/, '')) : [];
      const out = sets.map((d) => { const m = JSON.parse(readFileSync(join(BASELINE_DIR, d, 'manifest.json'), 'utf8')) as { n: number; models: Record<string, unknown> }; return { date: d, n: m.n, models: [...labelSets, ...Object.keys(m.models)] }; });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(out));
    } else if (/^\/api\/baseline\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) {
      const date = url.pathname.split('/').pop()!; const model = url.searchParams.get('model') ?? ''; const minConf = Number(url.searchParams.get('min_conf') ?? 0.25);
      const dir = join(BASELINE_DIR, date);
      const framesFile = join(dir, 'frames.jsonl'); const predFile = join(dir, `predictions.${model}.jsonl`);
      if (!existsSync(framesFile)) { res.writeHead(404); res.end('no such set'); return; }
      const frames = readFileSync(framesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { frame_id: number; path: string; camera: string; ts: string; period: string; reason: string });
      const preds = new Map<string, { label: string; confidence: number; x: number; y: number; w: number; h: number }[]>();
      if (model.startsWith('labels:')) {
        // a labels dataset (evals/golden/<id>.jsonl): boxes carry kind/posture; shown with the label text
        const lf = join(LABELS_DIR, `${model.slice('labels:'.length)}.jsonl`);
        if (existsSync(lf)) for (const l of readFileSync(lf, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as { path: string; boxes: { label: string; kind?: string; posture?: string; x: number; y: number; w: number; h: number }[] }; preds.set(r.path, r.boxes.map((b) => ({ label: `${b.kind ?? b.label}${b.posture ? '/' + b.posture : ''}`, confidence: 1, x: b.x, y: b.y, w: b.w, h: b.h }))); }
      } else if (model && existsSync(predFile)) for (const l of readFileSync(predFile, 'utf8').split('\n').filter(Boolean)) { const p = JSON.parse(l) as { path: string; detections: { label: string; confidence: number; x: number; y: number; w: number; h: number }[] }; preds.set(p.path, p.detections.filter((d) => d.confidence >= minConf)); }
      const camera = url.searchParams.get('camera');
      const rows = frames.filter((f) => !camera || f.camera === camera).map((f) => ({ id: f.frame_id, camera: f.camera, ts: f.ts, reason: f.reason, period: f.period, change: null, baseline: { date, file: f.path.slice(dir.length + 1) }, img: `/api/baseline-frame/${date}/${f.path.split('/').slice(-2).join('/')}`, detections: (preds.get(f.path) ?? []).map((d) => ({ ...d, model })) }));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(rows));
    } else if (url.pathname.startsWith('/api/baseline-frame/')) {
      const rel = normalize(decodeURIComponent(url.pathname.slice('/api/baseline-frame/'.length)));
      const path = join('/usr/local/ranch/media/baseline', rel);
      if (rel.includes('..') || !existsSync(path)) { res.writeHead(404); res.end('no frame'); return; }
      const w = Number(url.searchParams.get('w') ?? 0);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
      if (w > 0 && w < 4000) sharp(path).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 82 }).pipe(res).on('error', () => res.destroy());
      else createReadStream(path).on('error', () => res.destroy()).pipe(res);
    } else if (url.pathname.startsWith('/api/frame/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/frame/'.length));
      const f = /^\d+$/.test(key) ? store.frameById(Number(key)) : store.lastFrame(key);
      if (!f || !existsSync(f.path)) { res.writeHead(404); res.end('no frame'); return; }
      const w = Number(url.searchParams.get('w') ?? 0);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-frame-ts': f.ts, 'x-frame-id': String(f.id) });
      if (w > 0 && w < 4000) sharp(f.path).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 82 }).pipe(res).on('error', () => res.destroy());
      else createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
    } else if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      sse.add(res);
      req.on('close', () => sse.delete(res));
      try { send(res, 'status', await status()); } catch { /* next tick */ }
    } else { res.writeHead(404); res.end('not found'); }
  } catch (e) {
    log('request failed', { path: url.pathname, error: String(e) });
    if (!res.headersSent) res.writeHead(500); res.end('error');
  }
});
server.listen(PORT, HOST, () => log('listening', { host: HOST, port: PORT, db: config.dbPath }));

const shutdown = async () => { server.close(); for (const r of sse) r.end(); await bus.close(); store.close(); process.exit(0); };
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
