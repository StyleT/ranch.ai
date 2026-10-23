// The live view: the recorder writes an HLS stream per camera from its single camera connection, the daemon serves the
// files, this proxies them to the browser (docs/WEB-DASHBOARD.md). Static files: any number of viewers costs the
// camera nothing and needs no cap. Only the three file shapes ffmpeg produces are allowed through.
import { daemonFetch, UpstreamError } from './daemon.ts';

export const HLS_FILE = /^(index\.m3u8|init(-\d+)?\.mp4|seg(\d+-)?\d{6}\.m4s)$/;   // per-run names: init-<run>.mp4, seg<run>-NNNNNN.m4s
export const CAMERA_NAME = /^[a-z0-9_]{1,40}$/;
const PASS = ['content-type', 'content-length', 'cache-control', 'x-live-age-s'];

/** `scenario` is forwarded only so the fixture daemon can stall a playlist in e2e tests; the real daemon ignores it. */
export async function proxyHls(camera: string, file: string, signal: AbortSignal, scenario?: string | null): Promise<Response> {
  if (!CAMERA_NAME.test(camera) || !HLS_FILE.test(file)) throw new UpstreamError(404, 'not_found', 'no such live file');
  const up = await daemonFetch(`/api/live/${camera}/${file}${scenario ? `?scenario=${encodeURIComponent(scenario)}` : ''}`, { signal });
  if (up.status === 404) throw new UpstreamError(404, 'not_found', `no live ${file} for ${camera}`);
  if (!up.ok || !up.body) throw new UpstreamError(502, 'upstream', `daemon live -> ${up.status}`);
  const h = new Headers(); for (const k of PASS) { const v = up.headers.get(k); if (v) h.set(k, v); }
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  return new Response(up.body, { status: 200, headers: h });
}
