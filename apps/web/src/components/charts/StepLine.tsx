'use client';
// Single-series step line for per-minute counts: gaps stay gaps, a crosshair + tooltip on hover, integer ticks,
// recessive grid; a table view toggle for accessibility (docs/WEB-DASHBOARD.md §4.3, dataviz method).
import { useId, useState } from 'react';
import type { SeriesPoint } from '@/lib/types';
import { linear, intTicks, timeTicks, tickEvery, nearestIndex } from '@/lib/charts/scale';
import { localTime } from '@/lib/format';

export function StepLine({ points, tz, title, height = 160, unit = '' }: { points: SeriesPoint[]; tz: string; title: string; height?: number; unit?: string }) {
  const id = useId(); const [hover, setHover] = useState<number | null>(null); const [table, setTable] = useState(false);
  const W = 1000, H = height, padL = 28, padR = 8, padT = 10, padB = 22;
  const xs = points.map((p) => Date.parse(p.t)); const x0 = xs[0] ?? 0, x1 = xs[xs.length - 1] ?? 1;
  const span = x1 - x0 || 1; const bucket = xs.length > 1 ? xs[1]! - xs[0]! : 60e3;
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  const sx = linear(x0, x1 + bucket, padL, W - padR), sy = linear(0, max, H - padB, padT);
  // step path per contiguous run of non-null values
  const segs: string[] = []; let d = '';
  points.forEach((p, i) => { if (p.value === null) { if (d) segs.push(d); d = ''; return; } const X = sx(xs[i]!), Y = sy(p.value), X2 = sx(xs[i]! + bucket); d += d ? ` H${X.toFixed(1)} V${Y.toFixed(1)} H${X2.toFixed(1)}` : `M${X.toFixed(1)},${Y.toFixed(1)} H${X2.toFixed(1)}`; });
  if (d) segs.push(d);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; const t = x0 + ((px - padL) / (W - padL - padR)) * (span + bucket); setHover(nearestIndex(xs, t)); };
  const hp = hover !== null ? points[hover] : undefined;
  return (
    <figure className="m-0" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="flex items-center text-xs text-dim"><span>{title}</span><span className="flex-1" /><button type="button" className="min-h-touch px-2 text-xs text-dim underline-offset-2 hover:underline" onClick={() => setTable((v) => !v)} aria-pressed={table}>{table ? 'as chart' : 'as table'}</button></figcaption>
      {table ? (
        <div className="max-h-48 overflow-auto"><table className="w-full text-xs"><caption className="sr-only">{title}</caption><thead><tr><th className="text-left">time</th><th className="text-right">value</th></tr></thead><tbody>{points.filter((p) => p.value !== null).map((p) => <tr key={p.t}><td><time dateTime={p.t}>{localTime(p.t, tz, { second: undefined })}</time></td><td className="text-right">{p.value}{unit}</td></tr>)}</tbody></table></div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}: ${points.filter((p) => p.value !== null).length} points, max ${max}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} data-testid="chart-stepline">
            {intTicks(max).map((v) => <g key={v}><line x1={padL} x2={W - padR} y1={sy(v)} y2={sy(v)} className="stroke-line" strokeWidth={1} /><text x={padL - 6} y={sy(v) + 4} textAnchor="end" className="fill-dim" fontSize={11}>{v}</text></g>)}
            {timeTicks(x0, x1, tickEvery(span)).map((t) => <text key={t} x={sx(t)} y={H - 6} textAnchor="middle" className="fill-dim" fontSize={11}>{localTime(new Date(t).toISOString(), tz, { second: undefined })}</text>)}
            {segs.map((s, i) => <path key={i} d={s} fill="none" className="stroke-chart-1" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />)}
            {hover !== null && hp && hp.value !== null && <g><line x1={sx(xs[hover]! + bucket / 2)} x2={sx(xs[hover]! + bucket / 2)} y1={padT} y2={H - padB} className="stroke-dim" strokeDasharray="3 3" /><circle cx={sx(xs[hover]! + bucket / 2)} cy={sy(hp.value)} r={5} className="fill-chart-1 stroke-surface" strokeWidth={2} /></g>}
          </svg>
          {hp && hp.value !== null && <div role="status" className="pointer-events-none absolute top-1 right-2 rounded bg-surface-2 px-2 py-1 text-xs"><time dateTime={hp.t}>{localTime(hp.t, tz, { second: undefined })}</time> · <b>{hp.value}{unit}</b></div>}
        </div>
      )}
    </figure>
  );
}
