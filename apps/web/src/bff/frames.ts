// JPEG passthroughs from the status daemon: kept frames by id and the newest buffered frame per camera (thumbnails,
// posters). Disk reads on the mini; the web app never touches go2rtc or a camera (docs/CAMERA-ARCHITECTURE.md).
import { daemonFetch } from './daemon.ts';

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
