// Tier 1: runs the Core ML detector on every frame the sampler keeps. Subscribes to ranch/frames/+, feeds
// the native runner, stores detections, publishes ranch/detections/<camera>, and once a minute publishes
// per-camera label counts (max seen in that minute) to ranch/counts/<camera> and camera_counts.
import { basename } from 'node:path';
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus, topics } from '@ranch/bus';
import { Runner } from './runner.ts';

const MODEL = process.env.RANCH_DETECTOR_MODEL ?? '/usr/local/ranch/models/yolo11n.mlpackage';
const COMPUTE = (process.env.RANCH_DETECTOR_COMPUTE ?? 'ane') as 'all' | 'ane' | 'gpu' | 'cpu';
const THRESHOLD = Number(process.env.RANCH_DETECTOR_THRESHOLD ?? 0.25);
const COUNT_LABELS = (process.env.RANCH_COUNT_LABELS ?? 'horse person dog cow sheep car truck').split(/\s+/);
const MAX_QUEUE = 50;
const modelName = basename(MODEL).replace(/\.(mlpackage|mlmodelc)$/, '');

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'detector', msg, ...extra }) + '\n');

interface FrameMsg { id: number; ts: string; camera: string; path: string }

async function main(): Promise<void> {
  const store = new EventStore(config.dbPath);
  const runner = new Runner({ model: MODEL, compute: COMPUTE, threshold: THRESHOLD });
  const info = await runner.info;
  log('runner ready', { ...info });
  const bus = await connectBus('detector');

  // per minute, per camera: max count per label
  const minute = new Map<string, Map<string, number>>(); // key `${camera}|${minuteTs}`
  let inflight = 0; let dropped = 0; let processed = 0;

  await bus.subscribe('ranch/frames/+', (_t, payload) => {
    const f = payload as FrameMsg;
    if (inflight >= MAX_QUEUE) { dropped++; if (dropped % 50 === 1) log('queue full, dropping frames', { dropped }); return; }
    inflight++;
    void runner.detect(f.path).then(async (r) => {
      inflight--; processed++;
      store.insertDetections(f.id, r.detections.map((d) => ({ model: modelName, label: d.label, confidence: d.confidence, x: d.x, y: d.y, w: d.w, h: d.h, latency_ms: r.ms })));
      await bus.publish(topics.detections(f.camera), { ts: f.ts, camera: f.camera, frame_id: f.id, path: f.path, model: modelName, ms: r.ms, detections: r.detections });
      const key = `${f.camera}|${f.ts.slice(0, 16)}:00.000Z`;
      const m = minute.get(key) ?? new Map<string, number>();
      for (const label of COUNT_LABELS) m.set(label, Math.max(m.get(label) ?? 0, r.detections.filter((d) => d.label === label).length));
      minute.set(key, m);
    }).catch((e) => { inflight--; log('detect failed', { path: f.path, error: String(e) }); });
  });

  const flush = async () => {
    const cutoff = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
    for (const [key, m] of minute) {
      const [camera, ts] = key.split('|') as [string, string];
      if (ts.slice(0, 16) >= cutoff) continue; // minute still open
      const counts: Record<string, number> = {};
      for (const [label, n] of m) { counts[label] = n; store.upsertCameraCount({ ts, camera, label, count: n, model: modelName }); }
      await bus.publish(topics.counts(camera), { ts, camera, model: modelName, counts });
      minute.delete(key);
    }
  };
  const flusher = setInterval(() => void flush(), 15_000);
  const status = setInterval(() => void bus.publish(topics.status('detector'), { ts: new Date().toISOString(), pid: process.pid, model: modelName, compute: COMPUTE, processed, dropped, inflight, rss_mb: Math.round(process.memoryUsage().rss / 1048576) }, { retain: true }), 60_000);

  const shutdown = async () => { clearInterval(flusher); clearInterval(status); await flush(); runner.close(); await bus.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
  await new Promise(() => undefined);
}

main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
