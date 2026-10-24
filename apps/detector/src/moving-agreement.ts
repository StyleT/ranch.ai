// Does the detector's `moving` flag agree with the labeler's per-object `moved` verdict? (docs/EVALUATION.md §4.1)
// For every labeled object of a bursts dataset (labels carry an id per object and `objects[] {id, moved}` per burst),
// find the detector track whose box on the object's first frame overlaps it (same scoring label, IoU >= iou), and
// compare isMoving(track) with the label. Also reports how far the labeled object actually moved (centre shift, first
// to last labeled box) so the MOVING_MIN threshold can be judged against ground truth.
//   node apps/detector/src/moving-agreement.ts --frames evals/baseline/<date>/frames.jsonl --labels evals/golden/labels-ranch-bursts-<labeler>-vN.jsonl \
//     --predictions evals/baseline/<date>/predictions.<model>.jsonl [--taxonomy coco] [--min-label-conf 0.5] [--iou 0.5]
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { iou, type Pred } from './score.ts';
import { associate, isMoving, isStable, MOVING_MIN } from './tracks.ts';
import { mapDetection, thresholdFor } from '@ranch/taxonomy';

const { values: a } = parseArgs({ options: { frames: { type: 'string' }, labels: { type: 'string' }, predictions: { type: 'string' }, taxonomy: { type: 'string', default: 'coco' }, 'min-label-conf': { type: 'string', default: '0.5' }, iou: { type: 'string', default: '0.5' } } });
if (!a.frames || !a.labels || !a.predictions) { console.error('--frames, --labels and --predictions are required'); process.exit(2); }
const rows = <T,>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
interface FrameRow { path: string; camera: string; burst_id: number | null; seq: number | null }
interface GoldBox { label: string; x: number; y: number; w: number; h: number; id?: string }
interface LabelRow { path: string; burst_id: number; seq: number; boxes: GoldBox[]; objects: { id: string; kind: string; moved: boolean }[]; label: { animals: { id: string; confidence: number }[]; people: { id: string; confidence: number }[]; vehicles: { id: string; confidence: number }[] } }
const frames = rows<FrameRow>(a.frames); const labels = new Map(rows<LabelRow>(a.labels).map((r) => [r.path, r]));
const preds = new Map(rows<{ path: string; detections: Pred[] }>(a.predictions).map((r) => [r.path, r.detections]));
const minConf = Number(a['min-label-conf']), iouMin = Number(a.iou), fam = a.taxonomy!;
const thr = (l: string) => Math.max(0.25, thresholdFor(fam, l));
const mapped = (ps: Pred[]) => ps.flatMap((p) => { const m = mapDetection(fam, p.label, p.confidence, false); return m ? [{ ...p, label: m.label }] : []; }).filter((p) => p.confidence >= thr(p.label));
const centre = (b: { x: number; y: number; w: number; h: number }) => [b.x + b.w / 2, b.y + b.h / 2] as const;

const byBurst = new Map<number, FrameRow[]>();
for (const f of frames) if (f.burst_id != null) (byBurst.get(f.burst_id) ?? byBurst.set(f.burst_id, []).get(f.burst_id)!).push(f);
const tally = { both_moving: 0, gold_moved_track_still: 0, gold_still_track_moving: 0, both_still: 0, unmatched: 0, not_stable: 0 };
const shifts: { moved: boolean; shift: number; label: string }[] = [];
const byLabel = new Map<string, typeof tally>();
for (const members of byBurst.values()) {
  members.sort((u, v) => (u.seq ?? 0) - (v.seq ?? 0));
  const objs = new Map<string, { label: string; boxes: { seq: number; box: GoldBox }[]; moved: boolean }>();
  const headLabel = labels.get(members[0]!.path); if (!headLabel) continue;
  const movedOf = new Map(headLabel.objects.map((o) => [o.id, o.moved]));
  for (const f of members) {
    const r = labels.get(f.path); if (!r) continue;
    const conf = new Map<string, number>([...r.label.animals, ...r.label.people, ...r.label.vehicles].map((g) => [g.id, g.confidence]));
    for (const b of r.boxes) { if (!b.id || (conf.get(b.id) ?? 1) < minConf) continue; const o = objs.get(b.id) ?? objs.set(b.id, { label: b.label, boxes: [], moved: movedOf.get(b.id) ?? false }).get(b.id)!; o.boxes.push({ seq: f.seq ?? 0, box: b }); }
  }
  let id = 1; const owner = new Map<number, { seq: number; box: Pred }>();
  const tracks = associate(members.map((f, i) => ({ id: i, dets: mapped(preds.get(f.path) ?? []).map((p) => { const d = { id: id++, ...p }; owner.set(d.id, { seq: f.seq ?? i, box: p }); return d; }) })));
  for (const o of objs.values()) {
    const first = o.boxes[0]!, last = o.boxes[o.boxes.length - 1]!;
    const [x0, y0] = centre(first.box), [x1, y1] = centre(last.box); shifts.push({ moved: o.moved, shift: Math.hypot(x1 - x0, y1 - y0), label: o.label });
    const t = tracks.find((t) => t.label === o.label && t.ids.some((i) => { const w = owner.get(i)!; return w.seq === first.seq && iou(w.box, first.box) >= iouMin; }));
    const l = byLabel.get(o.label) ?? byLabel.set(o.label, { ...tally, both_moving: 0, gold_moved_track_still: 0, gold_still_track_moving: 0, both_still: 0, unmatched: 0, not_stable: 0 }).get(o.label)!;
    const bump = (k: keyof typeof tally) => { tally[k]++; l[k]++; };
    if (!t) { bump('unmatched'); continue; }
    if (!isStable(t)) { bump('not_stable'); continue; }   // one-frame track: the flag is undefined
    const m = isMoving(t);
    bump(o.moved && m ? 'both_moving' : o.moved && !m ? 'gold_moved_track_still' : !o.moved && m ? 'gold_still_track_moving' : 'both_still');
  }
}
const med = (xs: number[]) => { const s = [...xs].sort((u, v) => u - v); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
console.log(JSON.stringify({ moving_min: MOVING_MIN, objects: shifts.length, ...tally,
  agreement: (tally.both_moving + tally.both_still) / Math.max(1, tally.both_moving + tally.both_still + tally.gold_moved_track_still + tally.gold_still_track_moving),
  gold_shift_median: { moved: +med(shifts.filter((s) => s.moved).map((s) => s.shift)).toFixed(3), still: +med(shifts.filter((s) => !s.moved).map((s) => s.shift)).toFixed(3) },
  gold_moved_below_threshold: shifts.filter((s) => s.moved && s.shift < MOVING_MIN).length, gold_moved_total: shifts.filter((s) => s.moved).length,
  by_label: Object.fromEntries(byLabel) }));
