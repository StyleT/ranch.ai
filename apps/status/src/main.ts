// Status page for the ranch pipeline (docs/STATUS-DASHBOARD.md). One node:http server:
//   GET /                  the page
//   GET /api/status        everything the page shows, JSON (5 s cache)
//   GET /api/frame/<cam>   latest kept frame for that camera, as the sampler wrote it
//   GET /api/events        server-sent events: every MQTT message on ranch/# plus a status document every 15 s
import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus } from '@ranch/bus';
import { collect, type Status } from './collect.ts';
import { page } from './page.ts';

const PORT = Number(process.env.RANCH_STATUS_PORT ?? 5090);
const HOST = process.env.RANCH_STATUS_HOST ?? '0.0.0.0';
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
    } else if (url.pathname.startsWith('/api/frame/')) {
      const cam = decodeURIComponent(url.pathname.slice('/api/frame/'.length));
      const f = store.lastFrame(cam);
      if (!f || !existsSync(f.path)) { res.writeHead(404); res.end('no frame'); return; }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-frame-ts': f.ts });
      createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
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
