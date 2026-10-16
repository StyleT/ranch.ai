// Tier 0: frame sampler. One JPEG per camera from go2rtc every RANCH_GRAB_S seconds (a one-shot HTTP request, no
// decoder held open: see HANDOFF.md on ffmpeg memory). A frame is kept when the scene changed more than
// RANCH_CHANGE_THRESHOLD against the last kept frame (mean abs diff of a 64x36 grey thumbnail) or when
// RANCH_FLOOR_S has passed since the last kept one, so nothing is missed at night. Kept frames go to
// <media>/frames/<camera>/<UTC date>/<ts>.jpg, a row in `frames`, and MQTT ranch/frames/<camera>.
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length / 255;
}

async function sampleCamera(camera: string, store: EventStore, bus: Bus, stop: { v: boolean }): Promise<void> {
  let lastThumb: Buffer | undefined; let lastKept = 0; let failures = 0;
  let lastOk = Date.now(); let lastReset = 0;
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
      }
      failures = 0; lastOk = Date.now();
    } catch (e) {
      failures++;
      if (failures === 1 || failures % 12 === 0) log('grab failed', { camera, failures, error: String(e) });
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

async function prune(store: EventStore): Promise<void> {
  const before = new Date(Date.now() - RETENTION_D * 86400e3).toISOString();
  const paths = store.pruneFrames(before);
  let removed = 0;
  for (const p of paths) { try { unlinkSync(p); removed++; } catch { /* already gone */ } }
  if (paths.length) log('pruned frames', { before, rows: paths.length, files: removed });
}

async function main(): Promise<void> {
  const store = new EventStore(config.dbPath);
  const bus = await connectBus('ingest');
  const cameras = await cameraList();
  log('starting', { cameras, grab_s: GRAB_S, floor_s: FLOOR_S, threshold: THRESHOLD, retention_d: RETENTION_D, stall_reset_s: STALL_RESET_S, media: config.mediaDir, db: config.dbPath });
  const stop = { v: false };
  const status = setInterval(() => {
    const m = process.memoryUsage();
    void bus.publish(topics.status('ingest'), { ts: new Date().toISOString(), pid: process.pid, cameras, rss_mb: Math.round(m.rss / 1048576), resets }, { retain: true });
  }, 60_000);
  const pruner = setInterval(() => void prune(store), 3600_000);
  await prune(store);
  const shutdown = async () => { stop.v = true; clearInterval(status); clearInterval(pruner); await bus.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
  await Promise.all(cameras.map((c) => sampleCamera(c, store, bus, stop)));
}

main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
