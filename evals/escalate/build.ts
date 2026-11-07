// Build the tier-2 escalation set from a golden labels file and a tier-1 predictions file over the same frames
// (plan: the VLM is called on an escalation, never on every frame). One request per:
//   verify     a tier-1 box whose confidence lies in the band [per-label taxonomy threshold, --hi): the golden verdict
//              (tp / fp at IoU 0.5 against a gold box of the same scoring label) rides along;
//   attributes a gold animal box matched by a tier-1 box above the per-label threshold: gold kind and posture ride along;
//   scene      a gold frame with gate.visible or trough.visible: gold gate.state / trough.level ride along.
// Each row carries the crop (the box expanded by --expand, clamped), the same crop from the previous frame of the clip
// when there is one, and the text context the prompt is filled with. Crops are written as JPEGs at native resolution
// under <out>/crops/. Registered as escalations-<frames id>-<model>-<sha8 of the predictions file>.
//   node --experimental-strip-types evals/escalate/build.ts --frames evals/baseline/<set>/frames.jsonl \
//     --labels evals/golden/labels-clips-ranch-final-v1.jsonl --predictions evals/baseline/<set>/predictions.<model>.jsonl \
//     --out evals/baseline/<set>/escalations-<model> [--hi 0.6] [--expand 0.25] [--no-crops]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { thresholdFor } from '@ranch/taxonomy';
import { matchFrame, type Box, type Pred } from '../../apps/detector/src/score.ts';

const { values: a } = parseArgs({
  options: {
    frames: { type: 'string' },
    labels: { type: 'string' },
    predictions: { type: 'string' },
    out: { type: 'string' },
    hi: { type: 'string', default: '0.6' },
    expand: { type: 'string', default: '0.25' },
    iou: { type: 'string', default: '0.5' },
    family: { type: 'string', default: 'coco' },
    'no-crops': { type: 'boolean', default: false },
  },
});
if (!a.frames || !a.labels || !a.predictions || !a.out) {
  console.error(
    'usage: build.ts --frames f.jsonl --labels l.jsonl --predictions p.jsonl --out dir [--hi 0.6] [--expand 0.25]',
  );
  process.exit(2);
}
const hi = Number(a.hi),
  expand = Number(a.expand),
  iouMin = Number(a.iou);

interface FrameRow {
  frame_id: number;
  clip_id?: number;
  frame_idx?: number;
  t_s?: number;
  path: string;
  camera: string;
  period: string;
  width?: number;
  height?: number;
}
interface LabelRow {
  path?: string;
  clip_id?: number;
  boxes?: Box[];
  gate?: { visible: boolean; state: string };
  trough?: { visible: boolean; level: string };
  label?: { gate?: { visible: boolean; state: string }; trough?: { visible: boolean; level: string } };
}
interface PredRow {
  path?: string;
  clip_id?: number;
  pts_s?: number;
  detections?: Pred[];
}
export interface Escalation {
  id: string;
  type: 'verify' | 'attributes' | 'scene';
  clip_id: number | null;
  frame_id: number;
  frame_idx: number | null;
  path: string;
  prev_path: string | null;
  crop: string;
  prev_crop: string | null;
  box: { x: number; y: number; w: number; h: number };
  context: { camera: string; period: string; label: string; confidence: number };
  gold: { verdict?: 'tp' | 'fp'; label?: string; kind?: string; posture?: string; gate?: string; trough?: string };
}

const readJsonl = <T>(p: string): T[] =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
const repoRoot = resolve(import.meta.dirname, '../..');
const localPath = (p: string, f: FrameRow) => {
  if (existsSync(p)) {
    return p;
  }
  if (existsSync(join(repoRoot, p))) {
    return join(repoRoot, p);
  }
  const alt = join(dirname(resolve(a.frames!)), 'frames', f.camera, basename(p)); // a mini path, pulled under <set>/frames/
  return existsSync(alt) ? alt : null;
};

const frames = readJsonl<FrameRow>(a.frames);
const labels = readJsonl<LabelRow>(a.labels);
const gold = new Map(labels.filter((l) => l.path).map((l) => [l.path!, l]));
const predRows = readJsonl<PredRow>(a.predictions);
// Predictions keyed by path; video rows (clip_id + pts_s) attach to the nearest frame of the clip within 0.5 s.
const preds = new Map<string, Pred[]>();
const byClip = Map.groupBy(
  frames.filter((f) => f.clip_id !== undefined),
  (f) => f.clip_id!,
);
for (const r of predRows) {
  if (r.path && r.detections) {
    preds.set(r.path, [...(preds.get(r.path) ?? []), ...r.detections]);
  } else if (r.clip_id !== undefined && r.pts_s !== undefined && r.detections) {
    const fs = byClip.get(r.clip_id) ?? [];
    let best: FrameRow | null = null;
    for (const f of fs) {
      if (
        f.t_s !== undefined &&
        Math.abs(f.t_s - r.pts_s) <= 0.5 &&
        (!best || Math.abs(f.t_s - r.pts_s) < Math.abs(best.t_s! - r.pts_s))
      ) {
        best = f;
      }
    }
    if (best) {
      preds.set(best.path, [...(preds.get(best.path) ?? []), ...r.detections]);
    }
  }
}
const prevOf = new Map<string, FrameRow>();
for (const fs of byClip.values()) {
  const sorted = [...fs].sort((u, v) => (u.frame_idx ?? 0) - (v.frame_idx ?? 0));
  sorted.forEach((f, i) => {
    if (i > 0) {
      prevOf.set(f.path, sorted[i - 1]!);
    }
  });
}

const expandBox = (b: Box) => {
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  const w = Math.min(1, b.w * (1 + expand)),
    h = Math.min(1, b.h * (1 + expand));
  const x = Math.min(1 - w, Math.max(0, cx - w / 2)),
    y = Math.min(1 - h, Math.max(0, cy - h / 2));
  return { x: +x.toFixed(5), y: +y.toFixed(5), w: +w.toFixed(5), h: +h.toFixed(5) };
};

const out: Escalation[] = [];
const crops: { src: string; box: Escalation['box']; dst: string }[] = [];
const outDir = resolve(a.out);
let n = 0;
const push = (
  f: FrameRow,
  type: Escalation['type'],
  box: Escalation['box'],
  ctx: Escalation['context'],
  g: Escalation['gold'],
) => {
  const id = `${f.clip_id ?? 'f'}-${f.frame_idx ?? f.frame_id}-${type}-${n++}`;
  const prev = prevOf.get(f.path) ?? null;
  const crop = `crops/${id}.jpg`,
    prevCrop = prev ? `crops/${id}.prev.jpg` : null;
  out.push({
    id,
    type,
    clip_id: f.clip_id ?? null,
    frame_id: f.frame_id,
    frame_idx: f.frame_idx ?? null,
    path: f.path,
    prev_path: prev?.path ?? null,
    crop,
    prev_crop: prevCrop,
    box,
    context: ctx,
    gold: g,
  });
  crops.push({ src: f.path, box, dst: crop });
  if (prev && prevCrop) {
    crops.push({ src: prev.path, box, dst: prevCrop });
  }
};

for (const f of frames) {
  const g = gold.get(f.path);
  if (!g) {
    continue;
  }
  const gboxes = g.boxes ?? [];
  const ps = preds.get(f.path) ?? [];
  const labelsSeen = new Set([...ps.map((p) => p.label), ...gboxes.map((b) => b.label)]);
  for (const label of labelsSeen) {
    const lo = thresholdFor(a.family!, label);
    const inBand = ps.filter((p) => p.label === label && p.confidence >= lo && p.confidence < hi);
    const above = ps.filter((p) => p.label === label && p.confidence >= lo);
    const m = matchFrame(gboxes, above, label, iouMin);
    m.preds.forEach((p, i) => {
      if (inBand.includes(p)) {
        push(
          f,
          'verify',
          expandBox(p),
          { camera: f.camera, period: f.period, label, confidence: p.confidence },
          { verdict: m.hits[i] ? 'tp' : 'fp', label },
        );
      }
    });
    if (label === 'horse' || label === 'dog' || label === 'cat' || label === 'bird') {
      m.pairs.forEach((gb, i) => {
        if (gb && (gb.kind !== undefined || gb.posture !== undefined)) {
          const p = m.preds[i]!;
          push(
            f,
            'attributes',
            expandBox(gb),
            { camera: f.camera, period: f.period, label, confidence: p.confidence },
            {
              label,
              ...(gb.kind !== undefined ? { kind: gb.kind } : {}),
              ...(gb.posture !== undefined ? { posture: gb.posture } : {}),
            },
          );
        }
      });
    }
  }
  // A scene request needs a gold value a model can be right or wrong about: visible and not `unknown`.
  const gate = g.gate ?? g.label?.gate,
    trough = g.trough ?? g.label?.trough;
  const gateGold = gate?.visible && gate.state !== 'unknown' ? gate.state : undefined;
  const troughGold = trough?.visible && trough.level !== 'unknown' ? trough.level : undefined;
  if (gateGold !== undefined || troughGold !== undefined) {
    push(
      f,
      'scene',
      { x: 0, y: 0, w: 1, h: 1 },
      { camera: f.camera, period: f.period, label: 'scene', confidence: 1 },
      {
        ...(gateGold !== undefined ? { gate: gateGold } : {}),
        ...(troughGold !== undefined ? { trough: troughGold } : {}),
      },
    );
  }
}

mkdirSync(join(outDir, 'crops'), { recursive: true });
if (!a['no-crops']) {
  let written = 0,
    missing = 0;
  for (const c of crops) {
    const f = frames.find((x) => x.path === c.src)!;
    const src = localPath(c.src, f);
    if (!src) {
      missing++;
      continue;
    }
    const img = sharp(src);
    const meta = await img.metadata();
    const W = meta.width!,
      H = meta.height!;
    const left = Math.round(c.box.x * W),
      top = Math.round(c.box.y * H);
    const width = Math.max(1, Math.min(W - left, Math.round(c.box.w * W))),
      height = Math.max(1, Math.min(H - top, Math.round(c.box.h * H)));
    await img.extract({ left, top, width, height }).jpeg({ quality: 90 }).toFile(join(outDir, c.dst));
    written++;
  }
  console.error(`crops written ${written}, images missing ${missing}`);
}
writeFileSync(join(outDir, 'escalations.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
const predSha = createHash('sha256').update(readFileSync(a.predictions)).digest('hex');
const framesDataset = (() => {
  const p = join(dirname(resolve(a.frames!)), 'dataset.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { id: string }).id : null;
})();
const model = predRows.find((r) => (r as { model?: string }).model) as { model?: string } | undefined;
const counts = Object.fromEntries(
  (['verify', 'attributes', 'scene'] as const).map((t) => [t, out.filter((r) => r.type === t).length]),
);
writeFileSync(
  join(outDir, 'dataset.json'),
  JSON.stringify(
    {
      id: `escalations-${framesDataset ?? basename(dirname(resolve(a.frames!)))}-${model?.model ?? basename(a.predictions)}-${predSha.slice(0, 8)}`,
      kind: 'escalations',
      created: new Date().toISOString(),
      frames: framesDataset,
      labels: basename(a.labels),
      predictions: { file: basename(a.predictions), sha256: predSha },
      n: out.length,
      counts,
      band: { lo: 'taxonomy per-label threshold', hi, family: a.family },
      expand,
      iou: iouMin,
      host: hostname(),
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ out: a.out, n: out.length, ...counts }));
