// Tier-1 predictions on video: run the detector's --video path over every clip of a frozen clip set, one package at a
// time, at one or more strides, and write predictions.<package>@s<stride>.jsonl beside the golden frames set
// (plan C1). Rows carry clip_id and pts_s, which bench.ts joins to the nearest golden frame, plus decode_ms and ms
// for the throughput table. Runs on the mini (the packages and the clips are there) or on the laptop with --bin.
//   node --experimental-strip-types evals/clips/predict.ts --set evals/baseline/2026-11-06 --out evals/baseline/2026-11-06-1fps \
//     --models yolo26s,yolo26s-e2e-640x640,yolo26s-e2e-384x640 [--stride 1,2,4,8] [--models-dir /usr/local/ranch/models] \
//     [--bin /usr/local/ranch/bin/detector] [--compute ane] [--threshold 0.05] [--limit-clips N]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Runner } from '../../apps/detector/src/runner.ts';

const { values: a } = parseArgs({
  options: {
    set: { type: 'string' },
    out: { type: 'string' },
    models: { type: 'string' },
    'models-dir': { type: 'string', default: '/usr/local/ranch/models' },
    bin: { type: 'string', default: '/usr/local/ranch/bin/detector' },
    compute: { type: 'string', default: 'ane' },
    threshold: { type: 'string', default: '0.05' },
    stride: { type: 'string', default: '1' },
    'limit-clips': { type: 'string' },
  },
});
if (!a.set || !a.out || !a.models) {
  console.error('usage: predict.ts --set <clips set> --out <frames set dir> --models a,b [--stride 1,2,4,8]');
  process.exit(2);
}
interface ClipRow {
  clip_id: number;
  camera: string;
  period: string;
  path: string;
  duration_s: number;
  fps: number;
}
const setDir = resolve(a.set);
const outDir = resolve(a.out);
mkdirSync(outDir, { recursive: true });
const clips = readFileSync(join(setDir, 'clips.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as ClipRow)
  .slice(0, a['limit-clips'] ? Number(a['limit-clips']) : undefined);
const localMp4 = (c: ClipRow) =>
  existsSync(c.path) ? c.path : join(setDir, 'frames', 'clips', c.camera, basename(c.path));
const strides = a.stride.split(',').map(Number);
const manifestPath = join(outDir, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { models?: Record<string, unknown> })
  : { models: {} };
manifest.models ??= {};

for (const model of a.models.split(',')) {
  const pkg = join(a['models-dir'], model.endsWith('.mlpackage') ? model : `${model}.mlpackage`);
  const name = basename(pkg, '.mlpackage');
  for (const stride of strides) {
    const runner = new Runner({
      bin: a.bin,
      model: pkg,
      compute: a.compute as 'ane' | 'gpu' | 'cpu' | 'all',
      threshold: Number(a.threshold),
    });
    const info = await runner.info;
    const rows: string[] = [];
    const timings: { decode_ms: number; ms: number }[] = [];
    let frames = 0,
      processed = 0,
      wall = 0,
      errors = 0;
    const t0 = Date.now();
    for (const [i, c] of clips.entries()) {
      const mp4 = localMp4(c);
      if (!existsSync(mp4)) {
        errors++;
        console.error(`missing ${mp4}`);
        continue;
      }
      const r = await runner.video(mp4, stride);
      frames += r.done.frames;
      processed += r.done.processed;
      wall += r.done.wall_s;
      if (r.done.error) {
        errors++;
        console.error(`${name} clip ${c.clip_id}: ${r.done.error}`);
      }
      for (const f of r.frames) {
        timings.push({ decode_ms: f.decode_ms, ms: f.ms });
        rows.push(
          JSON.stringify({
            clip_id: c.clip_id,
            camera: c.camera,
            period: c.period,
            pts_s: f.pts_s,
            frame_no: f.frame_no,
            stride,
            decode_ms: f.decode_ms,
            ms: f.ms,
            width: f.width,
            height: f.height,
            model: name,
            detections: f.detections,
          }),
        );
      }
      if ((i + 1) % 20 === 0 || i + 1 === clips.length) {
        console.error(
          `${name}@s${stride}: ${i + 1}/${clips.length} clips, ${processed} frames, ${Math.round((Date.now() - t0) / 1000)} s`,
        );
      }
    }
    runner.close();
    const file = `predictions.${name}@s${stride}.jsonl`;
    writeFileSync(join(outDir, file), rows.join('\n') + '\n');
    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((u, v) => u - v);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    };
    const dec = timings.map((t) => t.decode_ms),
      inf = timings.map((t) => t.ms);
    const summary = {
      package: pkg,
      stride,
      compute: a.compute,
      decoder: info.decoder ?? null,
      scale: info.scale ?? null,
      input: info.input ?? null,
      clips: clips.length,
      frames_decoded: frames,
      frames_processed: processed,
      errors,
      wall_s: +wall.toFixed(1),
      fps_wall: +(frames / Math.max(wall, 1e-9)).toFixed(1),
      decode_ms: { p50: pct(dec, 0.5), p95: pct(dec, 0.95) },
      ms: { p50: pct(inf, 0.5), p95: pct(inf, 0.95) },
      host: hostname(),
      file,
      sha256: createHash('sha256')
        .update(readFileSync(join(outDir, file)))
        .digest('hex'),
      ts: new Date().toISOString(),
    };
    manifest.models[`${name}@s${stride}`] = summary;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify(summary));
  }
}
