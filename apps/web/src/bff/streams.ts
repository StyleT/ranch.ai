// HTTP passthroughs: frames from the daemon, camera streams from go2rtc (docs/WEB-DASHBOARD.md §3). No WebSocket
// upgrades (MSE/WebRTC) are possible through a route handler, so streams are fMP4, HLS, MJPEG or a single JPEG.
import { env } from './env.ts';
import { daemonFetch, UpstreamError, log } from './daemon.ts';
import { getStatus } from './home.ts';

export async function proxyFrame(path: string, w: string | null, cacheControl: string): Promise<Response> {
  const url = `${path}${w ? `?w=${encodeURIComponent(w)}` : ''}`;
  const up = await daemonFetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!up.ok || !up.body) return new Response('no frame', { status: up.status === 404 ? 404 : 502 });
  const h = new Headers({ 'content-type': up.headers.get('content-type') ?? 'image/jpeg', 'cache-control': cacheControl });
  for (const k of ['x-frame-ts', 'x-frame-id']) { const v = up.headers.get(k); if (v) h.set(k, v); }
  return new Response(up.body, { status: 200, headers: h });
}

const FORMATS = { mp4: 'stream.mp4', m3u8: 'stream.m3u8', mjpeg: 'stream.mjpeg', jpeg: 'frame.jpeg' } as const;
export type Fmt = keyof typeof FORMATS;
let open = 0;
const STREAM_MAX_MS = 10 * 60_000;

/** Proxy one go2rtc stream for a known camera; the client's abort closes the upstream (go2rtc drops the consumer). */
export async function proxyStream(camera: string, fmtIn: string | null, seg: string | null, signal: AbortSignal): Promise<Response> {
  const status = await getStatus();
  if (!status.cameras.some((c) => c.name === camera)) throw new UpstreamError(404, 'not_found', `no camera ${camera}`);
  const excluded = env.keepaliveExclude.includes(camera);
  let fmt: Fmt = (fmtIn && fmtIn in FORMATS ? fmtIn : 'mp4') as Fmt;
  if (excluded && (fmt === 'mp4' || fmt === 'm3u8')) fmt = 'mjpeg';
  // HLS segment continuation: ?seg=<name> fetches go2rtc's hls/<name> for the same source
  const path = seg ? (/^[\w.-]+$/.test(seg) ? `/api/hls/${seg}?src=${encodeURIComponent(camera)}` : null) : `/api/${FORMATS[fmt]}?src=${encodeURIComponent(camera)}`;
  if (!path) throw new UpstreamError(400, 'bad_request', 'bad segment');
  const continuous = fmt !== 'jpeg' && !seg;
  if (continuous && open >= env.maxStreams) throw new UpstreamError(429, 'too_many_streams', `at most ${env.maxStreams} live streams`);
  if (continuous) open++; // reserve the slot before the upstream connect so concurrent requests cannot all pass the check
  const ctrl = new AbortController();
  let finished = false;
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  const hardStop = continuous ? setTimeout(() => ctrl.abort(), STREAM_MAX_MS) : null;
  const done = () => { if (finished) return; finished = true; signal.removeEventListener('abort', onAbort); if (hardStop) clearTimeout(hardStop); if (continuous) { open--; log('stream closed', { camera, fmt, open }); } };
  let up: Response;
  try { up = await fetch(env.go2rtcUrl + path, { signal: ctrl.signal, cache: 'no-store' }); }
  catch (e) { done(); throw new UpstreamError(503, 'go2rtc_unreachable', e instanceof Error ? e.message : String(e)); }
  if (!up.ok || !up.body) { done(); throw new UpstreamError(up.status === 404 ? 404 : 502, 'go2rtc', `go2rtc ${path} -> ${up.status}`); }
  if (continuous) log('stream open', { camera, fmt, open });
  const reader = up.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) { try { const { value, done: end } = await reader.read(); if (end) { c.close(); done(); return; } c.enqueue(value); } catch (e) { done(); c.error(e); } },
    cancel() { done(); ctrl.abort(); },
  });
  ctrl.signal.addEventListener('abort', done);
  const h = new Headers({ 'content-type': up.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' });
  return new Response(body, { status: 200, headers: h });
}
export const openStreams = () => open;
