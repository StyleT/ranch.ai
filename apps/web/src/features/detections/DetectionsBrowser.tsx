'use client';
// The frames list with filters (URL state), infinite paging, cards with hover playback, and the viewer. Reused by the
// camera page with the camera locked.
import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseFilters, serializeFilters, type FilterState } from '@/lib/filters/urlState';
import { useDetections, useFrame } from './useDetections';
import { FilterBar } from './FilterBar';
import { FrameCardView } from './FrameCardView';
import { Viewer } from './Viewer';
import { Button, Skeleton } from '@/components/ui';

export function DetectionsBrowser({ cameras, labels, lockCamera, cols = 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' }: { cameras: string[]; labels: string[]; lockCamera?: string; cols?: string }) {
  const sp = useSearchParams(); const router = useRouter(); const path = usePathname();
  const f = useMemo<FilterState>(() => { const p = parseFilters(sp); return lockCamera ? { ...p, camera: lockCamera } : p; }, [sp, lockCamera]);
  const setF = useCallback((next: Partial<FilterState>) => { const n = { ...f, ...next }; if (lockCamera) n.camera = lockCamera; const q = serializeFilters(lockCamera ? { ...n, camera: null } : n); router.replace(`${path}${q ? `?${q}` : ''}`, { scroll: false }); }, [f, lockCamera, path, router]);
  const q = useDetections(f);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const idx = f.frame !== null ? items.findIndex((i) => i.id === f.frame) : -1;
  const direct = useFrame(f.frame !== null && idx < 0 ? f.frame : null);
  const open = idx >= 0 ? items[idx] : direct.data ?? null;
  return (
    <div className="grid gap-3">
      <FilterBar f={f} onChange={setF} cameras={cameras} labels={labels} lockCamera={!!lockCamera} />
      <p className="text-xs text-dim" aria-live="polite" data-loaded={q.isSuccess ? 'true' : 'false'} data-source={q.data?.pages[0]?.source ?? 'live'}>{q.isPending ? 'loading…' : `${items.length}${q.hasNextPage ? '+' : ''} ${q.data?.pages[0]?.source === 'baseline' ? 'baseline frames · gold boxes dashed' : 'frames'}`}</p>
      {q.isError && <p role="alert" className="text-sm text-bad">could not load frames</p>}
      <div className={`grid gap-3 ${cols}`}>
        {q.isPending ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-video" />) : items.map((it) => <FrameCardView key={it.id} f={it} onOpen={() => setF({ frame: it.id, seq: 0 })} />)}
      </div>
      {q.hasNextPage && <div className="text-center"><Button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? 'loading…' : 'older…'}</Button></div>}
      {open && <Viewer frame={open} seq={f.seq} hasPrev={idx > 0} hasNext={idx >= 0 && (idx < items.length - 1 || !!q.hasNextPage)} onSeq={(s) => setF({ seq: s })}
        onPrev={() => { if (idx > 0) setF({ frame: items[idx - 1]!.id, seq: 0 }); }}
        onNext={() => { if (idx < items.length - 1) setF({ frame: items[idx + 1]!.id, seq: 0 }); else if (q.hasNextPage) void q.fetchNextPage(); }}
        onClose={() => setF({ frame: null, seq: 0 })} />}
    </div>
  );
}
