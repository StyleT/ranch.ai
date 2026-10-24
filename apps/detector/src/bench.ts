// Detector benchmark per docs/EVALUATION.md §5. Scores stored prediction files (--predictions) or a live model run
// (--model) against a labels dataset, and writes a result JSON with provenance for evals/results/.
//   node apps/detector/src/bench.ts --frames evals/baseline/<date>/frames.jsonl --labels evals/golden/labels-ranch-claude-v1.jsonl \
//     --predictions evals/baseline/<date>/predictions.yolo11n.jsonl [--predictions ...] [--threshold 0.25] [--iou 0.5] --tag zero-shot --out evals/results/<date>-<tag>.json
//   node apps/detector/src/bench.ts --frames ... [--labels ...] --model /usr/local/ranch/models/x.mlpackage --compute ane   (latency run, scored if labels given)
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { Runner } from './runner.ts';
import { scoreSet, type Scored, type Pred, type Box } from './score.ts';
import { associate, isStable, isMoving, MOVING_MIN, ASSOC_IOU } from './tracks.ts';
import { mapDetection, thresholdFor, interestLabels, getTaxonomy, getTaxonomyVersionId } from '@ranch/taxonomy';

const POLICIES = ['none', 'drop-still', 'require-stable', 'drop-still-person'] as const;
const { values: a } = parseArgs({ options: {
  frames: { type: 'string' }, labels: { type: 'string' }, predictions: { type: 'string', multiple: true }, model: { type: 'string', multiple: true },
  compute: { type: 'string', default: 'ane' }, threshold: { type: 'string', default: '0.25' }, iou: { type: 'string', default: '0.5' },
  bin: { type: 'string', default: '/usr/local/ranch/bin/detector' }, out: { type: 'string' }, tag: { type: 'string', default: 'run' }, warmup: { type: 'string', default: '5' },
  'min-label-conf': { type: 'string' },      // drop gold boxes whose labeler confidence is below this (uses the structured label when present)
  taxonomy: { type: 'string' },              // model family (e.g. coco): apply the production mapping and per-label thresholds (docs/TAXONOMY.md)
  bursts: { type: 'boolean', default: false }, // frames.jsonl carries burst_id/seq: associate tracks per burst and apply --policy (docs/EVALUATION.md §4.1)
  policy: { type: 'string', default: 'none' }, // none (the head frame as emitted: the no-bursts baseline) | drop-still | require-stable | drop-still-person
} });
if (!a.frames) { console.error('--frames is required'); process.exit(2); }
if (a.bursts && !(POLICIES as readonly string[]).includes(a.policy!)) { console.error(`--policy must be one of ${POLICIES.join('|')}`); process.exit(2); }
const readJsonl = <T,>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const commit = (() => { try { return execSync('git rev-parse --short HEAD 2>/dev/null').toString().trim() || null; } catch { return null; } })();

interface FrameRow { path: string; camera: string; period: string; frame_id?: number; burst_id?: number | null; seq?: number | null }
const frames = readJsonl<FrameRow>(a.frames);
const labelsFile = a.labels;
const minLabelConf = a['min-label-conf'] ? Number(a['min-label-conf']) : 0;
const threshold = Number(a.threshold), iouMin = Number(a.iou);
const family = a.taxonomy;
if (family && !getTaxonomy().mappings[family]) { console.error(`unknown taxonomy family ${family}`); process.exit(2); }
interface LabelRow { path: string; boxes: Box[]; label?: { animals?: { box: Box; confidence: number }[]; people?: { box: Box; confidence: number }[]; vehicles?: { box: Box; confidence: number }[] } }
const goldBoxes = (r: LabelRow): Box[] => {
  if (!minLabelConf || !r.label) return r.boxes;
  const conf = new Map<string, number>();
  for (const g of [...(r.label.animals ?? []), ...(r.label.people ?? []), ...(r.label.vehicles ?? [])]) conf.set(`${g.box.x},${g.box.y},${g.box.w},${g.box.h}`, g.confidence);
  return r.boxes.filter((b) => (conf.get(`${b.x},${b.y},${b.w},${b.h}`) ?? 1) >= minLabelConf);
};
const gold = labelsFile ? new Map(readJsonl<LabelRow>(labelsFile).map((r) => [r.path, goldBoxes(r)])) : undefined;
// With --taxonomy, predictions are mapped like production does (unmapped classes dropped, labels renamed) but kept
// at every confidence so AP still sweeps; the per-label thresholds then act as the operating point.
const mergePred = (ps: Pred[]): Pred[] => family ? ps.flatMap((p) => { const m = mapDetection(family, p.label, p.confidence, false); return m ? [{ ...p, label: m.label }] : []; }) : ps;
const scoreThreshold: number | ((l: string) => number) = family ? (l: string) => Math.max(threshold, thresholdFor(family, l)) : threshold;
const thresholdsByLabel = family ? Object.fromEntries(interestLabels(family).map((l) => [l, Math.max(threshold, thresholdFor(family, l))])) : undefined;
const scoredFrames = gold ? frames.filter((f) => gold.has(f.path)) : frames; // score only labeled frames
// --bursts: the like-for-like comparison is the head frame (seq 0), the frame a single-frame pipeline would have
// emitted; members are scored too (all-frames slice) for tighter intervals.
const headFrames = a.bursts ? scoredFrames.filter((f) => !f.seq) : scoredFrames;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const thrOf = (l: string) => (typeof scoreThreshold === 'function' ? scoreThreshold(l) : scoreThreshold);

// Burst track policies, in production order: map and threshold first (tracks are built on stored, thresholded
// detections), associate across the burst's members with the detector's own associate(), then the policy removes
// whole tracks from every member's prediction list. Boxes under the operating threshold are never tracked and pass
// through unchanged (they only shape the AP sweep below the operating point).
function burstPolicyPreds(all: FrameRow[], preds: Map<string, Pred[]>, policy: string): Map<string, Pred[]> {
  const out = new Map<string, Pred[]>();
  const groups = new Map<string, FrameRow[]>();
  all.forEach((f, i) => { const k = f.burst_id == null ? `single:${i}` : `burst:${f.burst_id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); });
  for (const members of groups.values()) {
    members.sort((u, v) => (u.seq ?? 0) - (v.seq ?? 0));
    const byId = new Map<number, Pred>(); let nextId = 1;
    const tracked = members.map((f, i) => ({ id: i, dets: (preds.get(f.path) ?? []).filter((p) => p.confidence >= thrOf(p.label)).map((p) => { const id = nextId++; byId.set(id, p); return { id, label: p.label, confidence: p.confidence, x: p.x, y: p.y, w: p.w, h: p.h }; }) }));
    const drop = new Set<Pred>();
    for (const t of associate(tracked)) {
      const still = isStable(t) && !isMoving(t);
      const kill = policy === 'drop-still' ? still : policy === 'drop-still-person' ? still && t.label === 'person' : policy === 'require-stable' ? !isStable(t) : false;
      if (kill) for (const id of t.ids) drop.add(byId.get(id)!);
    }
    for (const f of members) out.set(f.path, (preds.get(f.path) ?? []).filter((p) => !drop.has(p)));
  }
  return out;
}

const results: Record<string, unknown>[] = [];
const runs: { name: string; preds: Map<string, Pred[]>; latency?: Record<string, unknown>; provenance: Record<string, unknown> }[] = [];

for (const p of a.predictions ?? []) {
  const rows = readJsonl<{ path: string; model: string; detections: Pred[] }>(p);
  runs.push({ name: rows[0]?.model ?? basename(p), preds: new Map(rows.map((r) => [r.path, mergePred(r.detections)])), provenance: { predictions_file: p, sha256: sha(p) } });
}
for (const model of a.model ?? []) {
  const runner = new Runner({ bin: a.bin, model, compute: a.compute as 'ane' | 'gpu' | 'cpu' | 'all', threshold: 0.05 });
  const info = await runner.info;
  for (const f of frames.slice(0, Number(a.warmup))) await runner.detect(f.path);
  const ms: number[] = []; let peak = info.rss_mb; const preds = new Map<string, Pred[]>(); const t0 = Date.now();
  for (const f of frames) { const r = await runner.detect(f.path); ms.push(r.ms); peak = Math.max(peak, r.rss_mb); preds.set(f.path, r.detections); }
  runner.close();
  runs.push({ name: basename(model).replace(/\.(mlpackage|mlmodelc)$/, ''), preds, provenance: { model, compute: a.compute },
    latency: { p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), mean_ms: ms.reduce((s, v) => s + v, 0) / ms.length, fps_wall: frames.length / ((Date.now() - t0) / 1000), peak_rss_mb: peak, compiled_ms: info.compiled_ms ?? null } });
}

for (const run of runs) {
  const row: Record<string, unknown> = { model: run.name, tag: a.tag, taxonomy: family ?? null, policy: a.bursts ? a.policy : null, ...run.provenance, latency: run.latency ?? null };
  if (gold) {
    const predOf = a.bursts ? burstPolicyPreds(frames, run.preds, a.policy!) : run.preds;
    const opts = { threshold: scoreThreshold, iou: iouMin, ...(thresholdsByLabel ? { thresholdsByLabel } : {}), ...(family ? { family } : {}) };
    const toScored = (fs: FrameRow[]): Scored[] => fs.map((f) => ({ frame: f, gold: gold.get(f.path) ?? [], pred: predOf.get(f.path) ?? [] }));
    row.score = scoreSet(toScored(headFrames), opts);                       // heads only under --bursts; every labeled frame otherwise
    if (a.bursts) row.score_all_frames = scoreSet(toScored(scoredFrames), opts);
    const all = (row.score as { slices: Record<string, { classes: Record<string, { recall: number; precision: number; ap: number; gold: number; tp: number; fp: number }>; fppf_all: number; horse_count: { exact: number }; horse_recall_ci: { lo: number; hi: number } | null }> }).slices.all!;
    const op = (row.score as { operating_points: { r_at_fppf01: { recall: number; threshold: number | null }; r_at_p90: { recall: number } } }).operating_points;
    const h = all.classes.horse; const pe = all.classes.person;
    console.log(`${run.name.padEnd(22)}${a.bursts ? ` [${a.policy}]` : ''} frames ${headFrames.length}${a.bursts ? ` heads (${scoredFrames.length} all)` : ''}  horse gold ${h?.gold ?? 0}  P ${h?.precision.toFixed(2)} R ${h?.recall.toFixed(2)} [${all.horse_recall_ci?.lo.toFixed(2)}–${all.horse_recall_ci?.hi.toFixed(2)}] AP ${h?.ap.toFixed(2)}` + (pe ? `  person gold ${pe.gold} P ${pe.precision.toFixed(2)} (tp ${pe.tp} fp ${pe.fp}) R ${pe.recall.toFixed(2)}` : '') + `  FPPF(all) ${all.fppf_all.toFixed(2)}  count-exact ${all.horse_count.exact.toFixed(2)}  R@FPPF≤0.1 ${op.r_at_fppf01.recall.toFixed(2)}@${op.r_at_fppf01.threshold}  R@P90 ${op.r_at_p90.recall.toFixed(2)}` + (run.latency ? `  p50 ${(run.latency.p50_ms as number).toFixed(1)} ms` : ''));
  } else if (run.latency) {
    console.log(`${run.name.padEnd(22)} p50 ${(run.latency.p50_ms as number).toFixed(1)} ms  p95 ${(run.latency.p95_ms as number).toFixed(1)} ms  ${(run.latency.fps_wall as number).toFixed(1)} fps  rss ${run.latency.peak_rss_mb} MB`);
  }
  results.push(row);
}

if (a.out) {
  mkdirSync(dirname(a.out), { recursive: true });
  const datasetJson = join(dirname(a.frames), 'dataset.json');
  writeFileSync(a.out, JSON.stringify({
    ts: new Date().toISOString(), tag: a.tag, host: hostname(), commit, command: process.argv.slice(1).join(' '),
    frames: { file: a.frames, sha256: sha(a.frames), dataset: existsSync(datasetJson) ? (JSON.parse(readFileSync(datasetJson, 'utf8')) as { id: string }).id : null, n: frames.length, scored: scoredFrames.length },
    labels: labelsFile ? { file: labelsFile, sha256: sha(labelsFile), dataset: (readJsonl<{ dataset?: string }>(labelsFile)[0]?.dataset) ?? null } : null,
    class_mapping: { donkey: 'horse', delivery_vehicle: 'truck', tractor: 'truck', atv: 'truck', trailer: 'truck', people: 'person' },
    min_label_conf: minLabelConf || null, taxonomy: family ? { family, file: process.env.RANCH_TAXONOMY_FILE ?? null, version_id: getTaxonomyVersionId(), thresholds: thresholdsByLabel, mapping: getTaxonomy().mappings[family] } : null,
    bursts: a.bursts ? { policy: a.policy, n_bursts: new Set(frames.filter((f) => f.burst_id != null).map((f) => f.burst_id)).size, frames_heads: headFrames.length, frames_all: scoredFrames.length, moving_min: MOVING_MIN, assoc_iou: ASSOC_IOU } : null,
    threshold, iou: iouMin, results,
  }, null, 2) + '\n');
  console.log('wrote', a.out);
}
