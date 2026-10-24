// Track association across the frames of one burst (docs/MODEL-YOLO26.md Part B): greedy same-label IoU matching
// between consecutive members, a track's displacement from its first to its last box. Shared by the detector
// (production, main.ts) and the benchmark (bench.ts --bursts), so an evaluated burst policy uses exactly the
// production definition of "stable" and "moving" rather than a re-implementation of it.
export const MOVING_MIN = Number(process.env.RANCH_MOVING_MIN ?? 0.02); // normalized displacement that counts as movement
export const ASSOC_IOU = 0.3;                                             // same-label IoU that continues a track

export interface TrackBox { id: number; label: string; raw_label?: string; confidence: number; x: number; y: number; w: number; h: number }
export interface Track { track: number; label: string; raw_label: string; seen: number; dx: number; dy: number; confidence: number; ids: number[] }

const iou = (a: TrackBox, b: TrackBox) => { const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i); };

/** Frames in burst order (seq); each box's `id` is the caller's handle and comes back in `ids`. */
export function associate(frames: { id: number; dets: TrackBox[] }[]): Track[] {
  const tracks: { track: number; label: string; raw_label: string; first: TrackBox; last: TrackBox; ids: number[]; confidence: number }[] = [];
  let next = 1; let prev: { det: TrackBox; t: number }[] = [];
  for (const f of frames) {
    const cur: { det: TrackBox; t: number }[] = []; const used = new Set<number>();
    for (const d of [...f.dets].sort((a, b) => b.confidence - a.confidence)) {
      let best = -1; let bestIou = ASSOC_IOU;
      prev.forEach((p, i) => { if (!used.has(i) && p.det.label === d.label) { const v = iou(p.det, d); if (v >= bestIou) { best = i; bestIou = v; } } });
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
