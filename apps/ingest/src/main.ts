// Tier 0: frame sampler. One JPEG per camera from go2rtc every RANCH_GRAB_S seconds (a one-shot HTTP request, no
// decoder held open: see HANDOFF.md on ffmpeg memory). A frame is kept when the scene changed more than
// RANCH_CHANGE_THRESHOLD against the last kept frame (mean abs diff of a 64x36 grey thumbnail) or when
// RANCH_FLOOR_S has passed since the last kept one, so nothing is missed at night. Kept frames go to
// <media>/frames/<camera>/<UTC date>/<ts>.jpg, a row in `frames`, and MQTT ranch/frames/<camera>.
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus, topics, type Bus } from '@ranch/bus';

const GRAB_S = Number(process.env.RANCH_GRAB_S ?? 5);
const FLOOR_S = Number(process.env.RANCH_FLOOR_S ?? 10);
const THRESHOLD = Number(process.env.RANCH_CHANGE_THRESHOLD ?? 0.04);
const RETENTION_D = Number(process.env.RANCH_FRAMES_RETENTION_D ?? 7);
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

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length / 255;
}

async function sampleCamera(camera: string, store: EventStore, bus: Bus, stop: { v: boolean }): Promise<void> {
  let lastThumb: Buffer | undefined; let lastKept = 0; let failures = 0;
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
      failures = 0;
    } catch (e) {
      failures++;
      if (failures === 1 || failures % 12 === 0) log('grab failed', { camera, failures, error: String(e) });
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
  log('starting', { cameras, grab_s: GRAB_S, floor_s: FLOOR_S, threshold: THRESHOLD, retention_d: RETENTION_D, media: config.mediaDir, db: config.dbPath });
  const stop = { v: false };
  const status = setInterval(() => {
    const m = process.memoryUsage();
    void bus.publish(topics.status('ingest'), { ts: new Date().toISOString(), pid: process.pid, cameras, rss_mb: Math.round(m.rss / 1048576) }, { retain: true });
  }, 60_000);
  const pruner = setInterval(() => void prune(store), 3600_000);
  await prune(store);
  const shutdown = async () => { stop.v = true; clearInterval(status); clearInterval(pruner); await bus.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
  await Promise.all(cameras.map((c) => sampleCamera(c, store, bus, stop)));
}

main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
