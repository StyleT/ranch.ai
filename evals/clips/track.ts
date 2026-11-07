// The persistence gate over a video predictions file (plan: tier 1 with a tracker): run ByteTrack per clip over the
// detector's per-frame boxes in pts order and keep only the boxes of tracks that were matched on `--min-streak`
// consecutive processed frames, on every frame they were observed. Writes predictions.<pkg>@s<stride>+bt<N>.jsonl
// beside the input (same row shape, every box with track_id and track_len) and a `gate` summary into the frames
// set's manifest.json. bench.ts scores the gated file like any other.
//   node --experimental-strip-types evals/clips/track.ts --predictions evals/baseline/2026-11-06-1fps/predictions.yolo26s-e2e-384x640@s1.jsonl \
//     --min-streak 10 [--min-streak 15] [--clips evals/baseline/2026-11-06/clips.jsonl]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BYTETRACK_DEFAULTS, gateClip } from '../../apps/detector/src/bytetrack.ts';
import type { Pred } from '../../apps/detector/src/score.ts';

const { values: a } = parseArgs({
  options: {
    predictions: { type: 'string' },
    'min-streak': { type: 'string', multiple: true },
    clips: { type: 'string' },
  },
});
if (!a.predictions || !a['min-streak']?.length) {
  console.error('usage: track.ts --predictions <file> --min-streak N [--min-streak M] [--clips clips.jsonl]');
  process.exit(2);
}
interface Row {
  clip_id: number;
  camera: string;
  period?: string;
  pts_s: number;
  frame_no: number;
  stride?: number;
  model: string;
  detections: Pred[];
  [k: string]: unknown;
}
const input = resolve(a.predictions);
const rows = readFileSync(input, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row);
const byClip = Map.groupBy(rows, (r) => r.clip_id);
const clipFps = new Map<number, number>();
if (a.clips && existsSync(a.clips)) {
  for (const l of readFileSync(a.clips, 'utf8').split('\n').filter(Boolean)) {
    const c = JSON.parse(l) as { clip_id: number; fps: number };
    clipFps.set(c.clip_id, c.fps);
  }
}
const dir = dirname(input);
const manifestPath = join(dir, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { models?: Record<string, unknown> })
  : { models: {} };
manifest.models ??= {};

for (const n of a['min-streak'].map(Number)) {
  const out: string[] = [];
  let tracks = 0,
    qualified = 0;
  const kept: Record<string, number> = {},
    dropped: Record<string, number> = {};
  const delays: number[] = [];
  for (const [clipId, frames] of [...byClip].sort((u, v) => u[0] - v[0])) {
    frames.sort((u, v) => u.frame_no - v.frame_no);
    const stride = frames[0]?.stride ?? 1;
    const g = gateClip(frames, n);
    tracks += g.tracks.filter((t) => t.activated).length; // ultralytics' count: singletons never get an id
    qualified += g.qualified.size;
    for (const t of g.tracks) {
      (g.qualified.has(t.track_id) ? kept : dropped)[t.label] =
        ((g.qualified.has(t.track_id) ? kept : dropped)[t.label] ?? 0) + t.frames;
    }
    const fps = clipFps.get(clipId);
    if (fps) {
      delays.push((n * stride) / fps);
    }
    for (const f of g.frames) {
      out.push(JSON.stringify({ ...f, model: `${f.model}+bt${n}`, gate: { min_streak: n, ...BYTETRACK_DEFAULTS } }));
    }
  }
  const outName = basename(input).replace(/\.jsonl$/, `+bt${n}.jsonl`);
  writeFileSync(join(dir, outName), out.join('\n') + '\n');
  const summary = {
    source: basename(input),
    min_streak: n,
    tracker: BYTETRACK_DEFAULTS,
    clips: byClip.size,
    tracks,
    qualified,
    dropped_tracks: tracks - qualified,
    boxes_kept: kept,
    boxes_dropped: dropped,
    log_delay_s: delays.length
      ? {
          min: +Math.min(...delays).toFixed(2),
          max: +Math.max(...delays).toFixed(2),
          mean: +(delays.reduce((s, v) => s + v, 0) / delays.length).toFixed(2),
        }
      : null,
    file: outName,
    sha256: createHash('sha256')
      .update(readFileSync(join(dir, outName)))
      .digest('hex'),
    ts: new Date().toISOString(),
  };
  manifest.models[outName.replace(/^predictions\./, '').replace(/\.jsonl$/, '')] = summary;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
