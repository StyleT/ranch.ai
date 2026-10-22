// Tier 1: runs the Core ML detector on every frame the sampler keeps. Subscribes to ranch/frames/+, feeds
// the native runner, stores detections, publishes ranch/detections/<camera>, and once a minute publishes
// per-camera label counts (max seen in that minute) to ranch/counts/<camera> and camera_counts.
import { basename } from 'node:path';
import { config } from '@ranch/config';
import { EventStore } from '@ranch/events';
import { connectBus, topics } from '@ranch/bus';
import { Runner } from './runner.ts';
import { mapDetection, interestLabels } from '@ranch/taxonomy';

const MODEL = process.env.RANCH_DETECTOR_MODEL ?? '/usr/local/ranch/models/yolo11n.mlpackage';
const COMPUTE = (process.env.RANCH_DETECTOR_COMPUTE ?? 'ane') as 'all' | 'ane' | 'gpu' | 'cpu';
// The runner returns every class at RANCH_DETECTOR_THRESHOLD (a floor); the taxonomy mapping decides what is kept,
// under which label, at which per-label threshold (docs/TAXONOMY.md). RANCH_DETECTOR_FAMILY names the mapping.
const THRESHOLD = Number(process.env.RANCH_DETECTOR_THRESHOLD ?? 0.05);
const FAMILY = process.env.RANCH_DETECTOR_FAMILY ?? 'coco';
const COUNT_LABELS = interestLabels(FAMILY);
const MAX_QUEUE = 50;
const modelName = basename(MODEL).replace(/\.(mlpackage|mlmodelc)$/, '');

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'detector', msg, ...extra }) + '\n');

interface FrameMsg { id: number; ts: string; camera: string; path: string }

async function main(): Promise<void> {
  const store = new EventStore(config.dbPath);
  const runner = new Runner({ model: MODEL, compute: COMPUTE, threshold: THRESHOLD });
  const info = await runner.info;
  log('runner ready', { ...info, family: FAMILY, count_labels: COUNT_LABELS });
  const bus = await connectBus('detector');

  // per minute, per camera: max count per label
  const minute = new Map<string, Map<string, number>>(); // key `${camera}|${minuteTs}`
  let inflight = 0; let dropped = 0; let processed = 0; let rawBoxes = 0; let keptBoxes = 0;

  await bus.subscribe('ranch/frames/+', (_t, payload) => {
    const f = payload as FrameMsg;
    if (inflight >= MAX_QUEUE) { dropped++; if (dropped % 50 === 1) log('queue full, dropping frames', { dropped }); return; }
    inflight++;
    void runner.detect(f.path).then(async (r) => {
      inflight--; processed++; rawBoxes += r.detections.length;
      const kept = r.detections.flatMap((d) => { const m = mapDetection(FAMILY, d.label, d.confidence); return m ? [{ ...d, label: m.label, raw_label: d.label, subclass: m.subclass, class: m.class }] : []; });
      keptBoxes += kept.length;
      store.insertDetections(f.id, kept.map((d) => ({ model: modelName, label: d.label, raw_label: d.raw_label, confidence: d.confidence, x: d.x, y: d.y, w: d.w, h: d.h, latency_ms: r.ms })));
      await bus.publish(topics.detections(f.camera), { ts: f.ts, camera: f.camera, frame_id: f.id, path: f.path, model: modelName, family: FAMILY, ms: r.ms, detections: kept, raw_boxes: r.detections.length });
      const key = `${f.camera}|${f.ts.slice(0, 16)}:00.000Z`;
      const m = minute.get(key) ?? new Map<string, number>();
      for (const label of COUNT_LABELS) m.set(label, Math.max(m.get(label) ?? 0, kept.filter((d) => d.label === label).length));
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
  const status = setInterval(() => void bus.publish(topics.status('detector'), { ts: new Date().toISOString(), pid: process.pid, model: modelName, family: FAMILY, compute: COMPUTE, processed, dropped, inflight, raw_boxes: rawBoxes, kept_boxes: keptBoxes, rss_mb: Math.round(process.memoryUsage().rss / 1048576) }, { retain: true }), 60_000);

  const shutdown = async () => { clearInterval(flusher); clearInterval(status); await flush(); runner.close(); await bus.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
  await new Promise(() => undefined);
}

main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
