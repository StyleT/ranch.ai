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
} as const;

export interface ClipState {
  triggerTs: number | null;
  motionLastTs: number | null;
  lastCloseTs: number;
}
export type ClipEvent =
  | { type: 'open'; triggerTs: number }
  | { type: 'close'; stopped: 'quiet' | 'max' | 'stale'; triggerTs: number; endTs: number };

/** Feed one buffer keyframe (its capture time and local-motion score against the previous keyframe). Mutates `st`. */
export function step(st: ClipState, f: { ts: number; score: number }): ClipEvent | null {
  if (st.triggerTs === null) {
    if (f.score < CLIP.openScore || f.ts - st.lastCloseTs < CLIP.cooldownS * 1000) {
      return null;
    }
    st.triggerTs = f.ts;
    st.motionLastTs = f.ts;
    return { type: 'open', triggerTs: f.ts };
  }
  if (f.score >= CLIP.continueScore) {
    st.motionLastTs = f.ts;
  }
  if (f.ts - st.triggerTs >= CLIP.maxS * 1000) {
    return close(st, 'max', f.ts);
  }
  if (f.score < CLIP.continueScore && f.ts - (st.motionLastTs ?? st.triggerTs) >= CLIP.quietS * 1000) {
    return close(st, 'quiet', f.ts);
  }
  return null;
}

/** No keyframe for staleS while a clip is open: close it where the last keyframe was. */
export function staleCheck(st: ClipState, nowTs: number, lastKeyframeTs: number): ClipEvent | null {
  if (st.triggerTs === null || nowTs - lastKeyframeTs < CLIP.staleS * 1000) {
    return null;
  }
  return close(st, 'stale', lastKeyframeTs);
}

function close(st: ClipState, stopped: 'quiet' | 'max' | 'stale', endTs: number): ClipEvent {
  const triggerTs = st.triggerTs!;
  st.triggerTs = null;
  st.motionLastTs = null;
  st.lastCloseTs = endTs;
  return { type: 'close', stopped, triggerTs, endTs };
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
