// /api/ui/live: one upstream SSE connection to the daemon, fanned out to every browser client, with MQTT topics
// translated into named events (docs/WEB-DASHBOARD.md §3). Reconnects upstream with backoff; closes 30 s after the
// last client leaves.
import { env } from './env.ts';
import { log } from './daemon.ts';

type Client = { send: (event: string, data: string) => void; close: () => void };
const clients = new Set<Client>();
let upstream: AbortController | null = null; let idleTimer: ReturnType<typeof setTimeout> | null = null; let backoff = 1000;
let lastStatus: string | null = null; let mqttBudget = { at: 0, n: 0 };

const broadcast = (event: string, data: string) => { for (const c of clients) { try { c.send(event, data); } catch { clients.delete(c); } } };

/** mqtt topic -> named event; returns null to skip. */
export function translate(topic: string, payload: unknown): { event: string; data: unknown } | null {
  const p = payload as Record<string, unknown>;
  const cam = topic.split('/')[2] ?? '';
  if (topic.startsWith('ranch/frames/')) return { event: 'frame', data: { camera: cam, frame_id: p.id, ts: p.ts, reason: p.reason, burst_id: p.burst_id ?? null, seq: p.seq ?? null } };
  if (topic.startsWith('ranch/counts/')) return { event: 'counts', data: { camera: cam, ts: p.ts, counts: p.counts } };
  if (topic.startsWith('ranch/tracks/')) return { event: 'tracks', data: { camera: cam, burst_id: p.burst_id, frames: p.frames, tracks: p.tracks } };
  if (topic.startsWith('ranch/status/')) return { event: 'daemon', data: { name: cam, status: payload } };
  if (topic === 'ranch/taxonomy') return { event: 'taxonomy', data: payload };
  return null;
}

async function pump(): Promise<void> {
  while (upstream && clients.size) {
    try {
      const res = await fetch(`${env.daemonUrl}/api/events`, { signal: upstream.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`);
      backoff = 1000; broadcast('upstream', JSON.stringify({ state: 'connected' }));
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { handleChunk(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
      throw new Error('upstream closed');
    } catch (e) {
      if (!upstream || upstream.signal.aborted) return;
      broadcast('upstream', JSON.stringify({ state: 'reconnecting', error: e instanceof Error ? e.message : String(e) }));
      await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(30_000, backoff * 2);
    }
  }
}
function handleChunk(chunk: string): void {
  let event = 'message'; const data: string[] = [];
  for (const line of chunk.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trim()); }
  if (!data.length) return; const raw = data.join('\n');
  if (event === 'status') { lastStatus = raw; broadcast('status', raw); return; }
  if (event === 'mqtt') {
    let msg: { topic: string; payload: unknown }; try { msg = JSON.parse(raw) as { topic: string; payload: unknown }; } catch { return; }
    const t = translate(msg.topic, msg.payload); if (t) broadcast(t.event, JSON.stringify(t.data));
    const now = Date.now(); if (now - mqttBudget.at > 1000) mqttBudget = { at: now, n: 0 }; if (mqttBudget.n++ < 30) broadcast('mqtt', raw);
  }
}
function ensureUpstream(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (upstream) return;
  upstream = new AbortController(); log('live upstream open'); void pump();
}
function maybeIdle(): void {
  if (clients.size || idleTimer) return;
  idleTimer = setTimeout(() => { idleTimer = null; if (!clients.size && upstream) { upstream.abort(); upstream = null; lastStatus = null; log('live upstream closed (idle)'); } }, 30_000);
}

/** The SSE response for one browser client. */
export function liveResponse(signal: AbortSignal, scenario: string | null = null): Response {
  // Test scenario (docs/WEB-DASHBOARD.md §6): one status, then silence, so the browser watchdog must notice the stall.
  if (scenario === 'sse-stall') {
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(enc.encode(': connected\n\nevent: status\ndata: {}\n\n')); signal.addEventListener('abort', () => { try { ctrl.close(); } catch { /* closed */ } }); } }),
      { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }
  const enc = new TextEncoder();
  let client: Client | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      client = { send: (event, data) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)), close: () => { try { ctrl.close(); } catch { /* closed */ } } };
      clients.add(client); ensureUpstream();
      ctrl.enqueue(enc.encode(': connected\n\n'));
      if (lastStatus) client.send('status', lastStatus);
      const ka = setInterval(() => { try { ctrl.enqueue(enc.encode(': keep-alive\n\n')); } catch { clearInterval(ka); } }, 20_000);
      signal.addEventListener('abort', () => { clearInterval(ka); if (client) clients.delete(client); client?.close(); maybeIdle(); });
    },
    cancel() { if (client) clients.delete(client); maybeIdle(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
}
export const liveClients = () => clients.size;
