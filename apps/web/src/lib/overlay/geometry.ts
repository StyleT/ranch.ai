// Pure geometry for the box overlay (docs/WEB-DASHBOARD.md §4.3). Boxes are normalized (0..1, origin top-left).
import type { Box } from '@/lib/types';
export const MOVING_MIN = 0.02;
export const pctBox = (b: Pick<Box, 'x' | 'y' | 'w' | 'h'>) => ({ left: `${(100 * clamp01(b.x)).toFixed(3)}%`, top: `${(100 * clamp01(b.y)).toFixed(3)}%`, width: `${(100 * Math.min(b.w, 1 - clamp01(b.x))).toFixed(3)}%`, height: `${(100 * Math.min(b.h, 1 - clamp01(b.y))).toFixed(3)}%` });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const isMoving = (b: Pick<Box, 'dx' | 'dy'>) => b.dx !== null && b.dy !== null && Math.hypot(b.dx, b.dy) >= MOVING_MIN;
export const isStable = (b: Pick<Box, 'seen'>) => (b.seen ?? 0) >= 2;
/** Motion arrow in a 0..1000 coordinate space: from where the centre was to where it is. */
export function arrow(b: Pick<Box, 'x' | 'y' | 'w' | 'h' | 'dx' | 'dy'>): { x1: number; y1: number; x2: number; y2: number } | null {
  if (!isMoving(b)) return null;
  const cx = (b.x + b.w / 2) * 1000, cy = (b.y + b.h / 2) * 1000;
  return { x1: cx - b.dx! * 1000, y1: cy - b.dy! * 1000, x2: cx, y2: cy };
}
export function caption(b: Pick<Box, 'label' | 'raw_label' | 'confidence' | 'seen' | 'gold'>): string {
  const base = b.raw_label && b.raw_label !== b.label ? `${b.label} ← ${b.raw_label}` : b.label;
  const conf = b.gold ? '' : ` ${b.confidence.toFixed(2)}`;
  const seen = (b.seen ?? 0) > 1 ? ` ×${b.seen}` : '';
  return `${base}${conf}${seen}`;
}
export type LabelKind = 'horse' | 'person' | 'vehicle' | 'gold' | 'other';
export function labelKind(b: Pick<Box, 'label' | 'gold'>): LabelKind {
  if (b.gold) return 'gold';
  const l = b.label.split('/')[0] ?? b.label;
  if (l === 'horse' || l === 'donkey') return 'horse';
  if (l === 'person') return 'person';
  if (['car', 'truck', 'delivery_vehicle', 'tractor', 'atv', 'trailer'].includes(l)) return 'vehicle';
  return 'other';
}
/** Accessible description of a frame: "donkey_cam 14:02:11, horse ×2, person". */
export function describe(camera: string, time: string, boxes: Pick<Box, 'label'>[]): string {
  const tally = new Map<string, number>(); for (const b of boxes) tally.set(b.label, (tally.get(b.label) ?? 0) + 1);
  const parts = [...tally].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
  return `${camera} ${time}${parts.length ? ', ' + parts.join(', ') : ', no detections'}`;
}
