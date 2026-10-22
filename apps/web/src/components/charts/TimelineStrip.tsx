'use client';
// Online history as one row of segments: ok (frames in the bucket) / bad (none) / unknown (future). Hover shows the range.
import { useState } from 'react';
import type { OnlinePoint } from '@/lib/types';
import { localTime } from '@/lib/format';
import { timeTicks, tickEvery } from '@/lib/charts/scale';

export function TimelineStrip({ points, tz, title }: { points: OnlinePoint[]; tz: string; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length || 1; const xs = points.map((p) => Date.parse(p.t)); const x0 = xs[0] ?? 0; const x1 = xs[xs.length - 1] ?? 0; const bucket = xs.length > 1 ? xs[1]! - xs[0]! : 60e3;
  const W = 1000, H = 28;
  const h = hover !== null ? points[hover] : undefined;
  const up = points.filter((p) => p.frames > 0).length;
  return (
    <figure className="m-0">
      <figcaption className="flex items-center text-xs text-dim"><span>{title}</span><span className="flex-1" />{h ? <span><time dateTime={h.t}>{localTime(h.t, tz, { second: undefined })}</time> · {h.frames > 0 ? `${h.frames} frames` : 'no frames'}</span> : <span>{Math.round((100 * up) / n)}% online</span>}</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 16}`} className="h-auto w-full" role="img" aria-label={`${title}: ${up} of ${n} buckets online`} onMouseLeave={() => setHover(null)} data-testid="chart-timeline">
        {points.map((p, i) => <rect key={p.t} x={(i * W) / n} y={0} width={Math.max(1, W / n - 1)} height={H} rx={2} className={p.frames > 0 ? 'fill-ok' : 'fill-bad'} opacity={hover === null || hover === i ? 1 : 0.55} onMouseEnter={() => setHover(i)}><title>{localTime(p.t, tz, { second: undefined })}: {p.frames} frames</title></rect>)}
        {timeTicks(x0, x1, tickEvery(x1 - x0 + bucket)).map((t) => <text key={t} x={((t - x0) / (x1 - x0 + bucket)) * W} y={H + 13} textAnchor="middle" className="fill-dim" fontSize={11}>{localTime(new Date(t).toISOString(), tz, { second: undefined })}</text>)}
      </svg>
    </figure>
  );
}
