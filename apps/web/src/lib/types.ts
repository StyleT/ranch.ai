// UI contracts: what the BFF returns to the pages (docs/WEB-DASHBOARD.md §3). Everything the client renders is one of these.
import type { Detection } from '@ranch/contracts';

export type Alert = { kind: 'camera_offline' | 'daemon_down' | 'detector_stale' | 'taxonomy_drift' | 'disk_low' | 'burst_throttled' | 'no_frames'; text: string; href: string; severity: 'warn' | 'bad' };

export type DaemonView = { name: string; label: string; up: boolean; pid: number | null; last_exit: number; rss_mb: number | null; log: string; status: Record<string, unknown> | null };

export type CameraCard = {
  name: string; online: boolean; last_frame_ts: string | null; last_frame_age_s: number | null; frames_per_min: number;
  equine_now: number | null; equine_spark: (number | null)[]; thumb: string; thumb_version: string;
  detections_1h: { label: string; n: number; conf: number; raw: Record<string, number> }[];
  model: string | null; fw: string | null; ip: string | null; width: number | null; height: number | null; excluded_from_keepalive: boolean;
};

export type ActivityItem = { t: string; camera: string; label: string; moving: boolean; members: number; seen: number; conf: number; frame_id: number; img: string };

export type HomeData = {
  ts: string;
  health: { host: string; uptime_s: number; load: number[]; disk: { free_gb: number | null; total_gb: number | null }; daemons: DaemonView[]; daemons_up: number; daemons_total: number;
    taxonomy: { version: number | null; matches_repo: boolean }; detector: { model: string | null; family: string | null } };
  alerts: Alert[];
  cameras: CameraCard[];
  activity: ActivityItem[];
  labels_1h: { label: string; n: number; conf: number }[];
  label_order: string[];
  horse_label: string;
  totals: { frames: number; detections: number; events: number };
  events: { id: string; ts: string; camera: string; type: string; confidence: number; tier_decided: number; verdict: string | null }[];
};

export type SeriesPoint = { t: string; value: number | null };
export type OnlinePoint = { t: string; frames: number };
export type BurstCard = { t: string; frame_id: number; labels: string[]; moving: boolean; members: number; img: string };

export type CameraDetail = {
  camera: CameraCard;
  window: { since: string; until: string; bucket_s: number; label: '1h' | '6h' | '24h' | '7d' };
  equine_series: SeriesPoint[];
  online_series: OnlinePoint[];
  bursts: BurstCard[];
  net: Record<string, unknown> | null;
  motion: { n: number; p50: number; p90: number; max: number } | null;
  stream: { fmt_default: 'mp4' | 'mjpeg'; excluded: boolean };
};

export type Box = { label: string; raw_label: string | null; confidence: number; x: number; y: number; w: number; h: number; seen: number | null; dx: number | null; dy: number | null; gold: boolean };
export type FrameCard = { id: number; camera: string; ts: string; reason: string; change: number | null; img: string; width: number | null; height: number | null; detections: Box[]; burst: FrameCard[]; period?: string };
export type DetectionsPage = { source: 'live' | 'baseline'; items: FrameCard[]; next_before: number | null; total: number | null };

export type SystemData = {
  ts: string; host: string; uptime_s: number; load: number[]; disk: { free_gb: number | null; total_gb: number | null };
  totals: { frames: number; detections: number; events: number }; seed: { total: number; window_start: string | null; window_hours: number | null };
  daemons: DaemonView[]; netprobe: { camera: string; ip: string | null; producer: boolean | null; consumers: number | null; rx_bytes_delta: number | null; ping_ms: number | null }[];
  wifi: Record<string, unknown> | null; web: { rss_mb: number; heap_mb: number; uptime_s: number; build: Record<string, unknown> | null }; daemon_ping: Record<string, unknown> | null;
};

export type LeaderboardRow = { date: string; tag: string; model: string; frames: string; labels: string; r_at_fppf: string; horse_recall: string; ap: string; fppf_all: string; count_exact: string; p50_ms: string; rss_mb: string; result: string; prod: boolean };
export type EvalsData = { rows: LeaderboardRow[]; files: { file: string; ts: string | null; tag: string | null; models: string[] }[]; datasets: { id: string; kind: string; created: string; n: string; parent: string; location: string }[]; notes: string };

export type HealthData = { ok: boolean; web: { rss_mb: number; heap_mb: number; uptime_s: number; pid: number; build: Record<string, unknown> | null }; daemon: Record<string, unknown> | { error: string } };

export type { Detection };
