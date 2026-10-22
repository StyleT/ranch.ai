'use client';
// Full-screen viewer (native <dialog>): ←/→ frame, ↑/↓ burst member, Space autoplay, Esc; swipe and long-press on touch.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { FrameCard } from '@/lib/types';
import { BoxOverlay } from '@/components/overlay/BoxOverlay';
import { caption, describe } from '@/lib/overlay/geometry';
import { localTime } from '@/lib/format';
import { useTz } from '@/lib/tz';
import { tid } from '@/lib/testids';
import { initialGesture, onPointerDown, onPointerMove, onPointerUp, onHoldTimer, HOLD_MS, type GestureState } from '@/lib/gestures/swipe';
import { Button } from '@/components/ui';

export function Viewer({ frame, seq, hasPrev, hasNext, onSeq, onPrev, onNext, onClose }: { frame: FrameCard; seq: number; hasPrev: boolean; hasNext: boolean; onSeq: (s: number) => void; onPrev: () => void; onNext: () => void; onClose: () => void }) {
  const tz = useTz(); const ref = useRef<HTMLDialogElement>(null); const seqs = [frame, ...frame.burst]; const cur = seqs[Math.min(seq, seqs.length - 1)] ?? frame;
  const [playing, setPlaying] = useState(false); const g = useRef<GestureState>(initialGesture()); const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); return () => { if (d?.open) d.close(); }; }, []);
  useEffect(() => { if (!playing || seqs.length < 2) return; const t = setInterval(() => onSeq((seq + 1) % seqs.length), 500); return () => clearInterval(t); }, [playing, seq, seqs.length, onSeq]);
  useEffect(() => { for (const m of seqs) { const i = new Image(); i.src = `${m.img}?w=1280`; } }, [frame.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') onPrev(); else if (e.key === 'ArrowRight') onNext();
    else if (e.key === 'ArrowDown') { e.preventDefault(); onSeq(Math.min(seqs.length - 1, seq + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); onSeq(Math.max(0, seq - 1)); }
    else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); } else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  const act = (actions: string[]) => { for (const a of actions) { if (a === 'prev') onPrev(); else if (a === 'next') onNext(); else if (a === 'member-next') onSeq(Math.min(seqs.length - 1, seq + 1)); else if (a === 'member-prev') onSeq(Math.max(0, seq - 1)); else if (a === 'autoplay-start') setPlaying(true); else if (a === 'autoplay-stop') setPlaying(false); } };
  const pd = (e: React.PointerEvent) => { if (e.pointerType === 'mouse') return; g.current = onPointerDown(g.current, e.clientX, e.clientY, e.timeStamp); hold.current = setTimeout(() => { const r = onHoldTimer(g.current); g.current = r.state; act(r.actions); }, HOLD_MS); };
  const pm = (e: React.PointerEvent) => { if (e.pointerType === 'mouse') return; g.current = onPointerMove(g.current, e.clientX, e.clientY); };
  const pu = (e: React.PointerEvent) => { if (e.pointerType === 'mouse') return; if (hold.current) clearTimeout(hold.current); const r = onPointerUp(g.current, e.clientX, e.clientY, e.timeStamp); g.current = r.state; act(r.actions.filter((a) => a !== 'tap')); };
  const time = localTime(frame.ts, tz);
  return (
    <dialog ref={ref} data-testid={tid.viewer} aria-labelledby="viewer-title" onKeyDown={onKey} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} className="m-0 h-dvh max-h-dvh w-screen max-w-none bg-bg p-0 text-fg backdrop:bg-black/80 md:m-auto md:h-auto md:max-h-[92dvh] md:w-[92vw] md:rounded-card">
      <div className="flex h-full flex-col">
        <div className="flex min-h-touch items-center gap-2 px-3 text-sm">
          <Button onClick={onClose} aria-label="Close viewer">✕</Button>
          <span id="viewer-title" className="min-w-0 flex-1 truncate"><b>{frame.camera}</b> <time dateTime={frame.ts}>{time}</time> · #{frame.id} · {frame.reason}{frame.change !== null ? ` · Δ${(100 * frame.change).toFixed(1)}%` : ''}{seqs.length > 1 ? ` · burst ${Math.min(seq, seqs.length - 1) + 1}/${seqs.length}` : ''}</span>
          <Link href={`/cameras/${frame.camera}`} className="hidden text-accent md:inline">open camera ›</Link>
        </div>
        <div className="relative min-h-0 flex-1 touch-none select-none" onPointerDown={pd} onPointerMove={pm} onPointerUp={pu} onPointerCancel={pu}>
          <BoxOverlay src={cur.img} alt={describe(cur.camera, time, cur.detections)} width={frame.width} height={frame.height} boxes={cur.detections} sizes="92vw" priority className="mx-auto max-h-full" />
        </div>
        {seqs.length > 1 && (
          <div className="flex items-center gap-2 px-3 py-1">
            <div role="tablist" aria-label="Burst frames" className="flex gap-1">{seqs.map((m, i) => <button key={m.id} role="tab" aria-selected={i === seq} data-testid={tid.viewerMember(i)} onClick={() => onSeq(i)} className={`h-10 w-16 overflow-hidden rounded-sm border-2 ${i === seq ? 'border-accent' : 'border-transparent'}`}><img src={`${m.img}?w=320`} alt={`frame ${i + 1}`} className="h-full w-full object-cover" /></button>)}</div>
            <input type="range" aria-label="Burst member" min={0} max={seqs.length - 1} value={Math.min(seq, seqs.length - 1)} onChange={(e) => onSeq(Number(e.target.value))} className="min-h-touch flex-1" />
            <Button onClick={() => setPlaying((p) => !p)} aria-pressed={playing} aria-label={playing ? 'Pause burst' : 'Play burst'}>{playing ? '❚❚' : '▶'}</Button>
          </div>
        )}
        <div className="flex items-center gap-2 px-3 pb-[max(8px,env(safe-area-inset-bottom))] text-xs">
          <Button onClick={onPrev} disabled={!hasPrev} aria-label="Previous frame">‹ prev</Button>
          <span data-testid="viewer-caption-list" className="min-w-0 flex-1 truncate">{cur.detections.length ? cur.detections.map((b) => caption(b)).join(' · ') : 'no detections'}</span>
          <Button onClick={() => void navigator.clipboard?.writeText(location.href)} aria-label="Copy link">⧉</Button>
          <Button onClick={onNext} disabled={!hasNext} aria-label="Next frame">next ›</Button>
        </div>
      </div>
    </dialog>
  );
}
