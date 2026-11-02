// Motion clips (docs/CLIPS.md, 1 Nov): the burst's successor. The recorder keeps a ring of stream-copied one-GOP
// MPEG-TS segments per camera; ingest decides, from the buffer keyframes' local-motion score it already computes, when
// a clip opens and closes, then cuts the mp4 from the ring segments and samples JPEG frames from it for the detector.
// This file holds the pure decisions (tested without a camera); main.ts owns the clock, ffmpeg, the store and the bus.
//
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Sharp } from 'sharp';
const run = promisify(execFile);

// Constants, with the reason each has its value. They become env knobs only when a measurement says a value is wrong.
export const CLIP = {
  openScore: 0.08, // today's RANCH_MOTION_THRESHOLD: a block-max diff this large is something moving, not lighting
  continueScore: 0.05, // today's BURST_CHANGE: motion still going between consecutive keyframes
  prerollS: 5, // keyframes come every 2 s (measured 1 Nov, all cameras), so 5 s reaches the GOP before the trigger
  quietS: 8, // a horse pausing mid-walk rarely stands still longer; 4 keyframes of quiet end the clip
  maxS: 60, // the eval's clip length cap; longer motion becomes consecutive clips after the cooldown
  cooldownS: 10, // today's BURST_COOLDOWN_S
  staleS: 30, // today's RANCH_STALE_S: no buffer keyframe this long means the camera is gone, close what we have
  sampleFps: 2, // detector stride: 7 cameras x 2 fps = 14 fps of the ANE's ~44, and 0.5 s between boxes for the tracker
  sampleWidth: 1280, // the runner scale-fills to 640 anyway; a 720p JPEG is ~120 KB instead of ~500 KB
  minFreeGb: 40, // the recorder pauses at 20; clips stop first so the live buffer never starves
  retentionD: 7, // mp4s expire with the frames; the rows stay (docs/PLAN.md: events live forever)
  // Persistence (2 Nov): one hot keyframe is not motion. An insect streak near an IR lens, a light switching or an
  // exposure step score >= openScore on one keyframe and >= continueScore on the next (appear, then vanish), then
  // nothing; a walking animal keeps scoring. Of the first night's 18 clips none showed motion (docs/CLIPS.md).
  litScore: 0.02, // a block whose mean diff reaches this is "lit" (quiet cameras stay under it, docs/MODEL-YOLO26.md)
  globalFrac: 0.5, // this share of the 144 blocks lit at once is a lighting change, not an object: never a clip
  confirmK: 3, // keyframes after the trigger that may confirm it (6 s; the ring holds 3 min, pre-roll is unaffected)
  confirmHot: 2, // of those, how many must still score >= continueScore; a transient gives at most one
} as const;
export type ClipRules = { [K in keyof typeof CLIP]: number };

export const THUMB_W = 128;
export const THUMB_H = 72;
export const BLOCK = 8; // 16x9 blocks of 8x8 for the local motion metric
/** The greyscale thumbnail every motion metric runs on, from a sharp instance (the sampler shares its decode). */
export const thumbnail = (img: Sharp): Promise<Buffer> =>
  img.clone().resize(THUMB_W, THUMB_H, { fit: 'fill' }).greyscale().raw().toBuffer();

export function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i]! - b[i]!);
  }
  return sum / a.length / 255;
}
/** Mean absolute difference (0..1) of every 8x8 block, row-major: 144 numbers for a 128x72 thumbnail. */
export function blockDiffs(a: Buffer, b: Buffer): number[] {
  const out: number[] = [];
  for (let by = 0; by < THUMB_H / BLOCK; by++) {
    for (let bx = 0; bx < THUMB_W / BLOCK; bx++) {
      let s = 0;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const i = (by * BLOCK + y) * THUMB_W + bx * BLOCK + x;
          s += Math.abs(a[i]! - b[i]!);
        }
      }
      out.push(s / (BLOCK * BLOCK) / 255);
    }
  }
  return out;
}
/**
 * Local motion: the largest block mean difference. A whole-frame mean (meanAbsDiff) sees lighting changes but not a
 * distant animal; the block maximum sees the animal. Measured 22 Oct on consecutive frames (docs/MODEL-YOLO26.md):
 * quiet cameras stay <= 0.021 day and night, real motion scores 0.06-0.59.
 */
export const blockMaxDiff = (a: Buffer, b: Buffer): number => Math.max(...blockDiffs(a, b));
/** The share of blocks that changed at all: an object lights a few, a lighting change lights most of them. */
export const litFraction = (a: Buffer, b: Buffer, litScore: number = CLIP.litScore): number => {
  const d = blockDiffs(a, b);
  return d.filter((x) => x >= litScore).length / d.length;
};

/** One keyframe's measurements against the previous keyframe: local motion and how much of the frame changed. */
export interface Keyframe {
  ts: number;
  score: number; // blockMaxDiff
  lit: number; // litFraction
}
/** `[seconds since the trigger, score, lit]` per keyframe from the trigger on: what the DB keeps of every candidate. */
export type ScoreSeries = [number, number, number][];
export interface ClipState {
  triggerTs: number | null;
  confirmed: boolean; // a candidate becomes a clip only once motion persisted
  series: ScoreSeries;
  motionLastTs: number | null;
  lastCloseTs: number;
}
export type DropReason = 'single' | 'global' | 'stale';
export type ClipEvent =
  | { type: 'candidate'; triggerTs: number }
  | { type: 'open'; triggerTs: number }
  | { type: 'drop'; reason: DropReason; triggerTs: number; endTs: number; series: ScoreSeries }
  | { type: 'close'; stopped: 'quiet' | 'max' | 'stale'; triggerTs: number; endTs: number; series: ScoreSeries }
  | { type: 'global'; ts: number; score: number; lit: number }; // a lighting change scored like motion while idle

export const idleState = (): ClipState => ({
  triggerTs: null,
  confirmed: false,
  series: [],
  motionLastTs: null,
  lastCloseTs: 0,
});

/**
 * Feed one buffer keyframe. Mutates `st`. Idle: a hot keyframe becomes a candidate (or, with `confirmHot` 0, a clip at
 * once). Candidate: the next `confirmK` keyframes decide; `confirmHot` more hot ones open the clip, a global change or
 * an exhausted window drops it. Open: as before (continue, quiet, max), a global keyframe counting as neither.
 * `rules` exists for the replay tool (evals/clips/replay.ts) to sweep thresholds; production passes nothing.
 */
export function step(st: ClipState, f: Keyframe, rules: ClipRules = CLIP): ClipEvent | null {
  const global = f.lit >= rules.globalFrac;
  const hot = f.score >= rules.continueScore && !global;
  if (st.triggerTs === null) {
    if (f.score < rules.openScore || f.ts - st.lastCloseTs < rules.cooldownS * 1000) {
      return null;
    }
    if (global) {
      return { type: 'global', ts: f.ts, score: f.score, lit: f.lit };
    }
    st.triggerTs = f.ts;
    st.motionLastTs = f.ts;
    st.series = [[0, f.score, f.lit]];
    st.confirmed = rules.confirmHot <= 0;
    return { type: st.confirmed ? 'open' : 'candidate', triggerTs: f.ts };
  }
  st.series.push([(f.ts - st.triggerTs) / 1000, f.score, f.lit]);
  if (hot) {
    st.motionLastTs = f.ts;
  }
  if (!st.confirmed) {
    if (global) {
      return drop(st, 'global', f.ts);
    }
    const hots = st.series.slice(1).filter(([, s, l]) => s >= rules.continueScore && l < rules.globalFrac).length;
    if (hots >= rules.confirmHot) {
      st.confirmed = true;
      return { type: 'open', triggerTs: st.triggerTs };
    }
    return st.series.length - 1 >= rules.confirmK ? drop(st, 'single', f.ts) : null;
  }
  if (f.ts - st.triggerTs >= rules.maxS * 1000) {
    return close(st, 'max', f.ts);
  }
  if (!hot && f.ts - (st.motionLastTs ?? st.triggerTs) >= rules.quietS * 1000) {
    return close(st, 'quiet', f.ts);
  }
  return null;
}

/** No keyframe for staleS: a candidate is dropped, an open clip closes where the last keyframe was. */
export function staleCheck(st: ClipState, nowTs: number, lastKeyframeTs: number): ClipEvent | null {
  if (st.triggerTs === null || nowTs - lastKeyframeTs < CLIP.staleS * 1000) {
    return null;
  }
  return st.confirmed ? close(st, 'stale', lastKeyframeTs) : drop(st, 'stale', lastKeyframeTs);
}

function finish(st: ClipState): { triggerTs: number; series: ScoreSeries } {
  const out = { triggerTs: st.triggerTs!, series: st.series };
  st.triggerTs = null;
  st.motionLastTs = null;
  st.series = [];
  st.confirmed = false;
  return out;
}
function close(st: ClipState, stopped: 'quiet' | 'max' | 'stale', endTs: number): ClipEvent {
  st.lastCloseTs = endTs; // the cooldown runs from a real clip, never from a dropped candidate
  return { type: 'close', stopped, endTs, ...finish(st) };
}
function drop(st: ClipState, reason: DropReason, endTs: number): ClipEvent {
  return { type: 'drop', reason, endTs, ...finish(st) };
}

/** Ring segment name `2026-11-02T03-00-06Z.ts` -> epoch ms of its first keyframe. */
export function segmentMs(name: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.ts$/.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : NaN;
}

/**
 * The ring segments that cover [triggerTs - prerollS, endTs], in order: from the segment that contains the pre-roll
 * start (the last one starting at or before it) through the one that contains the end. The newest segment is never
 * taken: the muxer is still writing it (the reader rule in docs/CLIPS.md).
 */
export function selectSegments(names: string[], triggerTs: number, endTs: number): string[] {
  const sorted = names.filter((n) => !Number.isNaN(segmentMs(n))).sort();
  const closed = sorted.slice(0, -1);
  const from = triggerTs - CLIP.prerollS * 1000;
  let first = 0;
  for (let i = 0; i < closed.length; i++) {
    if (segmentMs(closed[i]!) <= from) {
      first = i;
    }
  }
  const out: string[] = [];
  for (let i = first; i < closed.length; i++) {
    const t = segmentMs(closed[i]!);
    if (t > endTs) {
      break;
    }
    out.push(closed[i]!);
  }
  return out;
}

// ---- mechanics (ffmpeg concat and frame extraction): short jobs with timeouts, owned by ingest, never long-running

export interface CutResult {
  path: string;
  startMs: number;
  bytes: number;
  duration_s: number;
  fps: number;
  width: number;
  height: number;
  segments: number;
}

/** Concatenate the ring segments covering the clip into <clipsDir>/<camera>/<start>.mp4 (written as .tmp, then renamed). */
export async function cutClip(o: {
  ringDir: string;
  clipsDir: string;
  camera: string;
  triggerTs: number;
  endTs: number;
}): Promise<CutResult | null> {
  const ring = join(o.ringDir, o.camera);
  let names: string[];
  try {
    names = readdirSync(ring);
  } catch {
    return null;
  }
  const segs = selectSegments(names, o.triggerTs, o.endTs);
  if (!segs.length) {
    return null;
  }
  const startMs = segmentMs(segs[0]!);
  const dir = join(o.clipsDir, o.camera);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${segs[0]!.replace(/\.ts$/, '')}.mp4`);
  const tmp = `${out}.tmp`;
  const list = join(tmpdir(), `clip-${o.camera}-${startMs}.txt`);
  writeFileSync(list, segs.map((s) => `file '${join(ring, s)}'`).join('\n') + '\n');
  try {
    await run(
      'ffmpeg',
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-fflags',
        '+genpts',
        '-i',
        list,
        '-map',
        '0:v',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        '-y',
        tmp,
      ],
      { timeout: 30_000 },
    );
    renameSync(tmp, out);
  } finally {
    try {
      unlinkSync(list);
    } catch {
      /* gone */
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* renamed */
    }
  }
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,avg_frame_rate:format=duration',
      '-of',
      'json',
      out,
    ],
    { timeout: 10_000 },
  );
  const p = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number; avg_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const s = p.streams?.[0] ?? {};
  const [num, den] = (s.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    path: out,
    startMs,
    bytes: statSync(out).size,
    duration_s: Number(p.format?.duration ?? 0),
    fps: den ? num! / den : 0,
    width: s.width ?? 0,
    height: s.height ?? 0,
    segments: segs.length,
  };
}

/** Extract JPEGs at CLIP.sampleFps, CLIP.sampleWidth wide, named <prefix>-NNNN.jpg; returns the paths in frame order. */
export async function sampleFrames(o: { clipPath: string; dir: string; prefix: string }): Promise<string[]> {
  mkdirSync(o.dir, { recursive: true });
  await run(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-i',
      o.clipPath,
      '-vf',
      `fps=${CLIP.sampleFps},scale=${CLIP.sampleWidth}:-2`,
      '-q:v',
      '5',
      '-f',
      'image2',
      '-start_number',
      '0',
      '-y',
      join(o.dir, `${o.prefix}-%04d.jpg`),
    ],
    { timeout: 120_000 },
  );
  return readdirSync(o.dir)
    .filter((f) => f.startsWith(`${o.prefix}-`) && f.endsWith('.jpg'))
    .sort()
    .map((f) => join(o.dir, f));
}
