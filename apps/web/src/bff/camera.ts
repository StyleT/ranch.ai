import { CountSeries, FrameSeries, Tracks } from '@ranch/contracts';
import type { CameraDetail, SeriesPoint, OnlinePoint, BurstCard } from '@/lib/types';
import { daemonJson, cached, UpstreamError } from './daemon.ts';
import { getStatus, cameraCards } from './home.ts';

export type Window = '1h' | '6h' | '24h' | '7d';
export const WINDOWS: Record<Window, { ms: number; bucketS: number; bucket: string }> = {
  '1h': { ms: 3600e3, bucketS: 60, bucket: '1m' }, '6h': { ms: 6 * 3600e3, bucketS: 300, bucket: '5m' }, '24h': { ms: 86400e3, bucketS: 900, bucket: '15m' }, '7d': { ms: 7 * 86400e3, bucketS: 3600, bucket: '1h' },
};
export const parseWindow = (w: string | null): Window => (w === '6h' || w === '24h' || w === '7d' ? w : '1h');

/** Exactly window/bucket buckets ending in the bucket that contains `until`, nulls where no data exists. */
export function gapFill(points: { ts: string; value: number }[], sinceMs: number, untilMs: number, bucketS: number): SeriesPoint[] {
  const b = bucketS * 1000; const n = Math.max(1, Math.round((untilMs - sinceMs) / b)); const last = Math.floor((untilMs - 1) / b) * b; const start = last - (n - 1) * b;
  const byT = new Map(points.map((p) => [Math.floor(Date.parse(p.ts) / b) * b, p.value]));
  return Array.from({ length: n }, (_, i) => { const t = start + i * b; return { t: new Date(t).toISOString(), value: byT.get(t) ?? null }; });
}

export async function getCamera(name: string, window: Window): Promise<CameraDetail> {
  const status = await getStatus();
  const card = cameraCards(status, new Map()).find((c) => c.name === name);
  if (!card) throw new UpstreamError(404, 'not_found', `no camera ${name}`);
  const w = WINDOWS[window]; const until = Date.now(); const since = until - w.ms; const sinceIso = new Date(since).toISOString();
  const q = `camera=${encodeURIComponent(name)}&since=${encodeURIComponent(sinceIso)}&bucket=${w.bucket}`;
  const [counts, frames, tracks] = await Promise.all([
    cached(`counts:${name}:${window}`, 5000, () => daemonJson(CountSeries, `/api/counts/series?${q}&label=horse`)).catch(() => []),
    cached(`frames-series:${name}:${window}`, 5000, () => daemonJson(FrameSeries, `/api/frames/series?${q}`)).catch(() => []),
    cached(`tracks:${name}:${window}`, 5000, () => daemonJson(Tracks, `/api/tracks?camera=${encodeURIComponent(name)}&since=${encodeURIComponent(sinceIso)}&limit=50`)).catch(() => []),
  ]);
  const equine_series = gapFill((counts[0]?.points ?? []).map((p) => ({ ts: p.ts, value: p.max })), since, until, w.bucketS);
  const online_series: OnlinePoint[] = gapFill((frames[0]?.points ?? []).map((p) => ({ ts: p.ts, value: p.frames })), since, until, w.bucketS).map((p) => ({ t: p.t, frames: p.value ?? 0 }));
  const byHead = new Map<number, BurstCard>();
  for (const t of tracks) { const b = byHead.get(t.frame_id) ?? { t: t.ts, frame_id: t.frame_id, labels: [], moving: false, members: t.members, img: `/api/ui/frame/${t.frame_id}` }; if (!b.labels.includes(t.label)) b.labels.push(t.label); b.moving = b.moving || t.moving; byHead.set(t.frame_id, b); }
  const ingest = status.daemons.find((d) => d.label === 'com.ranch.ingest')?.status as { motion?: Record<string, { n: number; p50: number; p90: number; max: number }> } | undefined;
  const probe = status.daemons.find((d) => d.label === 'com.ranch.netprobe')?.status as Record<string, unknown> | undefined;
  return {
    camera: { ...card, equine_spark: equine_series.slice(-12).map((p) => p.value) },
    window: { since: sinceIso, until: new Date(until).toISOString(), bucket_s: w.bucketS, label: window },
    equine_series, online_series, bursts: [...byHead.values()].slice(0, 20),
    net: (probe?.[name] as Record<string, unknown> | undefined) ?? null, motion: ingest?.motion?.[name] ?? null,
    // the recorder's HLS files via the daemon (docs/WEB-DASHBOARD.md); live_age_s = seconds since the playlist last grew
    stream: { kind: 'hls', playlist: `/api/ui/hls/${encodeURIComponent(name)}/index.m3u8`, live_age_s: (status.cameras.find((c) => c.name === name) as { live_age_s?: number | null } | undefined)?.live_age_s ?? null },
  };
}
