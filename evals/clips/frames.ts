// Decode a frozen clip set to a frames set at a fixed rate: the golden frames the labelers see (docs/EVALUATION.md §2).
// Every clip of <set>/clips.jsonl (its mp4 pulled to <set>/frames/clips/<camera>/) is decoded with ffmpeg at --fps,
// native resolution, into <out>/frames/<camera>/<clip stem>-NNNN.jpg, and <out>/frames.jsonl gets one row per frame
// with burst_id = clip_id and seq = frame_idx, so the FiftyOne grouped import, bench.ts --bursts and the labelers'
// burst reader work on it unchanged. Laptop only; the mp4s and the JPEGs are git-ignored, the JSONL is committed.
//   node --experimental-strip-types evals/clips/frames.ts --set evals/baseline/2026-11-06 --id frames-ranch-clips-v1 \
//     [--fps 1] [--out evals/baseline/2026-11-06-1fps] [--limit-clips N] [--jobs 4]
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    set: { type: 'string' },
    id: { type: 'string' },
    fps: { type: 'string', default: '1' },
    out: { type: 'string' },
    'limit-clips': { type: 'string' },
    jobs: { type: 'string', default: '4' },
  },
});
if (!a.set || !a.id || !/^frames-[a-z0-9-]+-v\d+$/.test(a.id)) {
  console.error('usage: frames.ts --set evals/baseline/<date> --id frames-<name>-vN [--fps 1] [--out dir]');
  process.exit(2);
}
const fps = Number(a.fps);
const setDir = resolve(a.set);
const outDir = resolve(a.out ?? `${a.set.replace(/\/$/, '')}-${fps}fps`);
const repoRoot = resolve(import.meta.dirname, '../..');
const rel = (p: string) => (p.startsWith(repoRoot + '/') ? p.slice(repoRoot.length + 1) : p);

interface ClipRow {
  clip_id: number;
  camera: string;
  start_ts: string;
  period: string;
  duration_s: number;
  fps: number;
  width: number;
  height: number;
  path: string;
}
interface FrameRow {
  frame_id: number;
  clip_id: number;
  frame_idx: number;
  t_s: number;
  path: string;
  camera: string;
  ts: string;
  period: string;
  reason: string;
  width: number;
  height: number;
  burst_id: number;
  seq: number;
}

const clips = readFileSync(join(setDir, 'clips.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as ClipRow)
  .slice(0, a['limit-clips'] ? Number(a['limit-clips']) : undefined);

const sha256 = (p: string) =>
  new Promise<string>((res, rej) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });

/** ffmpeg at a constant --fps, native size, quality 2 JPEGs; frame NNNN starts at 1, so frame_idx = NNNN - 1. */
function decode(c: ClipRow): Promise<string[]> {
  const mp4 = join(setDir, 'frames', 'clips', c.camera, basename(c.path));
  if (!existsSync(mp4)) {
    throw new Error(`missing ${mp4} (run: make frames-pull DATE=${basename(setDir)})`);
  }
  const dir = join(outDir, 'frames', c.camera);
  mkdirSync(dir, { recursive: true });
  const stem = basename(c.path, '.mp4');
  for (const f of readdirSync(dir)) {
    if (f.startsWith(stem + '-')) {
      rmSync(join(dir, f));
    }
  }
  return new Promise((res, rej) => {
    const p = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        mp4,
        '-vf',
        `fps=${fps}`,
        '-q:v',
        '2',
        join(dir, `${stem}-%04d.jpg`),
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) {
        rej(new Error(`ffmpeg ${c.clip_id}: ${err.trim()}`));
        return;
      }
      res(
        readdirSync(dir)
          .filter((f) => f.startsWith(stem + '-'))
          .sort(),
      );
    });
  });
}

mkdirSync(outDir, { recursive: true });
const jobs = Math.max(1, Number(a.jobs));
const rows: FrameRow[] = [];
let next = 0;
let done = 0;
const t0 = Date.now();
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (next < clips.length) {
      const c = clips[next++]!;
      const files = await decode(c);
      const start = Date.parse(c.start_ts);
      for (const f of files) {
        const idx = Number(f.slice(-8, -4)) - 1;
        const t = idx / fps;
        rows.push({
          frame_id: c.clip_id * 1000 + idx,
          clip_id: c.clip_id,
          frame_idx: idx,
          t_s: t,
          path: rel(join(outDir, 'frames', c.camera, f)),
          camera: c.camera,
          ts: new Date(start + t * 1000).toISOString(),
          period: c.period,
          reason: `clip-${fps}fps`,
          width: c.width,
          height: c.height,
          burst_id: c.clip_id,
          seq: idx,
        });
      }
      done++;
      if (done % 20 === 0 || done === clips.length) {
        console.error(
          `${done}/${clips.length} clips, ${rows.length} frames, ${Math.round((Date.now() - t0) / 1000)} s`,
        );
      }
    }
  }),
);
rows.sort((u, v) => u.clip_id - v.clip_id || u.frame_idx - v.frame_idx);
writeFileSync(join(outDir, 'frames.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
copyFileSync(join(setDir, 'clips.jsonl'), join(outDir, 'clips.jsonl'));
const parent = (JSON.parse(readFileSync(join(setDir, 'dataset.json'), 'utf8')) as { id: string }).id;
const ffmpegVersion = execFileSync('ffmpeg', ['-version']).toString().split('\n')[0] ?? '';
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim();
  } catch {
    return null;
  }
})();
const framesSha = await sha256(join(outDir, 'frames.jsonl'));
const clipsSha = await sha256(join(outDir, 'clips.jsonl'));
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      date: basename(outDir),
      host: hostname(),
      n: rows.length,
      clips: clips.length,
      fps,
      source_set: parent,
      models: {},
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  join(outDir, 'dataset.json'),
  JSON.stringify(
    {
      id: a.id,
      kind: 'frames',
      version: Number(a.id.match(/v(\d+)$/)![1]),
      created: new Date().toISOString(),
      parent,
      n: rows.length,
      clips: clips.length,
      sha256: { 'frames.jsonl': framesSha, 'clips.jsonl': clipsSha },
      source: {
        set: rel(setDir),
        fps,
        filter: `fps=${fps}`,
        resolution: 'native',
        ffmpeg: ffmpegVersion,
        frame_id: 'clip_id * 1000 + frame_idx',
      },
      host: hostname(),
      commit,
      preds: {},
    },
    null,
    2,
  ) + '\n',
);
// ffmpeg's fps filter emits one frame per whole output interval, rounding the clip's length: round(duration x fps)
// frames per clip (checked on 260 clips of 15 to 25 fps, every one).
const expected = clips.reduce((s, c) => s + Math.round(c.duration_s * fps), 0);
if (expected !== rows.length) {
  console.error(`frame count ${rows.length} differs from round(duration x fps) summed over clips ${expected}`);
}
console.log(
  JSON.stringify({
    dataset: a.id,
    clips: clips.length,
    frames: rows.length,
    expected_round: expected,
    out: rel(outDir),
    sha256: framesSha.slice(0, 12),
  }),
);
