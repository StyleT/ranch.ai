// Tier 0: frame sampler. Reads the newest JPEG from the recorder's rolling on-disk buffer per camera
// (<buffer>/<camera>/<UTC ts>.jpg, written by com.ranch.recorder — the single owner of each camera stream,
// docs/CAMERA-ARCHITECTURE.md) and NEVER contacts go2rtc or a camera. A frame is kept when the scene changed more
// than RANCH_CHANGE_THRESHOLD against the last kept frame (mean abs diff of a 128x72 grey thumbnail) or when
// RANCH_FLOOR_S has passed, so nothing is missed at night. Kept frames go to <media>/frames/<camera>/<UTC date>/
// <ts>.jpg, a row in `frames`, and MQTT ranch/frames/<camera>. Because the sampler only reads disk, nothing it
// does (polling, bursts, restarts) can ever cause a camera to reconnect.
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus, topics, type Bus } from '@ranch/bus';

const GRAB_S = Number(process.env.RANCH_GRAB_S ?? 5);        // how often we sample the newest buffered frame
const FLOOR_S = Number(process.env.RANCH_FLOOR_S ?? 10);
const THRESHOLD = Number(process.env.RANCH_CHANGE_THRESHOLD ?? 0.04);     // whole-frame mean diff: lighting, large changes
const MOTION = Number(process.env.RANCH_MOTION_THRESHOLD ?? 0.08);        // block-max diff against the last kept frame: something moved
const RETENTION_D = Number(process.env.RANCH_FRAMES_RETENTION_D ?? 7);
// A camera is "online" when its buffer has a frame newer than RANCH_STALE_S. Staleness means the recorder is not
// getting frames (camera down / reconnecting); the sampler just waits — it never touches the camera.
const STALE_S = Number(process.env.RANCH_STALE_S ?? 30);
// Bursts (docs/MODEL-YOLO26.md part B): only a change keep opens one; it extends while consecutive buffered frames
// keep differing, stops at the first still frame or at BURST_MAX; one burst per camera per cooldown; and a global
// per-minute budget of member frames across all cameras keeps the cost bounded. Burst members are read from the
// same on-disk buffer (zero camera load).
const BURST_MAX = Number(process.env.RANCH_BURST_MAX ?? 4);
const BURST_GAP_S = Number(process.env.RANCH_BURST_GAP_S ?? 2);           // recorder is ~1 frame / 2 s
const BURST_CHANGE = Number(process.env.RANCH_BURST_CHANGE ?? 0.05);      // block-max diff between consecutive members: motion continues
const BURST_COOLDOWN_S = Number(process.env.RANCH_BURST_COOLDOWN_S ?? 10);
const BURST_BUDGET_PER_MIN = Number(process.env.RANCH_BURST_BUDGET_PER_MIN ?? 60);
const burstStats = { bursts: 0, burst_frames: 0, throttled: 0, tokens: BURST_BUDGET_PER_MIN, lastRefill: Date.now(), lastThrottleLog: 0 };
// motion metric of every sample since the last status message, per camera: p50/p90/max tell whether the thresholds fit
const motionSamples = new Map<string, number[]>();
const motionSummary = () => { const out: Record<string, { n: number; p50: number; p90: number; max: number }> = {}; for (const [cam, xs] of motionSamples) { const s = [...xs].sort((a, b) => a - b); if (s.length) out[cam] = { n: s.length, p50: +s[Math.floor(s.length * 0.5)]!.toFixed(3), p90: +s[Math.floor(s.length * 0.9)]!.toFixed(3), max: +s[s.length - 1]!.toFixed(3) }; } motionSamples.clear(); return out; };
function takeBurstToken(): boolean {
  const now = Date.now();
  if (now - burstStats.lastRefill >= 60_000) { burstStats.tokens = BURST_BUDGET_PER_MIN; burstStats.lastRefill = now; }
  if (burstStats.tokens <= 0) { burstStats.throttled++; if (now - burstStats.lastThrottleLog > 60_000) { burstStats.lastThrottleLog = now; log('burst throttled', { budget_per_min: BURST_BUDGET_PER_MIN }); } return false; }
  burstStats.tokens--; return true;
}
const THUMB_W = 128; const THUMB_H = 72; const BLOCK = 8; // 16x9 blocks of 8x8 for the local motion metric

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'ingest', msg, ...extra }) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cameras to sample: RANCH_CAMERAS if set, else the recorder's per-camera buffer subdirs. No camera/bridge call. */
function cameraList(): string[] {
  if (config.cameras.length) return config.cameras;
  try {
    return readdirSync(config.bufferDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !config.camerasExclude.includes(d.name))
      .map((d) => d.name).sort();
  } catch { return []; }
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
  try { names = readdirSync(dir).filter((n) => n.endsWith('.jpg')); } catch { return null; }
  if (afterName) names = names.filter((n) => n > afterName);
  if (!names.length) return null;
  names.sort();
  const name = names[names.length - 1]!;
  let buf: Buffer;
  try { buf = readFileSync(join(dir, name)); } catch { return null; }
  if (buf.length < 1024) return null; // ffmpeg may be mid-write; skip a partial file, we'll catch it next poll
  return { name, buf, ageS: (Date.now() - bufferNameMs(name)) / 1000 };
}

/** Wait up to `timeoutMs` for a buffered frame newer than `afterName` (used by bursts to read consecutive frames). */
async function nextBufferFrame(camera: string, afterName: string, timeoutMs: number): Promise<{ name: string; buf: Buffer } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const f = latestBufferFrame(camera, afterName);
    if (f) return f;
    if (Date.now() >= deadline) return null;
    await sleep(200);
  }
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length / 255;
}
/**
 * Local motion: the largest mean absolute difference over any 8x8 block of the greyscale thumbnail (0..1). A whole-
 * frame mean (meanAbsDiff) sees lighting changes but not a distant animal; the block maximum sees the animal.
 * Measured 22 Oct on consecutive frames (docs/MODEL-YOLO26.md): quiet cameras stay <= 0.021 day and night,
 * real motion scores 0.06-0.59.
 */
export function blockMaxDiff(a: Buffer, b: Buffer): number {
  let best = 0;
  for (let by = 0; by < THUMB_H / BLOCK; by++) for (let bx = 0; bx < THUMB_W / BLOCK; bx++) {
    let s = 0;
    for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) { const i = (by * BLOCK + y) * THUMB_W + bx * BLOCK + x; s += Math.abs(a[i]! - b[i]!); }
    const m = s / (BLOCK * BLOCK) / 255; if (m > best) best = m;
  }
  return best;
}

/**
 * Extend a change keep into a burst (docs/MODEL-YOLO26.md part B): read another buffered frame every BURST_GAP_S; a
 * frame becomes a member only if it differs from the previous member by >= BURST_CHANGE; the first still frame ends
 * the burst; at most BURST_MAX frames; every member costs one token of the global per-minute budget. `grab` returns
 * the next buffered frame (the caller threads the buffer cursor through it). Exported for the unit test.
 */
export async function extendBurst(o: { headId: number; camera: string; dir: string; headThumb: Buffer; grab: () => Promise<Buffer>; store: EventStore; bus: Bus; gapMs?: number }): Promise<{ members: number; frameIds: number[]; lastThumb?: Buffer; stopped: 'still' | 'max' | 'budget' | 'error' }> {
  const frameIds = [o.headId]; let prevThumb = o.headThumb; let seq = 1; let stopped: 'still' | 'max' | 'budget' | 'error' = 'max';
  while (seq < BURST_MAX) {
    await sleep(o.gapMs ?? BURST_GAP_S * 1000);
    if (!takeBurstToken()) { stopped = 'budget'; break; }
    let jpeg: Buffer; try { jpeg = await o.grab(); } catch { stopped = 'error'; break; }
    const img = sharp(jpeg);
    let meta: sharp.Metadata; let thumb: Buffer;
    try { [meta, thumb] = await Promise.all([img.metadata(), img.clone().resize(THUMB_W, THUMB_H, { fit: 'fill' }).greyscale().raw().toBuffer()]); }
    catch { stopped = 'error'; break; }
    const change = blockMaxDiff(thumb, prevThumb);
    if (change < BURST_CHANGE) { stopped = 'still'; break; }
    if (seq === 1) o.store.markBurstHead(o.headId);
    const ts = new Date().toISOString(); const path = join(o.dir, `${ts.replace(/[:.]/g, '-')}.jpg`);
    writeFileSync(path, jpeg);
    const id = o.store.insertFrame({ ts, camera: o.camera, path, reason: 'change', change, bytes: jpeg.length, burst_id: o.headId, seq, ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}) });
    await o.bus.publish(topics.frames(o.camera), { id, ts, camera: o.camera, path, reason: 'change', change, width: meta.width, height: meta.height, burst_id: o.headId, seq });
    frameIds.push(id); prevThumb = thumb; seq++;
  }
  if (frameIds.length > 1) {
    burstStats.bursts++; burstStats.burst_frames += frameIds.length - 1;
    await o.bus.publish(topics.bursts(o.camera), { burst_id: o.headId, camera: o.camera, frame_ids: frameIds, n: frameIds.length, stopped });
    return { members: frameIds.length - 1, frameIds, lastThumb: prevThumb, stopped };
  }
  return { members: 0, frameIds, stopped };
}

async function sampleCamera(camera: string, store: EventStore, bus: Bus, stop: { v: boolean }): Promise<void> {
  let lastThumb: Buffer | undefined; let lastKept = 0; let lastBurstEnd = 0;
  let lastName = ''; let staleSince = 0;
  while (!stop.v) {
    const t0 = Date.now();
    const f = latestBufferFrame(camera, lastName);
    if (!f) {
      // no frame newer than the last we processed; report the camera down if the whole buffer is stale
      const cur = latestBufferFrame(camera);
      const ageS = cur ? cur.ageS : Infinity;
      if (ageS > STALE_S && !staleSince) { staleSince = Date.now(); log('camera stale', { camera, newest_age_s: Number.isFinite(ageS) ? Math.round(ageS) : null }); }
      await sleep(1000);
      continue;
    }
    if (staleSince) { log('camera recovered', { camera, down_s: Math.round((Date.now() - staleSince) / 1000) }); staleSince = 0; }
    lastName = f.name;
    let meta: sharp.Metadata; let thumb: Buffer;
    try {
      const img = sharp(f.buf);
      [meta, thumb] = await Promise.all([img.metadata(), img.clone().resize(THUMB_W, THUMB_H, { fit: 'fill' }).greyscale().raw().toBuffer()]);
    } catch { await sleep(500); continue; } // partial/corrupt jpeg mid-write; try the next
    const change = lastThumb ? meanAbsDiff(thumb, lastThumb) : 1;
    const motion = lastThumb ? blockMaxDiff(thumb, lastThumb) : 0;
    if (lastThumb) (motionSamples.get(camera) ?? motionSamples.set(camera, []).get(camera)!).push(motion);
    const elapsed = (Date.now() - lastKept) / 1000;
    const reason = change >= THRESHOLD || motion >= MOTION ? 'change' : elapsed >= FLOOR_S ? 'floor' : null;
    if (reason) {
      const now = new Date();
      const ts = now.toISOString();
      const dir = join(config.mediaDir, 'frames', camera, ts.slice(0, 10));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${ts.replace(/[:.]/g, '-')}.jpg`);
      writeFileSync(path, f.buf);
      const id = store.insertFrame({ ts, camera, path, reason, change, bytes: f.buf.length, ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}) });
      await bus.publish(topics.frames(camera), { id, ts, camera, path, reason, change, width: meta.width, height: meta.height });
      lastThumb = thumb; lastKept = now.getTime();
      if (reason === 'change' && BURST_MAX > 1 && now.getTime() - lastBurstEnd > BURST_COOLDOWN_S * 1000) {
        const cursor = { name: f.name };
        const b = await extendBurst({ headId: id, camera, dir, headThumb: thumb, store, bus, grab: async () => {
          const nf = await nextBufferFrame(camera, cursor.name, BURST_GAP_S * 1000 + 2500);
          if (!nf) throw new Error('no buffered frame');
          cursor.name = nf.name; return nf.buf;
        } });
        if (b.members > 0) { lastThumb = b.lastThumb!; lastKept = Date.now(); lastBurstEnd = Date.now(); }
      }
    } else {
      lastThumb = thumb;
    }
    await sleep(Math.max(0, GRAB_S * 1000 - (Date.now() - t0)));
  }
}

const RETAIN_AFTER_S = Number(process.env.RANCH_RETAIN_AFTER_S ?? 3600);

async function prune(store: EventStore): Promise<void> {
  // 1. retention policy on frames older than an hour (docs/FRAMES-AND-BASELINE.md §1)
  const t0 = Date.now();
  const r = store.applyRetention({ olderThanMs: RETAIN_AFTER_S * 1000 });
  let removed = 0;
  for (const p of r.paths) { try { unlinkSync(p); removed++; } catch { /* already gone */ } }
  if (r.kept || r.deleted) log('retention applied', { kept: r.kept, deleted: r.deleted, files: removed, ms: Date.now() - t0 });
  // 2. age limit for everything else
  const before = new Date(Date.now() - RETENTION_D * 86400e3).toISOString();
  const paths = store.pruneFrames(before);
  removed = 0;
  for (const p of paths) { try { unlinkSync(p); removed++; } catch { /* already gone */ } }
  if (paths.length) log('pruned frames', { before, rows: paths.length, files: removed });
}

async function main(): Promise<void> {
  const store = new EventStore(config.dbPath);
  const bus = await connectBus('ingest');
  const cameras = cameraList();
  log('starting', { cameras, grab_s: GRAB_S, floor_s: FLOOR_S, threshold: THRESHOLD, motion_threshold: MOTION, retention_d: RETENTION_D, stale_s: STALE_S, buffer: config.bufferDir, burst: { max: BURST_MAX, gap_s: BURST_GAP_S, change: BURST_CHANGE, cooldown_s: BURST_COOLDOWN_S, budget_per_min: BURST_BUDGET_PER_MIN }, media: config.mediaDir, db: config.dbPath });
  const stop = { v: false };
  const status = setInterval(() => {
    const m = process.memoryUsage();
    void bus.publish(topics.status('ingest'), { ts: new Date().toISOString(), pid: process.pid, cameras, rss_mb: Math.round(m.rss / 1048576), bursts: burstStats.bursts, burst_frames: burstStats.burst_frames, burst_throttled: burstStats.throttled, burst_budget_per_min: BURST_BUDGET_PER_MIN, motion_threshold: MOTION, motion: motionSummary() }, { retain: true });
  }, 60_000);
  const pruner = setInterval(() => void prune(store), 3600_000);
  await prune(store);
  const shutdown = async () => { stop.v = true; clearInterval(status); clearInterval(pruner); await bus.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
  // A per-camera loop never throws out (read/decode errors are caught inside), so one bad camera can't exit the
  // process; guard anyway so an unexpected error is logged and that camera restarts instead of killing the daemon.
  await Promise.all(cameras.map((c) => sampleCamera(c, store, bus, stop).catch((e) => log('camera loop crashed', { camera: c, error: String(e) }))));
}

// Run the daemon only when this file is the entry point (the burst test imports extendBurst).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
