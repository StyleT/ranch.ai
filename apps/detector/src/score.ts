// Scoring per docs/EVALUATION.md §4: greedy per-class matching at an IoU threshold, per-slice precision/recall/F1,
// AP from the full confidence sweep, false positives per frame (interest classes and all classes), horse-count
// accuracy, bootstrap confidence intervals over frames, and fixed operating points. Pure functions; used by
// bench.ts for live runs and for re-scoring stored prediction files.
export interface Box {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Taxonomy subclass (horse, donkey, tractor ...) and posture, when the labeler or the model gives them. */
  kind?: string;
  posture?: string;
  /** Object id, the same across the frames of a clip; what interpolation and the clip-level objects table key on. */
  id?: string;
}
export interface Pred extends Box {
  confidence: number;
}
export interface FrameRef {
  path: string;
  camera: string;
  period: string;
  /** Clip frames: the clip they belong to and their time in it; clips are the resampling unit of the bootstrap. */
  clip_id?: number;
  t_s?: number;
  /** Native frame size, for object-size slices in pixels. */
  width?: number;
  height?: number;
  /** Video predictions: every Nth decoded frame; a slice key. */
  stride?: number;
}
export interface Scored {
  frame: FrameRef;
  gold: Box[];
  pred: Pred[];
}

import { interestLabels } from '@ranch/taxonomy';
export const interest = (family = 'coco'): readonly string[] => interestLabels(family);
export type ThresholdFn = (label: string) => number;
const thr = (t: number | ThresholdFn, label: string) => (typeof t === 'function' ? t(label) : t);

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x),
    y1 = Math.max(a.y, b.y),
    x2 = Math.min(a.x + a.w, b.x + b.w),
    y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy one-to-one matching per class; predictions sorted by confidence. Returns per-prediction hit flags, the gold
 *  box each hit matched (`pairs[i]`, null for a false positive), the class's gold boxes and the FN count. */
export function matchFrame(
  gold: Box[],
  pred: Pred[],
  label: string,
  iouMin: number,
): { hits: boolean[]; pairs: (Box | null)[]; preds: Pred[]; golds: Box[]; fn: number } {
  const g = gold.filter((b) => b.label === label);
  const used = new Set<number>();
  const preds = pred.filter((p) => p.label === label).sort((u, v) => v.confidence - u.confidence);
  const pairs = preds.map((p) => {
    let best = -1;
    let bestIou = iouMin;
    for (let i = 0; i < g.length; i++) {
      if (used.has(i)) {
        continue;
      }
      const v = iou(p, g[i]!);
      if (v >= bestIou) {
        best = i;
        bestIou = v;
      }
    }
    if (best >= 0) {
      used.add(best);
      return g[best]!;
    }
    return null;
  });
  return { hits: pairs.map((q) => q !== null), pairs, preds, golds: g, fn: g.length - used.size };
}

/** Agreement on an attribute (kind, posture) over the matched pairs where both sides carry it: accuracy and the
 *  confusion matrix gold value -> predicted value -> count. Tier 2 and the labeling-agreement table read this. */
export function attributeAgreement(
  frames: Scored[],
  label: string,
  attr: 'kind' | 'posture',
  threshold: number | ThresholdFn,
  iouMin: number,
): { pairs: number; agree: number; accuracy: number; confusion: Record<string, Record<string, number>> } {
  const confusion: Record<string, Record<string, number>> = {};
  let pairs = 0,
    agree = 0;
  for (const f of frames) {
    const m = matchFrame(
      f.gold,
      f.pred.filter((p) => p.confidence >= thr(threshold, label)),
      label,
      iouMin,
    );
    m.pairs.forEach((g, i) => {
      const gv = g?.[attr],
        pv = m.preds[i]![attr];
      if (gv === undefined || pv === undefined) {
        return;
      }
      pairs++;
      if (gv === pv) {
        agree++;
      }
      (confusion[gv] ??= {})[pv] = (confusion[gv]![pv] ?? 0) + 1;
    });
  }
  return { pairs, agree, accuracy: pairs ? agree / pairs : 0, confusion };
}

/** Recall of one class per group of gold boxes (object size bucket, posture ...): how many gold boxes of each group a
 *  prediction above the threshold matched. The grouping function sees the box and its frame. */
export function recallByGoldGroup(
  frames: Scored[],
  label: string,
  threshold: number | ThresholdFn,
  iouMin: number,
  group: (b: Box, f: FrameRef) => string | null,
): Record<string, { gold: number; tp: number; recall: number }> {
  const out: Record<string, { gold: number; tp: number; recall: number }> = {};
  for (const f of frames) {
    const m = matchFrame(
      f.gold,
      f.pred.filter((p) => p.confidence >= thr(threshold, label)),
      label,
      iouMin,
    );
    const matched = new Set(m.pairs.filter((g): g is Box => g !== null));
    for (const g of m.golds) {
      const k = group(g, f.frame);
      if (k === null) {
        continue;
      }
      const o = (out[k] ??= { gold: 0, tp: 0, recall: 0 });
      o.gold++;
      if (matched.has(g)) {
        o.tp++;
      }
    }
  }
  for (const o of Object.values(out)) {
    o.recall = o.gold ? o.tp / o.gold : 0;
  }
  return out;
}

/** Object size bucket from the gold box's long edge in native pixels: "far" under `farPx` (a horse at the back fence
 *  is ~64 px on a 2560-wide frame), "near" otherwise; null when the frame size is unknown. */
export const sizeBucket =
  (farPx = 64) =>
  (b: Box, f: FrameRef): string | null =>
    f.width && f.height ? (Math.max(b.w * f.width, b.h * f.height) < farPx ? 'far' : 'near') : null;

/** Posture grouped into the pair the alerts care about. */
export const postureGroup = (b: Box): string | null =>
  b.posture === undefined ? null : b.posture.startsWith('lying') ? 'lying' : 'upright';

/** Clip-level verdicts: a clip with a gold box of an interest class counts as found when any of its frames has a
 *  prediction of that class above the threshold matching a gold box; a clip with no interest-class gold counts as a
 *  false alarm when any frame has an interest-class prediction above the threshold. `motionSource` (from the golden
 *  per-clip rows) slices the false alarms by what moved. Frames without a clip_id are ignored. */
export function clipLevel(
  frames: Scored[],
  threshold: number | ThresholdFn,
  iouMin: number,
  labels: readonly string[],
  motionSource?: Map<number, string>,
): {
  clips: number;
  with_gold: number;
  found: number;
  recall: number;
  without_gold: number;
  false_alarms: number;
  false_alarm_rate: number;
  by_motion_source: Record<string, { clips: number; fired: number }>;
} {
  const byClip = new Map<number, Scored[]>();
  for (const f of frames) {
    if (f.frame.clip_id !== undefined) {
      (byClip.get(f.frame.clip_id) ?? byClip.set(f.frame.clip_id, []).get(f.frame.clip_id)!).push(f);
    }
  }
  let withGold = 0,
    found = 0,
    withoutGold = 0,
    falseAlarms = 0;
  const bySource: Record<string, { clips: number; fired: number }> = {};
  for (const [id, fs] of byClip) {
    const hasGold = fs.some((f) => f.gold.some((b) => labels.includes(b.label)));
    const fired = fs.some((f) =>
      f.pred.some((p) => labels.includes(p.label) && p.confidence >= thr(threshold, p.label)),
    );
    const hit = fs.some((f) =>
      labels.some((l) =>
        matchFrame(
          f.gold,
          f.pred.filter((p) => p.confidence >= thr(threshold, l)),
          l,
          iouMin,
        ).hits.some(Boolean),
      ),
    );
    if (hasGold) {
      withGold++;
      if (hit) {
        found++;
      }
    } else {
      withoutGold++;
      if (fired) {
        falseAlarms++;
      }
      const src = motionSource?.get(id) ?? 'unknown';
      const s = (bySource[src] ??= { clips: 0, fired: 0 });
      s.clips++;
      if (fired) {
        s.fired++;
      }
    }
  }
  return {
    clips: byClip.size,
    with_gold: withGold,
    found,
    recall: withGold ? found / withGold : 0,
    without_gold: withoutGold,
    false_alarms: falseAlarms,
    false_alarm_rate: withoutGold ? falseAlarms / withoutGold : 0,
    by_motion_source: bySource,
  };
}

/** Gold boxes at time t inside a clip, interpolated linearly per object id between the two labeled frames around t
 *  (the same id present in both); an object labeled on one side only is absent at t. `labeled` is the clip's labeled
 *  frames with their times; at a labeled time the boxes are returned as they are. */
export function interpolateGold(labeled: { t_s: number; boxes: Box[] }[], t: number): Box[] {
  const sorted = [...labeled].sort((u, v) => u.t_s - v.t_s);
  const exact = sorted.find((l) => Math.abs(l.t_s - t) < 1e-9);
  if (exact) {
    return exact.boxes;
  }
  const before = [...sorted].reverse().find((l) => l.t_s < t);
  const after = sorted.find((l) => l.t_s > t);
  if (!before || !after) {
    return [];
  }
  const a = (t - before.t_s) / (after.t_s - before.t_s);
  const out: Box[] = [];
  for (const b0 of before.boxes) {
    if (b0.id === undefined) {
      continue;
    }
    const b1 = after.boxes.find((b) => b.id === b0.id && b.label === b0.label);
    if (!b1) {
      continue;
    }
    out.push({
      ...b0,
      x: b0.x + (b1.x - b0.x) * a,
      y: b0.y + (b1.y - b0.y) * a,
      w: b0.w + (b1.w - b0.w) * a,
      h: b0.h + (b1.h - b0.h) * a,
    });
  }
  return out;
}

/** Throughput of a video run from its per-frame timings: decode and inference percentiles, frames per second the
 *  pipeline sustained, and how many cameras at a native rate fit under the headroom rule (the bottleneck stage bounds
 *  the pipeline). */
export function throughput(
  rows: { decode_ms: number; ms: number }[],
  opts: { headroom?: number; camera_fps?: number[]; wall_s?: number } = {},
): {
  frames: number;
  decode_ms: { p50: number; p95: number };
  infer_ms: { p50: number; p95: number };
  fps_pipeline: number;
  fps_wall: number | null;
  cameras_at_native: Record<string, number>;
} {
  const headroom = opts.headroom ?? 0.7;
  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((u, v) => u - v);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  };
  const dec = rows.map((r) => r.decode_ms),
    inf = rows.map((r) => r.ms);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const bottleneck = Math.max(mean(dec), mean(inf));
  const fpsPipeline = bottleneck > 0 ? 1000 / bottleneck : 0;
  const fpsWall = opts.wall_s ? rows.length / opts.wall_s : null;
  const capacity = fpsWall !== null ? Math.min(fpsPipeline, fpsWall) : fpsPipeline;
  return {
    frames: rows.length,
    decode_ms: { p50: pct(dec, 0.5), p95: pct(dec, 0.95) },
    infer_ms: { p50: pct(inf, 0.5), p95: pct(inf, 0.95) },
    fps_pipeline: fpsPipeline,
    fps_wall: fpsWall,
    cameras_at_native: Object.fromEntries(
      (opts.camera_fps ?? [15, 20]).map((f) => [`${f}fps`, Math.floor((headroom * capacity) / f)]),
    ),
  };
}

export interface ClassMetrics {
  label: string;
  gold: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  ap: number;
}

export function classMetrics(
  frames: Scored[],
  label: string,
  threshold: number | ThresholdFn,
  iouMin: number,
): ClassMetrics {
  let tp = 0,
    fp = 0,
    fn = 0,
    gold = 0;
  const sweep: { conf: number; hit: boolean }[] = [];
  for (const f of frames) {
    const all = matchFrame(f.gold, f.pred, label, iouMin); // AP uses every prediction (threshold 0.05 files)
    gold += f.gold.filter((b) => b.label === label).length;
    all.preds.forEach((p, i) => sweep.push({ conf: p.confidence, hit: all.hits[i]! }));
    const at = matchFrame(
      f.gold,
      f.pred.filter((p) => p.confidence >= thr(threshold, label)),
      label,
      iouMin,
    );
    tp += at.hits.filter(Boolean).length;
    fp += at.hits.filter((h) => !h).length;
    fn += at.fn;
  }
  // AP: precision envelope over recall from the confidence sweep (COCO-style all-point interpolation)
  sweep.sort((u, v) => v.conf - u.conf);
  let ctp = 0,
    cfp = 0;
  const pts: { r: number; p: number }[] = [];
  for (const s of sweep) {
    if (s.hit) {
      ctp++;
    } else {
      cfp++;
    }
    pts.push({ r: gold ? ctp / gold : 0, p: ctp / (ctp + cfp) });
  }
  let ap = 0,
    prevR = 0;
  for (let i = 0; i < pts.length; i++) {
    const pMax = Math.max(...pts.slice(i).map((q) => q.p));
    ap += (pts[i]!.r - prevR) * pMax;
    prevR = pts[i]!.r;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0,
    recall = gold ? tp / gold : 0;
  return {
    label,
    gold,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    ap: gold ? ap : 0,
  };
}

export function fppf(
  frames: Scored[],
  threshold: number | ThresholdFn,
  iouMin: number,
  labels?: readonly string[],
): number {
  if (!frames.length) {
    return 0;
  }
  let fp = 0;
  const labs = labels ?? [...new Set(frames.flatMap((f) => f.pred.map((p) => p.label)))];
  for (const f of frames) {
    for (const l of labs) {
      const m = matchFrame(
        f.gold,
        f.pred.filter((p) => p.confidence >= thr(threshold, l)),
        l,
        iouMin,
      );
      fp += m.hits.filter((h) => !h).length;
    }
  }
  return fp / frames.length;
}

export function countAccuracy(
  frames: Scored[],
  threshold: number | ThresholdFn,
  label = 'horse',
): { mae: number; exact: number } {
  if (!frames.length) {
    return { mae: 0, exact: 0 };
  }
  let err = 0,
    exact = 0;
  for (const f of frames) {
    const g = f.gold.filter((b) => b.label === label).length;
    const p = f.pred.filter((b) => b.label === label && b.confidence >= thr(threshold, label)).length;
    err += Math.abs(g - p);
    if (g === p) {
      exact++;
    }
  }
  return { mae: err / frames.length, exact: exact / frames.length };
}

/** 95 % bootstrap interval for a statistic of the frame list. The resampling unit is the clip when every frame has a
 *  clip_id (frames of one clip are correlated; resampling them one by one understates the interval), the frame
 *  otherwise. */
export function bootstrap(
  frames: Scored[],
  stat: (fs: Scored[]) => number,
  n = 1000,
  seed = 1,
): { lo: number; hi: number } {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const byClip = frames.every((f) => f.frame.clip_id !== undefined);
  const units: Scored[][] = byClip
    ? [...Map.groupBy(frames, (f) => f.frame.clip_id!).values()]
    : frames.map((f) => [f]);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample = Array.from({ length: units.length }, () => units[Math.floor(rand() * units.length)]!).flat();
    vals.push(stat(sample));
  }
  vals.sort((a, b) => a - b);
  return { lo: vals[Math.floor(0.025 * n)] ?? 0, hi: vals[Math.min(n - 1, Math.floor(0.975 * n))] ?? 0 };
}

/** Operating points: horse recall at FPPF(all) <= budget, horse recall at precision >= 0.9, with the thresholds found. */
export function operatingPoints(
  frames: Scored[],
  iouMin: number,
): {
  r_at_fppf01: { recall: number; threshold: number | null };
  r_at_p90: { recall: number; threshold: number | null };
} {
  const ths = Array.from({ length: 19 }, (_, i) => +(0.05 + i * 0.05).toFixed(2));
  let best1: { recall: number; threshold: number | null } = { recall: 0, threshold: null };
  let best2: { recall: number; threshold: number | null } = { recall: 0, threshold: null };
  for (const t of ths) {
    const m = classMetrics(frames, 'horse', t, iouMin);
    if (fppf(frames, t, iouMin) <= 0.1 && m.recall >= best1.recall) {
      best1 = { recall: m.recall, threshold: t };
    }
    if (m.precision >= 0.9 && m.recall >= best2.recall) {
      best2 = { recall: m.recall, threshold: t };
    }
  }
  return { r_at_fppf01: best1, r_at_p90: best2 };
}

export function slices(frames: Scored[]): Record<string, Scored[]> {
  const out: Record<string, Scored[]> = { all: frames };
  for (const f of frames) {
    (out[`period:${f.frame.period}`] ??= []).push(f);
    (out[`camera:${f.frame.camera}`] ??= []).push(f);
    if (f.frame.stride !== undefined) {
      (out[`stride:${f.frame.stride}`] ??= []).push(f);
    }
  }
  return out;
}

export function scoreSet(
  frames: Scored[],
  opts: {
    threshold: number | ThresholdFn;
    iou: number;
    labels?: string[];
    thresholdsByLabel?: Record<string, number>;
    family?: string;
    /** Per-clip `motion_source` from the golden clip rows, for the clip-level false alarms. */
    motionSource?: Map<number, string>;
  },
): Record<string, unknown> {
  const labels = opts.labels ?? [...new Set(frames.flatMap((f) => f.gold.map((b) => b.label)))].sort();
  const hasAttr = (attr: 'kind' | 'posture') =>
    frames.some((f) => f.gold.some((b) => b[attr] !== undefined)) &&
    frames.some((f) => f.pred.some((p) => p[attr] !== undefined));
  const hasClips = frames.some((f) => f.frame.clip_id !== undefined);
  const bySlice: Record<string, unknown> = {};
  for (const [name, fs] of Object.entries(slices(frames))) {
    const horse = classMetrics(fs, 'horse', opts.threshold, opts.iou);
    bySlice[name] = {
      frames: fs.length,
      classes: Object.fromEntries(labels.map((l) => [l, classMetrics(fs, l, opts.threshold, opts.iou)])),
      fppf_interest: fppf(fs, opts.threshold, opts.iou, interest(opts.family)),
      fppf_all: fppf(fs, opts.threshold, opts.iou),
      horse_count: countAccuracy(fs, opts.threshold),
      horse_recall_ci:
        name === 'all' || fs.length >= 20
          ? bootstrap(fs, (s) => classMetrics(s, 'horse', opts.threshold, opts.iou).recall)
          : null,
      horse_ap: horse.ap,
      horse_recall_by_size: recallByGoldGroup(fs, 'horse', opts.threshold, opts.iou, sizeBucket()),
      horse_recall_by_posture: recallByGoldGroup(fs, 'horse', opts.threshold, opts.iou, postureGroup),
      ...(hasAttr('kind') ? { kind_agreement: attributeAgreement(fs, 'horse', 'kind', opts.threshold, opts.iou) } : {}),
      ...(hasAttr('posture')
        ? { posture_agreement: attributeAgreement(fs, 'horse', 'posture', opts.threshold, opts.iou) }
        : {}),
      ...(hasClips && (name === 'all' || !name.startsWith('stride'))
        ? { clips: clipLevel(fs, opts.threshold, opts.iou, interest(opts.family), opts.motionSource) }
        : {}),
    };
  }
  return {
    threshold: typeof opts.threshold === 'function' ? 'per-label' : opts.threshold,
    thresholds_by_label: opts.thresholdsByLabel ?? null,
    iou: opts.iou,
    labels,
    bootstrap_unit: frames.every((f) => f.frame.clip_id !== undefined) ? 'clip' : 'frame',
    operating_points: operatingPoints(frames, opts.iou),
    slices: bySlice,
  };
}
