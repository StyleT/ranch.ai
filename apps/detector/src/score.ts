// Scoring per docs/EVALUATION.md §4: greedy per-class matching at an IoU threshold, per-slice precision/recall/F1,
// AP from the full confidence sweep, false positives per frame (interest classes and all classes), horse-count
// accuracy, bootstrap confidence intervals over frames, and fixed operating points. Pure functions; used by
// bench.ts for live runs and for re-scoring stored prediction files.
export interface Box { label: string; x: number; y: number; w: number; h: number }
export interface Pred extends Box { confidence: number }
export interface FrameRef { path: string; camera: string; period: string }
export interface Scored { frame: FrameRef; gold: Box[]; pred: Pred[] }

import { interestLabels } from '@ranch/taxonomy';
export const INTEREST: readonly string[] = interestLabels('coco');
export type ThresholdFn = (label: string) => number;
const thr = (t: number | ThresholdFn, label: string) => (typeof t === 'function' ? t(label) : t);

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy one-to-one matching per class; predictions sorted by confidence. Returns per-prediction hit flags and FN count. */
export function matchFrame(gold: Box[], pred: Pred[], label: string, iouMin: number): { hits: boolean[]; preds: Pred[]; fn: number } {
  const g = gold.filter((b) => b.label === label); const used = new Set<number>();
  const preds = pred.filter((p) => p.label === label).sort((u, v) => v.confidence - u.confidence);
  const hits = preds.map((p) => { let best = -1; let bestIou = iouMin; for (let i = 0; i < g.length; i++) { if (used.has(i)) continue; const v = iou(p, g[i]!); if (v >= bestIou) { best = i; bestIou = v; } } if (best >= 0) { used.add(best); return true; } return false; });
  return { hits, preds, fn: g.length - used.size };
}

export interface ClassMetrics { label: string; gold: number; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number; ap: number }

export function classMetrics(frames: Scored[], label: string, threshold: number | ThresholdFn, iouMin: number): ClassMetrics {
  let tp = 0, fp = 0, fn = 0, gold = 0;
  const sweep: { conf: number; hit: boolean }[] = [];
  for (const f of frames) {
    const all = matchFrame(f.gold, f.pred, label, iouMin); // AP uses every prediction (threshold 0.05 files)
    gold += f.gold.filter((b) => b.label === label).length;
    all.preds.forEach((p, i) => sweep.push({ conf: p.confidence, hit: all.hits[i]! }));
    const at = matchFrame(f.gold, f.pred.filter((p) => p.confidence >= thr(threshold, label)), label, iouMin);
    tp += at.hits.filter(Boolean).length; fp += at.hits.filter((h) => !h).length; fn += at.fn;
  }
  // AP: precision envelope over recall from the confidence sweep (COCO-style all-point interpolation)
  sweep.sort((u, v) => v.conf - u.conf);
  let ctp = 0, cfp = 0; const pts: { r: number; p: number }[] = [];
  for (const s of sweep) { if (s.hit) ctp++; else cfp++; pts.push({ r: gold ? ctp / gold : 0, p: ctp / (ctp + cfp) }); }
  let ap = 0, prevR = 0;
  for (let i = 0; i < pts.length; i++) { const pMax = Math.max(...pts.slice(i).map((q) => q.p)); ap += (pts[i]!.r - prevR) * pMax; prevR = pts[i]!.r; }
  const precision = tp + fp ? tp / (tp + fp) : 0, recall = gold ? tp / gold : 0;
  return { label, gold, tp, fp, fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, ap: gold ? ap : 0 };
}

export function fppf(frames: Scored[], threshold: number | ThresholdFn, iouMin: number, labels?: readonly string[]): number {
  if (!frames.length) return 0;
  let fp = 0;
  const labs = labels ?? [...new Set(frames.flatMap((f) => f.pred.map((p) => p.label)))];
  for (const f of frames) for (const l of labs) { const m = matchFrame(f.gold, f.pred.filter((p) => p.confidence >= thr(threshold, l)), l, iouMin); fp += m.hits.filter((h) => !h).length; }
  return fp / frames.length;
}

export function countAccuracy(frames: Scored[], threshold: number | ThresholdFn, label = 'horse'): { mae: number; exact: number } {
  if (!frames.length) return { mae: 0, exact: 0 };
  let err = 0, exact = 0;
  for (const f of frames) { const g = f.gold.filter((b) => b.label === label).length; const p = f.pred.filter((b) => b.label === label && b.confidence >= thr(threshold, label)).length; err += Math.abs(g - p); if (g === p) exact++; }
  return { mae: err / frames.length, exact: exact / frames.length };
}

/** 95 % bootstrap interval over frames for a statistic of the frame list. */
export function bootstrap(frames: Scored[], stat: (fs: Scored[]) => number, n = 1000, seed = 1): { lo: number; hi: number } {
  let s = seed >>> 0; const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const vals: number[] = [];
  for (let i = 0; i < n; i++) { const sample = Array.from({ length: frames.length }, () => frames[Math.floor(rand() * frames.length)]!); vals.push(stat(sample)); }
  vals.sort((a, b) => a - b);
  return { lo: vals[Math.floor(0.025 * n)] ?? 0, hi: vals[Math.min(n - 1, Math.floor(0.975 * n))] ?? 0 };
}

/** Operating points: horse recall at FPPF(all) <= budget, horse recall at precision >= 0.9, with the thresholds found. */
export function operatingPoints(frames: Scored[], iouMin: number): { r_at_fppf01: { recall: number; threshold: number | null }; r_at_p90: { recall: number; threshold: number | null } } {
  const ths = Array.from({ length: 19 }, (_, i) => +(0.05 + i * 0.05).toFixed(2));
  let best1: { recall: number; threshold: number | null } = { recall: 0, threshold: null };
  let best2: { recall: number; threshold: number | null } = { recall: 0, threshold: null };
  for (const t of ths) {
    const m = classMetrics(frames, 'horse', t, iouMin);
    if (fppf(frames, t, iouMin) <= 0.1 && m.recall >= best1.recall) best1 = { recall: m.recall, threshold: t };
    if (m.precision >= 0.9 && m.recall >= best2.recall) best2 = { recall: m.recall, threshold: t };
  }
  return { r_at_fppf01: best1, r_at_p90: best2 };
}

export function slices(frames: Scored[]): Record<string, Scored[]> {
  const out: Record<string, Scored[]> = { all: frames };
  for (const f of frames) { (out[`period:${f.frame.period}`] ??= []).push(f); (out[`camera:${f.frame.camera}`] ??= []).push(f); }
  return out;
}

export function scoreSet(frames: Scored[], opts: { threshold: number | ThresholdFn; iou: number; labels?: string[]; thresholdsByLabel?: Record<string, number> }): Record<string, unknown> {
  const labels = opts.labels ?? [...new Set(frames.flatMap((f) => f.gold.map((b) => b.label)))].sort();
  const bySlice: Record<string, unknown> = {};
  for (const [name, fs] of Object.entries(slices(frames))) {
    const horse = classMetrics(fs, 'horse', opts.threshold, opts.iou);
    bySlice[name] = {
      frames: fs.length,
      classes: Object.fromEntries(labels.map((l) => [l, classMetrics(fs, l, opts.threshold, opts.iou)])),
      fppf_interest: fppf(fs, opts.threshold, opts.iou, INTEREST), fppf_all: fppf(fs, opts.threshold, opts.iou),
      horse_count: countAccuracy(fs, opts.threshold),
      horse_recall_ci: name === 'all' || fs.length >= 20 ? bootstrap(fs, (s) => classMetrics(s, 'horse', opts.threshold, opts.iou).recall) : null,
      horse_ap: horse.ap,
    };
  }
  return { threshold: typeof opts.threshold === 'function' ? 'per-label' : opts.threshold, thresholds_by_label: opts.thresholdsByLabel ?? null, iou: opts.iou, labels, operating_points: operatingPoints(frames, opts.iou), slices: bySlice };
}
