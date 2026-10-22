// HTTP passthroughs from the status daemon: kept frames, the newest buffered frame per camera, and the live MJPEG
// the daemon assembles from the recorder's buffer (docs/CAMERA-ARCHITECTURE.md). The web app never touches go2rtc
// or a camera; "live" means the recorder's rolling buffer, ~1 frame / 2 s.
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

/** Newest buffered frame for a camera, falling back to the last kept frame when the buffer is empty. */
export async function proxyLatest(camera: string, w: string | null): Promise<Response> {
  const r = await proxyFrame(`/api/buffer/${encodeURIComponent(camera)}`, w, 'no-store');
  return r.status === 404 ? proxyFrame(`/api/frame/${encodeURIComponent(camera)}`, w, 'no-store') : r;
}

let open = 0;
const STREAM_MAX_MS = 10 * 60_000;
/** Proxy the daemon's buffer MJPEG for a known camera; the client's abort closes the upstream. fmt=jpeg gives one frame. */
export async function proxyStream(camera: string, fmt: string | null, w: string | null, signal: AbortSignal): Promise<Response> {
  const status = await getStatus();
  if (!status.cameras.some((c) => c.name === camera)) throw new UpstreamError(404, 'not_found', `no camera ${camera}`);
  if (fmt === 'jpeg') return proxyLatest(camera, w);
  if (open >= env.maxStreams) throw new UpstreamError(429, 'too_many_streams', `at most ${env.maxStreams} live streams`);
  open++;
  const ctrl = new AbortController(); let finished = false;
  const onAbort = () => ctrl.abort(); signal.addEventListener('abort', onAbort);
  const hardStop = setTimeout(() => ctrl.abort(), STREAM_MAX_MS);
  const done = () => { if (finished) return; finished = true; signal.removeEventListener('abort', onAbort); clearTimeout(hardStop); open--; log('stream closed', { camera, open }); };
  let up: Response;
  try { up = await fetch(`${env.daemonUrl}/api/buffer/${encodeURIComponent(camera)}/stream${w ? `?w=${encodeURIComponent(w)}` : ''}`, { signal: ctrl.signal, cache: 'no-store' }); }
  catch (e) { done(); throw new UpstreamError(503, 'daemon_unreachable', e instanceof Error ? e.message : String(e)); }
  if (!up.ok || !up.body) { done(); throw new UpstreamError(up.status === 429 ? 429 : 502, 'upstream', `daemon stream -> ${up.status}`); }
  log('stream open', { camera, open });
  const reader = up.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) { try { const { value, done: end } = await reader.read(); if (end) { c.close(); done(); return; } c.enqueue(value); } catch (e) { done(); c.error(e); } },
    cancel() { done(); ctrl.abort(); },
  });
  ctrl.signal.addEventListener('abort', done);
  return new Response(body, { status: 200, headers: { 'content-type': up.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store' } });
}
export const openStreams = () => open;
