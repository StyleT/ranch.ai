'use client';
import { useEffect, useRef, useState } from 'react';
import type { FrameCard } from '@/lib/types';
import { BoxOverlay } from '@/components/overlay/BoxOverlay';
import { describe } from '@/lib/overlay/geometry';
import { localTime } from '@/lib/format';
import { useTz } from '@/lib/tz';
import { tid } from '@/lib/testids';

export function FrameCardView({ f, onOpen }: { f: FrameCard; onOpen: () => void }) {
  const tz = useTz(); const [seq, setSeq] = useState(0); const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqs = [f, ...f.burst]; const cur = seqs[seq] ?? f;
  const tally = new Map<string, number>(); for (const b of f.detections) tally.set(b.label, (tally.get(b.label) ?? 0) + 1);
  const tracked = f.detections.some((b) => (b.seen ?? 0) > 1);
  const start = () => { if (seqs.length < 2 || timer.current || !window.matchMedia('(pointer: fine)').matches) return; timer.current = setInterval(() => setSeq((s) => (s + 1) % seqs.length), 400); };
  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null; setSeq(0); };
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  return (
    <article data-testid={tid.frameCard(f.id)} id={`frame-${f.id}`} className="overflow-hidden rounded-card border border-line bg-surface">
      <button type="button" onClick={onOpen} onMouseEnter={start} onMouseLeave={stop} aria-label={`Open ${describe(f.camera, localTime(f.ts, tz), f.detections)}`} className="block w-full text-left">
        <BoxOverlay src={cur.img} alt={describe(cur.camera, localTime(cur.ts, tz), cur.detections)} width={f.width} height={f.height} boxes={cur.detections} showCaptions={false}>
          {seqs.length > 1 && <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">burst ×{seqs.length}{tracked ? ' · tracked' : ''}{seq ? ` · ${seq + 1}/${seqs.length}` : ''}</span>}
        </BoxOverlay>
      </button>
      <div className="p-2 text-xs">
        <div><b>{f.camera}</b> <time dateTime={f.ts} className="text-dim">{localTime(f.ts, tz)}</time> <span className="text-dim">· {f.reason}{f.change !== null ? ` · Δ${(100 * f.change).toFixed(1)}%` : ''}{f.period ? ` · ${f.period}` : ''}</span></div>
        <div>{tally.size ? [...tally].map(([l, n]) => `${l}${n > 1 ? ` ×${n}` : ''}`).join(', ') : <span className="text-dim">no detections</span>}</div>
      </div>
    </article>
  );
}
