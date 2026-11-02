'use client';
// Motion clips (docs/CLIPS.md): what moved on the ranch, as video. Posters are the clips' first sampled frames; a
// clip's bytes travel only when it is played (preload none), so a page of 100 clips costs the mini 100 thumbnails.
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import type { ClipRow } from '@/lib/types';
import { Card, Section, Skeleton } from '@/components/ui';
import { localDateTime } from '@/lib/format';
import { useTz } from '@/lib/tz';
import { tid } from '@/lib/testids';

const SINCE = ['6h', '24h', '7d'] as const;

export function ClipsView() {
  const tz = useTz();
  const sp = useSearchParams();
  const router = useRouter();
  const since = SINCE.find((s) => s === sp.get('since')) ?? '24h';
  const camera = sp.get('camera') ?? '';
  const params = new URLSearchParams({ since, ...(camera ? { camera } : {}) }).toString();
  const q = useQuery({
    queryKey: keys.clips(params),
    queryFn: () => apiGet<ClipRow[]>(`/api/ui/clips?${params}`),
    staleTime: 30_000,
  });
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) {
      n.set(k, v);
    } else {
      n.delete(k);
    }
    router.replace(`/clips?${n}`);
  };
  if (q.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card role="alert" className="text-bad">
        clips unavailable
      </Card>
    );
  }
  const cameras = [...new Set(q.data.map((c) => c.camera))].sort();
  return (
    <Section title={`Clips · ${q.data.length} in the last ${since}`}>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <select
          aria-label="Window"
          value={since}
          onChange={(e) => set('since', e.target.value)}
          className="border-line bg-surface min-h-touch rounded-sm border px-2"
        >
          {SINCE.map((s) => (
            <option key={s} value={s}>
              last {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Camera"
          data-testid="filter-camera"
          value={camera}
          onChange={(e) => set('camera', e.target.value)}
          className="border-line bg-surface min-h-touch rounded-sm border px-2"
        >
          <option value="">all cameras</option>
          {(camera && !cameras.includes(camera) ? [...cameras, camera] : cameras).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {q.data.length === 0 ? (
        <Card className="text-dim">no clips in this window</Card>
      ) : (
        <div data-loaded="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.map((c) => (
            <article
              key={c.id}
              data-testid={tid.clipCard(c.id)}
              className="rounded-card border-line bg-surface overflow-hidden border"
            >
              <video
                src={c.video}
                poster={c.poster ?? undefined}
                controls
                playsInline
                preload="none"
                className="aspect-video w-full bg-black"
                aria-label={`${c.camera} clip at ${localDateTime(c.start_ts, tz)}`}
              />
              <div className="p-2 text-xs">
                <div>
                  <b>{c.camera}</b>{' '}
                  <time dateTime={c.start_ts} className="text-dim">
                    {localDateTime(c.start_ts, tz)}
                  </time>
                </div>
                <div className="text-dim">
                  {c.duration_s !== null ? `${Math.round(c.duration_s)} s` : '–'}
                  {c.stopped ? ` · ended: ${c.stopped}` : ''}
                  {c.bytes !== null ? ` · ${(c.bytes / 1e6).toFixed(1)} MB` : ''}
                </div>
                <div>{c.labels.length ? c.labels.join(', ') : <span className="text-dim">no detections</span>}</div>
              </div>
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}
