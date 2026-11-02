// Motion clips (docs/CLIPS.md): the list for /clips and the mp4 proxy. The daemon serves the file with byte ranges;
// the Range header and the 206/Content-Range answer pass through untouched because Safari and iOS refuse an mp4
// whose server ignores Range, and every player seeks.
import { z } from 'zod';
import { ClipsResponse } from '@ranch/contracts';
import type { ClipRow } from '@/lib/types';
import { daemonJson, daemonFetch, UpstreamError } from './daemon.ts';

export const ClipsQuery = z.object({
  camera: z.string().max(64).optional(),
  since: z
    .string()
    .regex(/^(\d+[smhd]|\d{4}-.+)$/)
    .default('24h'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ClipsQuery = z.infer<typeof ClipsQuery>;

export const clipVideo = (id: number) => `/api/ui/clip/${id}`;

export async function getClips(q: ClipsQuery): Promise<ClipRow[]> {
  const p = new URLSearchParams({ since: q.since, limit: String(q.limit) });
  if (q.camera) {
    p.set('camera', q.camera);
  }
  const rows = await daemonJson(ClipsResponse, `/api/clips?${p}`, { timeoutMs: 10_000 });
  return rows.map((c) => ({
    id: c.id,
    camera: c.camera,
    start_ts: c.start_ts,
    duration_s: c.duration_s,
    stopped: c.stopped,
    bytes: c.bytes,
    labels: c.labels ?? [],
    video: clipVideo(c.id),
    poster: c.frame_id ? `/api/ui/frame/${c.frame_id}?w=640` : null,
  }));
}

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
