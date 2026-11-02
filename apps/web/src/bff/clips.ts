// Motion clips (docs/CLIPS.md): the mp4 proxy. The daemon serves the file with byte ranges;
// the Range header and the 206/Content-Range answer pass through untouched because Safari and iOS refuse an mp4
// whose server ignores Range, and every player seeks.
import { daemonFetch, UpstreamError } from './daemon.ts';

export const clipVideo = (id: number) => `/api/ui/clip/${id}`;

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
export async function proxyClip(id: string, range: string | null, signal: AbortSignal): Promise<Response> {
  if (!/^\d{1,12}$/.test(id)) {
    throw new UpstreamError(404, 'not_found', 'no such clip');
  }
  const up = await daemonFetch(`/api/clip/${id}.mp4`, { signal, headers: range ? { range } : {} });
  if (up.status === 404) {
    throw new UpstreamError(404, 'not_found', `no clip ${id}`);
  }
  if (up.status === 416) {
    return new Response(null, { status: 416, headers: { 'content-range': up.headers.get('content-range') ?? '' } });
  }
  if (!up.ok || !up.body) {
    throw new UpstreamError(502, 'upstream', `daemon clip -> ${up.status}`);
  }
  const h = new Headers();
  for (const k of PASS) {
    const v = up.headers.get(k);
    if (v) {
      h.set(k, v);
    }
  }
  return new Response(up.body, { status: up.status, headers: h });
}
