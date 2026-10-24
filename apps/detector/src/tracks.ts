// Track association across the frames of one burst (docs/MODEL-YOLO26.md Part B): greedy same-label matching
// between consecutive members, a track's displacement from its first to its last box. Shared by the detector
// (production, main.ts) and the benchmark (bench.ts --bursts), so an evaluated burst policy uses exactly the
// production definition of "stable" and "moving" rather than a re-implementation of it.
//
// Gate (24 Oct): the original gate continued a track only when consecutive boxes overlapped (IoU >= 0.3). Measured
// against burst labels that say what moved, labeled movers shift a median 0.148 of the frame per burst while a person
// is 0.03-0.07 wide, so a walking person never overlapped itself and fragmented into one-frame tracks (20 of 67
// labeled objects; evals/results/README.md). The default gate is now the centre distance in units of the larger box
// side (`dist`), with an area-ratio bound so a distant small box is not linked to a near large one; `iou` is kept for
// comparison on the same data. Choose with RANCH_ASSOC_GATE / RANCH_ASSOC_DIST or per call.
export const MOVING_MIN = Number(process.env.RANCH_MOVING_MIN ?? 0.02); // normalized displacement that counts as movement
export const ASSOC_IOU = 0.3;                                             // `iou` gate: overlap that continues a track
export const ASSOC_DIST = Number(process.env.RANCH_ASSOC_DIST ?? 2);      // `dist` gate: centre distance / max(box sides) that continues a track
export const ASSOC_SIZE_RATIO = 4;                                        // `dist` gate: consecutive boxes may differ in area by at most this factor
export const ASSOC_GATE = (process.env.RANCH_ASSOC_GATE === 'iou' ? 'iou' : 'dist') as 'iou' | 'dist';

export interface TrackBox { id: number; label: string; raw_label?: string; confidence: number; x: number; y: number; w: number; h: number }
export interface Track { track: number; label: string; raw_label: string; seen: number; dx: number; dy: number; confidence: number; ids: number[] }
export interface AssocOpts { gate?: 'iou' | 'dist'; iou?: number; dist?: number; sizeRatio?: number }

const iou = (a: TrackBox, b: TrackBox) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i); };
const centre = (b: TrackBox) => [b.x + b.w / 2, b.y + b.h / 2] as const;

/** Association cost between a track's last box and a candidate (lower is better), or null when outside the gate. */
export function assocCost(p: TrackBox, d: TrackBox, o: Required<AssocOpts>): number | null {
  if (o.gate === 'iou') { const v = iou(p, d); return v >= o.iou ? 1 - v : null; }
  const ratio = (p.w * p.h) / Math.max(1e-9, d.w * d.h);
  if (ratio > o.sizeRatio || ratio < 1 / o.sizeRatio) return null;
  const [px, py] = centre(p), [dx, dy] = centre(d);
  const dist = Math.hypot(px - dx, py - dy) / Math.max(p.w, p.h, d.w, d.h, 1e-9);
  return dist <= o.dist ? dist : null;
}

/** Frames in burst order (seq); each box's `id` is the caller's handle and comes back in `ids`. */
export function associate(frames: { id: number; dets: TrackBox[] }[], opts: AssocOpts = {}): Track[] {
  const o: Required<AssocOpts> = { gate: opts.gate ?? ASSOC_GATE, iou: opts.iou ?? ASSOC_IOU, dist: opts.dist ?? ASSOC_DIST, sizeRatio: opts.sizeRatio ?? ASSOC_SIZE_RATIO };
  const tracks: { track: number; label: string; raw_label: string; first: TrackBox; last: TrackBox; ids: number[]; confidence: number }[] = [];
  let next = 1; let prev: { det: TrackBox; t: number }[] = [];
  for (const f of frames) {
    const cur: { det: TrackBox; t: number }[] = []; const used = new Set<number>();
    for (const d of [...f.dets].sort((a, b) => b.confidence - a.confidence)) {
      let best = -1; let bestCost = Infinity;
      prev.forEach((p, i) => { if (used.has(i) || p.det.label !== d.label) return; const c = assocCost(p.det, d, o); if (c !== null && c < bestCost) { best = i; bestCost = c; } });
      if (best >= 0) { used.add(best); const t = tracks[prev[best]!.t - 1]!; t.last = d; t.ids.push(d.id); t.confidence = Math.max(t.confidence, d.confidence); cur.push({ det: d, t: t.track }); }
      else { tracks.push({ track: next, label: d.label, raw_label: d.raw_label ?? d.label, first: d, last: d, ids: [d.id], confidence: d.confidence }); cur.push({ det: d, t: next }); next++; }
    }
    prev = cur;
  }
  return tracks.map((t) => ({ track: t.track, label: t.label, raw_label: t.raw_label, seen: t.ids.length, dx: +((t.last.x + t.last.w / 2) - (t.first.x + t.first.w / 2)).toFixed(4), dy: +((t.last.y + t.last.h / 2) - (t.first.y + t.first.h / 2)).toFixed(4), confidence: t.confidence, ids: t.ids }));
}

/** Seen in at least two members of the burst. */
export const isStable = (t: Pick<Track, 'seen'>): boolean => t.seen >= 2;
/** Moved at least MOVING_MIN of the frame between its first and last box. */
export const isMoving = (t: Pick<Track, 'dx' | 'dy'>): boolean => Math.hypot(t.dx, t.dy) >= MOVING_MIN;
