import { Status, Tracks, CountSeries } from '@ranch/contracts';
import type { HomeData, CameraCard, DaemonView, ActivityItem } from '@/lib/types';
import { deriveAlerts } from '@/lib/alerts/derive';
import { daemonJson, cached } from './daemon.ts';

export const getStatus = () => cached('status', 3000, () => daemonJson(Status, '/api/status', { timeoutMs: 8000 }));

export function daemonViews(status: Status): DaemonView[] {
  return status.daemons.map((d) => ({ name: d.label.replace('com.ranch.', ''), label: d.label, up: d.pid !== null, pid: d.pid, last_exit: d.last_exit, rss_mb: d.rss_mb ?? null, log: d.log, status: d.status ?? null }));
}

export function cameraCards(status: Status, spark: Map<string, (number | null)[]>): CameraCard[] {
  const byCam = new Map<string, CameraCard['detections_1h']>();
  for (const r of status.labels_by_camera_1h) (byCam.get(r.camera) ?? byCam.set(r.camera, []).get(r.camera)!).push({ label: r.label, n: r.n, conf: r.conf, raw: r.raw });
  return status.cameras.map((c) => ({
    name: c.name, online: c.online, last_frame_ts: c.last_frame_ts, last_frame_age_s: c.last_frame_age_s, frames_per_min: +(c.frames_10m / 10).toFixed(1),
    equine_now: c.horse_last_min, equine_spark: spark.get(c.name) ?? [], thumb: `/api/ui/frame/${encodeURIComponent(c.name)}`, thumb_version: c.last_frame_ts ?? '',
    detections_1h: (byCam.get(c.name) ?? []).sort((a, b) => b.n - a.n), model: c.model, fw: c.fw, ip: c.ip, width: c.width ?? null, height: c.height ?? null,
    buffer_frames: c.buffer_frames, buffer_age_s: c.buffer_age_s ?? null,
    connected: c.connected ?? null, state: c.state ?? 'unknown',
  }));
}

export async function getHome(): Promise<HomeData> {
  const status = await getStatus();
  const [tracks, series] = await Promise.all([
    cached('tracks:1h', 3000, () => daemonJson(Tracks, '/api/tracks?since=1h&limit=30')).catch(() => []),
    cached(`counts:1h:${status.horse_label === 'equine' ? 'horse' : status.horse_label}`, 10_000, () => daemonJson(CountSeries, `/api/counts/series?since=1h&bucket=5m&label=horse`)).catch(() => []),
  ]);
  const spark = new Map<string, (number | null)[]>();
  const now = Date.now(); const start = Math.floor((now - 3600e3) / 300e3) * 300e3;
  for (const s of series) { const pts: (number | null)[] = Array.from({ length: 12 }, () => null); for (const p of s.points) { const i = Math.floor((Date.parse(p.ts) - start) / 300e3); if (i >= 0 && i < 12) pts[i] = p.max; } spark.set(s.camera, pts); }
  const daemons = daemonViews(status);
  const det = status.daemons.find((d) => d.label === 'com.ranch.detector')?.status as { model?: string; family?: string } | undefined;
  const cameras = cameraCards(status, spark);
  const activity: ActivityItem[] = tracks.map((t) => ({ t: t.ts, camera: t.camera, label: t.label, moving: t.moving, members: t.members, seen: t.seen, conf: t.conf, frame_id: t.frame_id, img: `/api/ui/frame/${t.frame_id}` }));
  const health: HomeData['health'] = {
    host: status.host, uptime_s: status.uptime_s, load: status.load, disk: { free_gb: status.disk_free_gb, total_gb: status.disk_total_gb }, daemons,
    daemons_up: daemons.filter((d) => d.up).length, daemons_total: daemons.length,
    taxonomy: { version: status.taxonomy_version, matches_repo: status.taxonomy_matches_repo }, detector: { model: det?.model ?? null, family: det?.family ?? null },
  };
  return {
    ts: status.ts, health, alerts: deriveAlerts({ status, cameras, daemons, now: new Date(status.ts) }), cameras, activity, labels_1h: status.labels_1h, label_order: status.label_order,
    horse_label: status.horse_label, totals: status.totals,
    events: status.events.map((e) => ({ id: e.id, ts: e.ts, camera: e.camera, type: e.type, confidence: e.confidence, tier_decided: e.tier_decided, verdict: e.verdict })),
  };
}
