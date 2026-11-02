// Tier 0: frame sampler. Reads the newest JPEG from the recorder's rolling on-disk buffer per camera
// (<buffer>/<camera>/<UTC ts>.jpg, written by com.ranch.recorder — the single owner of each camera stream,
// docs/CAMERA-ARCHITECTURE.md) and NEVER contacts go2rtc or a camera. A frame is kept when the scene changed more
// than RANCH_CHANGE_THRESHOLD against the last kept frame (mean abs diff of a 128x72 grey thumbnail) or when
// RANCH_FLOOR_S has passed, so nothing is missed at night. Kept frames go to <media>/frames/<camera>/<UTC date>/
// <ts>.jpg, a row in `frames`, and MQTT ranch/frames/<camera>. Because the sampler only reads disk, nothing it
// does (polling, bursts, restarts) can ever cause a camera to reconnect.
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus, topics, type Bus } from '@ranch/bus';
import {
  CLIP,
  step,
  staleCheck,
  cutClip,
  sampleFrames,
  thumbnail,
  meanAbsDiff,
  blockMaxDiff,
  litFraction,
  idleState,
  type ClipState,
  type ClipEvent,
  type ScoreSeries,
} from './clips.ts';

const GRAB_S = Number(process.env.RANCH_GRAB_S ?? 5); // how often we sample the newest buffered frame
const FLOOR_S = Number(process.env.RANCH_FLOOR_S ?? 10);
const THRESHOLD = Number(process.env.RANCH_CHANGE_THRESHOLD ?? 0.04); // whole-frame mean diff: lighting, large changes
const MOTION = Number(process.env.RANCH_MOTION_THRESHOLD ?? 0.08); // block-max diff against the last kept frame: something moved
const RETENTION_D = Number(process.env.RANCH_FRAMES_RETENTION_D ?? 7);
// A camera is "online" when its buffer has a frame newer than RANCH_STALE_S. Staleness means the recorder is not
// getting frames (camera down / reconnecting); the sampler just waits — it never touches the camera.
const STALE_S = Number(process.env.RANCH_STALE_S ?? 30);
// motion metric of every sample since the last status message, per camera: p50/p90/max tell whether the thresholds fit
const motionSamples = new Map<string, number[]>();
const motionSummary = () => {
  const out: Record<string, { n: number; p50: number; p90: number; max: number }> = {};
  for (const [cam, xs] of motionSamples) {
    const s = [...xs].sort((a, b) => a - b);
    if (s.length) {
      out[cam] = {
        n: s.length,
        p50: +s[Math.floor(s.length * 0.5)]!.toFixed(3),
        p90: +s[Math.floor(s.length * 0.9)]!.toFixed(3),
        max: +s[s.length - 1]!.toFixed(3),
      };
    }
  }
  motionSamples.clear();
  return out;
};
// Motion clips (docs/CLIPS.md, 1 Nov): the decisions are in clips.ts; counters for the status message
const clipStats = { open: 0, cut: 0, dropped: 0, frames: 0 };
const seriesJson = (s: ScoreSeries) =>
  JSON.stringify(s.map(([t, a, b]) => [+t.toFixed(1), +a.toFixed(3), +b.toFixed(3)]));
const iso = (ms: number) => new Date(ms).toISOString();
const freeGb = () => {
  try {
    const s = statfsSync(config.mediaDir);
    return (s.bavail * s.bsize) / 2 ** 30;
  } catch {
    return Infinity;
  }
};

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'ingest', msg, ...extra }) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cameras to sample: RANCH_CAMERAS if set, else the recorder's per-camera buffer subdirs. No camera/bridge call. */
function cameraList(): string[] {
  if (config.cameras.length) {
    return config.cameras;
  }
  try {
    return readdirSync(config.bufferDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !config.camerasExclude.includes(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Buffer filename `2026-10-22T12-45-23Z.jpg` -> epoch ms. */
function bufferNameMs(name: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : Date.now();
}

/** Newest JPEG in the camera's buffer (optionally strictly newer than `afterName`), with its age in seconds.
 *  Filenames are UTC timestamps, so lexicographic order is chronological. Reads disk only. */
function latestBufferFrame(camera: string, afterName?: string): { name: string; buf: Buffer; ageS: number } | null {
  const dir = join(config.bufferDir, camera);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jpg'));
  } catch {
    return null;
  }
  if (afterName) {
    names = names.filter((n) => n > afterName);
  }
  if (!names.length) {
    return null;
  }
  names.sort();
  const name = names[names.length - 1]!;
  let buf: Buffer;
  try {
    buf = readFileSync(join(dir, name));
  } catch {
    return null;
  }
  if (buf.length < 1024) {
    return null;
  } // ffmpeg may be mid-write; skip a partial file, we'll catch it next poll
  return { name, buf, ageS: (Date.now() - bufferNameMs(name)) / 1000 };
}

/** A clip closed: cut the mp4 from the ring, sample frames for the detector, publish both. Failures close the row without media. */
async function finishClip(
  store: EventStore,
  bus: Bus,
  camera: string,
  clipId: number,
  ev: Extract<ClipEvent, { type: 'close' }>,
): Promise<void> {
  clipStats.open--;
  try {
    const cut = await cutClip({
      ringDir: config.ringDir,
      clipsDir: config.clipsDir,
      camera,
      triggerTs: ev.triggerTs,
      endTs: ev.endTs,
    });
    if (!cut) {
      store.abandonClip(clipId, iso(ev.endTs), ev.stopped, seriesJson(ev.series));
      log('clip abandoned: no ring segments', { camera, clip_id: clipId, stopped: ev.stopped });
      return;
    }
    const startIso = iso(cut.startMs);
    const prerollS = (ev.triggerTs - cut.startMs) / 1000;
    store.closeClip(clipId, {
      end_ts: iso(ev.endTs),
      stopped: ev.stopped,
      scores: seriesJson(ev.series),
      start_ts: startIso,
      path: cut.path,
      bytes: cut.bytes,
      duration_s: cut.duration_s,
      fps: cut.fps,
      width: cut.width,
      height: cut.height,
      preroll_s: prerollS,
    });
    const dir = join(config.mediaDir, 'frames', camera, startIso.slice(0, 10));
    const paths = await sampleFrames({ clipPath: cut.path, dir, prefix: `clip-${basename(cut.path, '.mp4')}` });
    const width = CLIP.sampleWidth;
    const height = cut.width ? Math.round((cut.height * width) / cut.width / 2) * 2 : 0;
    const ids: number[] = [];
    for (const [i, path] of paths.entries()) {
      const ts = iso(cut.startMs + (i * 1000) / CLIP.sampleFps);
      const id = store.insertFrame({
        ts,
        camera,
        path,
        reason: 'change',
        clip_id: clipId,
        width,
        height,
        bytes: statSync(path).size,
        ...(i > 0 ? { burst_id: ids[0], seq: i } : {}),
      });
      if (i === 0) {
        store.markBurstHead(id);
      } // the clip's frames are a burst: head + members, so retention, tracks and the UI need no new case
      ids.push(id);
      await bus.publish(topics.frames(camera), {
        id,
        ts,
        camera,
        path,
        reason: 'change',
        width,
        height,
        burst_id: ids[0],
        seq: i,
        clip_id: clipId,
      });
    }
    clipStats.cut++;
    clipStats.frames += ids.length;
    await bus.publish(topics.clips(camera), {
      clip_id: clipId,
      burst_id: ids[0],
      camera,
      frame_ids: ids,
      n: ids.length,
      stopped: ev.stopped,
      start_ts: startIso,
      end_ts: iso(ev.endTs),
      duration_s: cut.duration_s,
      preroll_s: prerollS,
      path: cut.path,
    });
    log('clip cut', {
      camera,
      clip_id: clipId,
      stopped: ev.stopped,
      duration_s: +cut.duration_s.toFixed(1),
      preroll_s: +prerollS.toFixed(1),
      segments: cut.segments,
      mb: +(cut.bytes / 1048576).toFixed(1),
      frames: ids.length,
      fps: +cut.fps.toFixed(1),
    });
  } catch (e) {
    store.abandonClip(clipId, iso(ev.endTs), ev.stopped, seriesJson(ev.series));
    log('clip failed', { camera, clip_id: clipId, error: String(e).slice(0, 200) });
  }
}

async function sampleCamera(camera: string, store: EventStore, bus: Bus, stop: { v: boolean }): Promise<void> {
  let lastThumb: Buffer | undefined;
  let lastKept = 0;
  let lastName = '';
  let staleSince = 0;
  // clip decisions run on consecutive keyframes (the buffer's 2 s cadence), independent of what the sampler keeps
  const clip: ClipState = idleState();
  let prevThumb: Buffer | undefined;
  let openClipId: number | null = null; // the candidate's or clip's row, from the trigger keyframe on
  let lastKeyTs = 0;
  const dropClip = (ev: Extract<ClipEvent, { type: 'drop' }>) => {
    if (openClipId === null) {
      return;
    }
    store.dropClip(openClipId, iso(ev.endTs), ev.reason, seriesJson(ev.series));
    log('clip dropped', { camera, clip_id: openClipId, reason: ev.reason, keyframes: ev.series.length });
    openClipId = null;
    clipStats.open--;
    clipStats.dropped++;
  };
  while (!stop.v) {
    const t0 = Date.now();
    const f = latestBufferFrame(camera, lastName);
    if (!f) {
      // no frame newer than the last we processed; report the camera down if the whole buffer is stale
      const cur = latestBufferFrame(camera);
      const ageS = cur ? cur.ageS : Infinity;
      if (ageS > STALE_S && !staleSince) {
        staleSince = Date.now();
        log('camera stale', { camera, newest_age_s: Number.isFinite(ageS) ? Math.round(ageS) : null });
      }
      const sev = staleCheck(clip, Date.now(), lastKeyTs);
      if (sev?.type === 'close' && openClipId !== null) {
        const id = openClipId;
        openClipId = null;
        void finishClip(store, bus, camera, id, sev);
      } else if (sev?.type === 'drop') {
        dropClip(sev);
      }
      await sleep(1000);
      continue;
    }
    if (staleSince) {
      log('camera recovered', { camera, down_s: Math.round((Date.now() - staleSince) / 1000) });
      staleSince = 0;
      prevThumb = undefined; // the first keyframe after a gap compares with nothing: a stale reference scores like motion
    }
    lastName = f.name;
    let meta: sharp.Metadata;
    let thumb: Buffer;
    try {
      const img = sharp(f.buf);
      [meta, thumb] = await Promise.all([img.metadata(), thumbnail(img)]);
    } catch {
      await sleep(500);
      continue;
    } // partial/corrupt jpeg mid-write; try the next
    const change = lastThumb ? meanAbsDiff(thumb, lastThumb) : 1;
    const motion = lastThumb ? blockMaxDiff(thumb, lastThumb) : 0;
    const keyTs = bufferNameMs(f.name);
    lastKeyTs = keyTs;
    const key = prevThumb
      ? { ts: keyTs, score: blockMaxDiff(thumb, prevThumb), lit: litFraction(thumb, prevThumb) }
      : { ts: keyTs, score: 0, lit: 0 };
    const ev = step(clip, key);
    prevThumb = thumb;
    if ((ev?.type === 'candidate' || ev?.type === 'open') && openClipId === null) {
      if (freeGb() < CLIP.minFreeGb) {
        Object.assign(clip, idleState(), { lastCloseTs: clip.lastCloseTs });
        log('clip not opened: low disk', { camera, free_gb: Math.round(freeGb()) });
      } else {
        openClipId = store.insertClip({
          camera,
          trigger_ts: iso(keyTs),
          start_ts: iso(keyTs - CLIP.prerollS * 1000),
          trigger_score: +key.score.toFixed(3),
        });
        clipStats.open++;
        log(ev.type === 'open' ? 'clip open' : 'clip candidate', {
          camera,
          clip_id: openClipId,
          score: +key.score.toFixed(3),
          lit: +key.lit.toFixed(2),
        });
      }
    } else if (ev?.type === 'open' && openClipId !== null) {
      log('clip confirmed', { camera, clip_id: openClipId, keyframes: clip.series.length });
    } else if (ev?.type === 'drop') {
      dropClip(ev);
    } else if (ev?.type === 'global') {
      log('global change, no clip', { camera, score: +ev.score.toFixed(3), lit: +ev.lit.toFixed(2) });
    } else if (ev?.type === 'close' && openClipId !== null) {
      const id = openClipId;
      openClipId = null;
      void finishClip(store, bus, camera, id, ev);
    }
    if (lastThumb) {
      (motionSamples.get(camera) ?? motionSamples.set(camera, []).get(camera)!).push(motion);
    }
    const elapsed = (Date.now() - lastKept) / 1000;
    const reason = change >= THRESHOLD || motion >= MOTION ? 'change' : elapsed >= FLOOR_S ? 'floor' : null;
    if (reason) {
      const now = new Date();
      const ts = now.toISOString();
      const dir = join(config.mediaDir, 'frames', camera, ts.slice(0, 10));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${ts.replace(/[:.]/g, '-')}.jpg`);
      writeFileSync(path, f.buf);
      const id = store.insertFrame({
        ts,
        camera,
        path,
        reason,
        change,
        bytes: f.buf.length,
        ...(meta.width ? { width: meta.width } : {}),
        ...(meta.height ? { height: meta.height } : {}),
      });
      await bus.publish(topics.frames(camera), {
        id,
        ts,
        camera,
        path,
        reason,
        change,
        width: meta.width,
        height: meta.height,
      });
      lastThumb = thumb;
      lastKept = now.getTime();
    } else {
      lastThumb = thumb;
    }
    await sleep(Math.max(0, (openClipId !== null ? 1000 : GRAB_S * 1000) - (Date.now() - t0))); // every keyframe while a clip is open
  }
}

const RETAIN_AFTER_S = Number(process.env.RANCH_RETAIN_AFTER_S ?? 3600);

async function prune(store: EventStore): Promise<void> {
  // 1. retention policy on frames older than an hour (docs/FRAMES-AND-BASELINE.md §1)
  const t0 = Date.now();
  const r = store.applyRetention({ olderThanMs: RETAIN_AFTER_S * 1000 });
  let removed = 0;
  for (const p of r.paths) {
    try {
      unlinkSync(p);
      removed++;
    } catch {
      /* already gone */
    }
  }
  if (r.kept || r.deleted) {
    log('retention applied', { kept: r.kept, deleted: r.deleted, files: removed, ms: Date.now() - t0 });
  }
  // 2. age limit for everything else
  const before = new Date(Date.now() - RETENTION_D * 86400e3).toISOString();
  const paths = store.pruneFrames(before);
  removed = 0;
  for (const p of paths) {
    try {
      unlinkSync(p);
      removed++;
    } catch {
      /* already gone */
    }
  }
  if (paths.length) {
    log('pruned frames', { before, rows: paths.length, files: removed });
  }
  // 3. clip media (rows stay, docs/PLAN.md: events live forever)
  const expired = store.expireClips(new Date(Date.now() - CLIP.retentionD * 86400e3).toISOString());
  removed = 0;
  for (const c of expired) {
    try {
      unlinkSync(c.path);
      removed++;
    } catch {
      /* already gone */
    }
  }
  if (expired.length) {
    log('expired clips', { rows: expired.length, files: removed });
  }
}

async function main(): Promise<void> {
  const store = new EventStore(config.dbPath);
  const bus = await connectBus('ingest');
  const cameras = cameraList();
  for (const c of store.openClips()) {
    store.abandonClip(c.id, new Date().toISOString(), 'stale');
  } // left open by a previous run
  log('starting', {
    cameras,
    grab_s: GRAB_S,
    floor_s: FLOOR_S,
    threshold: THRESHOLD,
    motion_threshold: MOTION,
    retention_d: RETENTION_D,
    stale_s: STALE_S,
    buffer: config.bufferDir,
    media: config.mediaDir,
    db: config.dbPath,
  });
  const stop = { v: false };
  const status = setInterval(() => {
    const m = process.memoryUsage();
    void bus.publish(
      topics.status('ingest'),
      {
        ts: new Date().toISOString(),
        pid: process.pid,
        cameras,
        rss_mb: Math.round(m.rss / 1048576),
        clips_open: clipStats.open,
        clips_cut: clipStats.cut,
        clip_frames: clipStats.frames,
        motion_threshold: MOTION,
        motion: motionSummary(),
      },
      { retain: true },
    );
  }, 60_000);
  const pruner = setInterval(() => void prune(store), 3600_000);
  await prune(store);
  const shutdown = async () => {
    stop.v = true;
    clearInterval(status);
    clearInterval(pruner);
    await bus.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  // A per-camera loop never throws out (read/decode errors are caught inside), so one bad camera can't exit the
  // process; guard anyway so an unexpected error is logged and that camera restarts instead of killing the daemon.
  await Promise.all(
    cameras.map((c) =>
      sampleCamera(c, store, bus, stop).catch((e) => log('camera loop crashed', { camera: c, error: String(e) })),
    ),
  );
}

// Run the daemon only when this file is the entry point (tests import the module).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log('fatal', { error: String(e) });
    process.exit(1);
  });
}
