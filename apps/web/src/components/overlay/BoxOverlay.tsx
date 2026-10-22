// Frame image with detection boxes and motion arrows drawn over it from normalized coordinates. Nothing is rendered
// server-side into the image; boxes are an SVG layer, captions are HTML so text never stretches.
import type { Box } from '@/lib/types';
import { pctBox, arrow, caption, labelKind } from '@/lib/overlay/geometry';
import { FrameImage } from './FrameImage';

const KIND_CLASS = { horse: 'border-label-horse', person: 'border-label-person', vehicle: 'border-label-vehicle', gold: 'border-label-gold border-dashed', other: 'border-label-other' } as const;
const KIND_BG = { horse: 'bg-label-horse', person: 'bg-label-person', vehicle: 'bg-label-vehicle', gold: 'bg-label-gold', other: 'bg-label-other' } as const;
const KIND_STROKE = { horse: 'stroke-label-horse', person: 'stroke-label-person', vehicle: 'stroke-label-vehicle', gold: 'stroke-label-gold', other: 'stroke-label-other' } as const;

export function BoxOverlay({ src, alt, width, height, boxes, showCaptions = true, sizes, priority, children, className = '' }: {
  src: string; alt: string; width: number | null; height: number | null; boxes: Box[]; showCaptions?: boolean; sizes?: string; priority?: boolean; children?: React.ReactNode; className?: string;
}) {
  const ratio = width && height ? `${width} / ${height}` : '16 / 9';
  return (
    <div className={`relative overflow-hidden bg-black ${className}`} style={{ aspectRatio: ratio }}>
      <FrameImage src={src} alt={alt} {...(sizes ? { sizes } : {})} {...(priority ? { priority } : {})} />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
        {boxes.map((b, i) => { const a = arrow(b); return a ? <g key={i}><line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} className={KIND_STROKE[labelKind(b)]} strokeWidth={2} vectorEffect="non-scaling-stroke" /><circle cx={a.x2} cy={a.y2} r={6} className={KIND_STROKE[labelKind(b)]} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" /></g> : null; })}
      </svg>
      {boxes.map((b, i) => { const k = labelKind(b); return (
        <div key={i} className={`pointer-events-none absolute rounded-sm border-2 ${KIND_CLASS[k]}`} style={pctBox(b)} data-label={b.label}>
          {showCaptions && <span className={`absolute -top-5 -left-0.5 whitespace-nowrap rounded-sm px-1 text-[11px] leading-5 text-black ${KIND_BG[k]}`}>{caption(b)}</span>}
        </div>
      ); })}
      {children}
    </div>
  );
}
