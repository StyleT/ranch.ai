// Tier 0: frame sampler. One JPEG per camera from go2rtc every RANCH_GRAB_S seconds (a one-shot HTTP request, no
// decoder held open: see HANDOFF.md on ffmpeg memory). A frame is kept when the scene changed more than
// RANCH_CHANGE_THRESHOLD against the last kept frame (mean abs diff of a 64x36 grey thumbnail) or when
// RANCH_FLOOR_S has passed since the last kept one, so nothing is missed at night. Kept frames go to
// <media>/frames/<camera>/<UTC date>/<ts>.jpg, a row in `frames`, and MQTT ranch/frames/<camera>.
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus, topics, type Bus } from '@ranch/bus';

const GRAB_S = Number(process.env.RANCH_GRAB_S ?? 5);
const FLOOR_S = Number(process.env.RANCH_FLOOR_S ?? 10);
const THRESHOLD = Number(process.env.RANCH_CHANGE_THRESHOLD ?? 0.04);
const RETENTION_D = Number(process.env.RANCH_FRAMES_RETENTION_D ?? 7);
// Stall watchdog (incident 16 Oct, docs/CAMERAS.md): a camera's TUTK session can die while go2rtc keeps the dead
// producer and every new consumer attaches to it and hangs, forever. If a camera has produced nothing for
// RANCH_STALL_RESET_S we delete its go2rtc stream and re-add it from the bridge's go2rtc.yaml, at most once per
// RANCH_STALL_COOLDOWN_S. A camera that is really offline just gets a fresh (and equally idle) stream.
// Keep-alive consumer (evidence 19 Oct, docs/CAMERAS.md): a one-shot frame.jpeg grab starts a fresh TUTK session
// (LAN discovery + DTLS handshake) every time and fails about half the time on these 2.4 GHz cameras; with a
// consumer holding the stream open, delivery was 275-337 frames/h instead of 65-226, and grabs answered in ~1 s
// instead of 3-8 s. So each camera gets one persistent in-process fMP4 consumer whose body is discarded. No child
// processes; go2rtc muxes without transcoding.
const KEEPALIVE = (process.env.RANCH_KEEPALIVE ?? '1') !== '0';
// Bursts (docs/MODEL-YOLO26.md part B): only a change keep opens one; it extends 1 s at a time while consecutive
// grabs keep differing, stops at the first still grab or at BURST_MAX; one burst per camera per cooldown; and a
// global per-minute budget of member frames across all cameras keeps the cost bounded.
const BURST_MAX = Number(process.env.RANCH_BURST_MAX ?? 4);
const BURST_GAP_S = Number(process.env.RANCH_BURST_GAP_S ?? 1);
const BURST_CHANGE = Number(process.env.RANCH_BURST_CHANGE ?? 0.01);
const BURST_COOLDOWN_S = Number(process.env.RANCH_BURST_COOLDOWN_S ?? 10);
const BURST_BUDGET_PER_MIN = Number(process.env.RANCH_BURST_BUDGET_PER_MIN ?? 60);
const burstStats = { bursts: 0, burst_frames: 0, throttled: 0, tokens: BURST_BUDGET_PER_MIN, lastRefill: Date.now(), lastThrottleLog: 0 };
function takeBurstToken(): boolean {
  const now = Date.now();
  if (now - burstStats.lastRefill >= 60_000) { burstStats.tokens = BURST_BUDGET_PER_MIN; burstStats.lastRefill = now; }
  if (burstStats.tokens <= 0) { burstStats.throttled++; if (now - burstStats.lastThrottleLog > 60_000) { burstStats.lastThrottleLog = now; log('burst throttled', { budget_per_min: BURST_BUDGET_PER_MIN }); } return false; }
  burstStats.tokens--; return true;
}
const STALL_RESET_S = Number(process.env.RANCH_STALL_RESET_S ?? 180);
const STALL_COOLDOWN_S = Number(process.env.RANCH_STALL_COOLDOWN_S ?? 300);
const GO2RTC_CONFIG = process.env.RANCH_GO2RTC_CONFIG ?? '/usr/local/ranch/var/wyze-bridge/go2rtc.yaml';
let resets = 0;
const THUMB_W = 64; const THUMB_H = 36;

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'ingest', msg, ...extra }) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cameraList(): Promise<string[]> {
  if (config.cameras.length) return config.cameras;
  const res = await fetch(`${config.bridgeUrl}/api/cameras`, { signal: AbortSignal.timeout(5000) });
  const cams = (await res.json()) as { name: string }[];
  return cams.map((c) => c.name).filter((n) => !config.camerasExclude.includes(n)).sort();
}

async function grab(camera: string): Promise<Buffer> {
  const res = await fetch(`${config.go2rtcUrl}/api/frame.jpeg?src=${encodeURIComponent(camera)}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`go2rtc ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function streamSource(camera: string): string | undefined {
  const text = readFileSync(GO2RTC_CONFIG, 'utf8');
  // Match "  <camera>:\n    - wyze://..." in the bridge-generated YAML. Built with RegExp so the escapes survive.
  const name = camera.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('^  ' + name + ':\\n\\s+- (\\S+)', 'm').exec(text);
  return m?.[1];
}

/** Drop the camera's go2rtc stream (dead producer plus leaked consumers), then recreate it from the bridge's
 *  config. The bridge's own HealthCheck (every 30 s) reconnects a camera whose stream has 0 producers, so the
 *  delete alone recovers too; it never notices a producer that exists but delivers nothing, which is our case. */
async function resetStream(camera: string): Promise<'recreated_by_bridge' | 'recreated' | 'deleted'> {
  const q = encodeURIComponent(camera);
  const base = `${config.go2rtcUrl}/api/streams`;
  await fetch(`${base}?src=${q}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
  // The bridge's HealthCheck usually re-adds the stream within ~10 s of the delete; give it a moment before
  // we PUT our own copy, so the two do not race.
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    const r = await fetch(`${base}?src=${q}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return 'recreated_by_bridge';
  }
  const src = streamSource(camera);
  if (!src) return 'deleted';
  const r = await fetch(`${base}?name=${q}&src=${encodeURIComponent(src)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  return r.ok ? 'recreated' : 'deleted';
}

async function keepAlive(camera: string, stop: { v: boolean }): Promise<void> {
  let failures = 0;
  while (!stop.v) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${config.go2rtcUrl}/api/stream.mp4?src=${encodeURIComponent(camera)}`);
      if (!res.ok || !res.body) throw new Error(`go2rtc ${res.status}`);
      log('keepalive connected', { camera });
      for await (const _chunk of res.body) { if (stop.v) break; }
      failures = 0;
    } catch (e) {
      failures++;
      if (failures === 1 || failures % 12 === 0) log('keepalive failed', { camera, failures, error: String(e).slice(0, 80) });
    }
    if (Date.now() - t0 > 60_000) failures = 0; // a long-lived session that ended is not a failure streak
    await sleep(Math.min(60_000, 2_000 * (failures + 1)));
  }
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length / 255;
}

/**
 * Extend a change keep into a burst (docs/MODEL-YOLO26.md part B): grab again every BURST_GAP_S; a grab becomes a
 * member only if it differs from the previous member by >= BURST_CHANGE; the first still grab ends the burst; at
 * most BURST_MAX frames; every member costs one token of the global per-minute budget. Returns what was added so
 * the caller can continue its own change detection from the last member. Exported for the unit test.
 */
export async function extendBurst(o: { headId: number; camera: string; dir: string; headThumb: Buffer; grab: () => Promise<Buffer>; store: EventStore; bus: Bus; gapMs?: number }): Promise<{ members: number; frameIds: number[]; lastThumb?: Buffer; stopped: 'still' | 'max' | 'budget' | 'error' }> {
  const frameIds = [o.headId]; let prevThumb = o.headThumb; let seq = 1; let stopped: 'still' | 'max' | 'budget' | 'error' = 'max';
  while (seq < BURST_MAX) {
    await sleep(o.gapMs ?? BURST_GAP_S * 1000);
    if (!takeBurstToken()) { stopped = 'budget'; break; }
    let jpeg: Buffer; try { jpeg = await o.grab(); } catch { stopped = 'error'; break; }
    const img = sharp(jpeg);
    const [meta, thumb] = await Promise.all([img.metadata(), img.clone().resize(THUMB_W, THUMB_H, { fit: 'fill' }).greyscale().raw().toBuffer()]);
    const change = meanAbsDiff(thumb, prevThumb);
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
  let lastThumb: Buffer | undefined; let lastKept = 0; let failures = 0; let lastBurstEnd = 0;
  let lastOk = Date.now(); let lastReset = 0; let failingSince = 0; let failClass = '';
  const classify = (e: unknown) => { const m = String(e); return /Timeout/.test(m) ? 'timeout' : /empty/.test(m) ? 'empty' : /404/.test(m) ? '404' : /fetch failed/.test(m) ? 'unreachable' : m.slice(0, 40); };
  while (!stop.v) {
    const t0 = Date.now();
    try {
      const jpeg = await grab(camera);
      const img = sharp(jpeg);
      const [meta, thumb] = await Promise.all([img.metadata(), img.clone().resize(THUMB_W, THUMB_H, { fit: 'fill' }).greyscale().raw().toBuffer()]);
      const change = lastThumb ? meanAbsDiff(thumb, lastThumb) : 1;
      const elapsed = (Date.now() - lastKept) / 1000;
      const reason = change >= THRESHOLD ? 'change' : elapsed >= FLOOR_S ? 'floor' : null;
      if (reason) {
        const now = new Date();
        const ts = now.toISOString();
        const dir = join(config.mediaDir, 'frames', camera, ts.slice(0, 10));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${ts.replace(/[:.]/g, '-')}.jpg`);
        writeFileSync(path, jpeg);
        const id = store.insertFrame({ ts, camera, path, reason, change, bytes: jpeg.length, ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}) });
        await bus.publish(topics.frames(camera), { id, ts, camera, path, reason, change, width: meta.width, height: meta.height });
        lastThumb = thumb; lastKept = now.getTime();
        if (reason === 'change' && BURST_MAX > 1 && now.getTime() - lastBurstEnd > BURST_COOLDOWN_S * 1000) {
          const b = await extendBurst({ headId: id, camera, dir, headThumb: thumb, grab: () => grab(camera), store, bus });
          if (b.members > 0) { lastThumb = b.lastThumb!; lastKept = Date.now(); lastBurstEnd = Date.now(); }
        }
      }
      if (failingSince) { log('grab recovered', { camera, down_s: Math.round((Date.now() - failingSince) / 1000), failures, last_error: failClass }); failingSince = 0; }
      failures = 0; lastOk = Date.now();
    } catch (e) {
      failures++;
      const cls = classify(e);
      // Log the edges (first failure, class change) and a heartbeat every 12th, not every retry.
      if (!failingSince) { failingSince = Date.now(); failClass = cls; log('grab failing', { camera, error: cls }); }
      else if (cls !== failClass) { log('grab error changed', { camera, from: failClass, to: cls, failures }); failClass = cls; }
      else if (failures % 12 === 0) log('grab still failing', { camera, failures, error: cls, down_s: Math.round((Date.now() - failingSince) / 1000) });
      const now = Date.now();
      if (now - lastOk > STALL_RESET_S * 1000 && now - lastReset > STALL_COOLDOWN_S * 1000) {
        lastReset = now; resets++;
        try { const result = await resetStream(camera); log('stream reset', { camera, failures, stalled_s: Math.round((now - lastOk) / 1000), result }); }
        catch (err) { log('stream reset failed', { camera, error: String(err) }); }
      }
      await sleep(Math.min(60_000, 5_000 * failures));
      continue;
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
  const cameras = await cameraList();
  log('starting', { cameras, grab_s: GRAB_S, floor_s: FLOOR_S, threshold: THRESHOLD, retention_d: RETENTION_D, stall_reset_s: STALL_RESET_S, keepalive: KEEPALIVE, keepalive_exclude: config.keepaliveExclude, burst: { max: BURST_MAX, gap_s: BURST_GAP_S, change: BURST_CHANGE, cooldown_s: BURST_COOLDOWN_S, budget_per_min: BURST_BUDGET_PER_MIN }, media: config.mediaDir, db: config.dbPath });
  const stop = { v: false };
  const status = setInterval(() => {
    const m = process.memoryUsage();
    void bus.publish(topics.status('ingest'), { ts: new Date().toISOString(), pid: process.pid, cameras, rss_mb: Math.round(m.rss / 1048576), resets, bursts: burstStats.bursts, burst_frames: burstStats.burst_frames, burst_throttled: burstStats.throttled, burst_budget_per_min: BURST_BUDGET_PER_MIN }, { retain: true });
  }, 60_000);
  const pruner = setInterval(() => void prune(store), 3600_000);
  await prune(store);
  const shutdown = async () => { stop.v = true; clearInterval(status); clearInterval(pruner); await bus.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
  await Promise.all([
    ...cameras.map((c) => sampleCamera(c, store, bus, stop)),
    ...(KEEPALIVE ? cameras.filter((c) => !config.keepaliveExclude.includes(c)).map((c) => keepAlive(c, stop)) : []),
  ]);
}

// Run the daemon only when this file is the entry point (the burst test imports extendBurst).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
