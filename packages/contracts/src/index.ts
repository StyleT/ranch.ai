// The daemon's HTTP contract (docs/WEB-DASHBOARD.md): zod schemas for every apps/status response the web BFF, the
// fixtures recorder, the contract test and the AI e2e oracles consume. The daemon writes `satisfies` against the
// inferred types so producer and consumer cannot drift. Objects are loose (unknown keys pass) so a new daemon field
// never breaks the UI; the contract test tightens where exactness matters.
import { z } from 'zod';

const Iso = z.string().min(20);
const NullableNum = z.number().nullable();

export const DaemonRow = z.looseObject({
  label: z.string(), pid: NullableNum, last_exit: z.number(), log: z.string(), rss_mb: NullableNum.optional(),
  status: z.record(z.string(), z.unknown()).optional(),
});
export const CameraRow = z.looseObject({
  name: z.string(), online: z.boolean(), last_frame_ts: Iso.nullable(), last_frame_age_s: NullableNum, frames_10m: z.number(),
  horse_last_min: NullableNum, model: z.string().nullable(), fw: z.string().nullable(), ip: z.string().nullable(), buffer_frames: z.number(), buffer_age_s: NullableNum.optional(),
  width: NullableNum.optional(), height: NullableNum.optional(),
});
export const RanchEvent = z.looseObject({
  id: z.string(), ts: Iso, camera: z.string(), type: z.string(), confidence: z.number(), tier_decided: z.number(),
  verdict: z.string().nullable(), created_at: Iso,
});
export const Status = z.looseObject({
  ts: Iso, host: z.string(), uptime_s: z.number(), load: z.array(z.number()), disk_free_gb: NullableNum, disk_total_gb: NullableNum,
  buffer: z.looseObject({ total: z.number(), stale_s: z.number().optional() }),
  daemons: z.array(DaemonRow), cameras: z.array(CameraRow),
  labels_1h: z.array(z.looseObject({ label: z.string(), n: z.number(), conf: z.number() })),
  labels_by_camera_1h: z.array(z.looseObject({ camera: z.string(), label: z.string(), n: z.number(), conf: z.number(), raw: z.record(z.string(), z.number()) })),
  label_order: z.array(z.string()), taxonomy_version: NullableNum, taxonomy_matches_repo: z.boolean(), horse_label: z.string(),
  events: z.array(RanchEvent), totals: z.looseObject({ frames: z.number(), detections: z.number(), events: z.number() }),
});

export const Detection = z.looseObject({
  id: z.number(), frame_id: z.number(), model: z.string(), label: z.string(), confidence: z.number(),
  x: z.number(), y: z.number(), w: z.number(), h: z.number(), latency_ms: NullableNum, raw_label: z.string().nullable(),
  track: NullableNum, seen: NullableNum, dx: NullableNum, dy: NullableNum,
});
export const Frame = z.looseObject({
  id: z.number(), ts: Iso, camera: z.string(), path: z.string(), width: NullableNum, height: NullableNum, bytes: NullableNum,
  change: NullableNum, reason: z.string(), kept: NullableNum, burst_id: NullableNum, seq: NullableNum,
});
export const FrameWithDetections = Frame.extend({ detections: z.array(Detection) });
export const FrameHead = FrameWithDetections.extend({ burst: z.array(FrameWithDetections) });
export const FramesResponse = z.array(FrameHead);

export const BaselineSet = z.looseObject({ date: z.string(), n: z.number(), models: z.array(z.string()) });
export const BaselineFrame = z.looseObject({
  id: z.number(), camera: z.string(), ts: Iso, reason: z.string(), period: z.string(), change: z.null(),
  baseline: z.looseObject({ date: z.string(), file: z.string() }), img: z.string(),
  detections: z.array(z.looseObject({ label: z.string(), confidence: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), model: z.string() })),
});

export const Ping = z.looseObject({ ok: z.literal(true), ts: Iso, pid: z.number(), rss_mb: z.number(), taxonomy_version: NullableNum, api: z.number() });

export const CountSeries = z.array(z.looseObject({
  camera: z.string(), label: z.string(), bucket_s: z.number(),
  points: z.array(z.looseObject({ ts: Iso, max: z.number(), mean: z.number(), n: z.number() })),
}));
export const FrameSeries = z.array(z.looseObject({
  camera: z.string(), bucket_s: z.number(), points: z.array(z.looseObject({ ts: Iso, frames: z.number(), last: Iso })),
}));
export const TrackSummary = z.looseObject({
  frame_id: z.number(), camera: z.string(), ts: Iso, burst_id: NullableNum, label: z.string(), tracks: z.number(), boxes: z.number(),
  seen: z.number(), disp2: z.number(), conf: z.number(), members: z.number(), moving: z.boolean(), img: z.string(),
});
export const Tracks = z.array(TrackSummary);

// ---- taxonomy
export const ScoreSummary = z.looseObject({
  horse_recall: z.number(), horse_ci: z.looseObject({ lo: z.number(), hi: z.number() }).nullable(), horse_ap: z.number(), horse_precision: z.number(),
  fppf_all: z.number(), count_exact: z.number(), day_recall: NullableNum, night_recall: NullableNum,
  classes: z.record(z.string(), z.looseObject({ gold: z.number(), precision: z.number(), recall: z.number() })),
});
export const Gate = z.looseObject({ pass: z.boolean(), reasons: z.array(z.string()) });
export const ScoreResponse = z.looseObject({
  model: z.string(), frames_dataset: z.string(), labels_dataset: z.string(), active_version: NullableNum,
  active: ScoreSummary, draft: ScoreSummary, gate: Gate, ms: z.number(), draft_taxonomy: z.record(z.string(), z.unknown()),
});
export const TaxonomyVersionItem = z.looseObject({
  id: z.number(), created: Iso, author: z.string(), note: z.string().nullable(), parent_id: NullableNum, gate: z.string().nullable(),
  active: z.number(), score_summary: ScoreSummary.nullable(),
});
export const TaxonomyMeta = z.looseObject({
  active: z.looseObject({ id: z.number(), created: Iso, author: z.string(), note: z.string().nullable(), gate: z.string().nullable(), parent_id: NullableNum }),
  matches_repo: z.boolean(), detector_model: z.string(), detector_family: z.string(),
  reference: z.looseObject({ frames: z.string(), labels: z.string() }), write_enabled: z.boolean(),
  versions: z.array(TaxonomyVersionItem), taxonomy: z.record(z.string(), z.unknown()),
});
export const TaxonomyVersionFull = TaxonomyVersionItem.omit({ score_summary: true }).extend({ taxonomy: z.record(z.string(), z.unknown()), score: z.unknown().nullable() });
export const ValidateResponse = z.union([z.looseObject({ ok: z.literal(true) }), z.looseObject({ errors: z.array(z.string()) })]);
export const ApplyResponse = z.looseObject({ ok: z.literal(true), id: z.number() });
export const ErrorResponse = z.looseObject({ error: z.string().optional(), errors: z.array(z.string()).optional() });

// ---- SSE payloads on /api/events
export const SseMqtt = z.looseObject({ topic: z.string(), payload: z.unknown() });
export const TaxonomyMessage = z.looseObject({ version_id: z.number(), created: Iso, author: z.string() });
export const DetectorStatus = z.looseObject({ ts: Iso, pid: z.number(), model: z.string(), family: z.string(), taxonomy_version: NullableNum, processed: z.number(), dropped: z.number(), inflight: z.number(), raw_boxes: z.number(), kept_boxes: z.number(), bursts: z.number(), rss_mb: z.number() });
export const IngestStatus = z.looseObject({ ts: Iso, pid: z.number(), cameras: z.array(z.string()), rss_mb: z.number(), resets: z.number(), bursts: z.number(), burst_frames: z.number(), burst_throttled: z.number(), burst_budget_per_min: z.number(), motion_threshold: z.number().optional(), motion: z.record(z.string(), z.looseObject({ n: z.number(), p50: z.number(), p90: z.number(), max: z.number() })).optional() });
// `producer` = go2rtc has the source configured (true even for a dead camera); `connected` = the producer has a remote
// address, i.e. a live camera session (23 Oct: the hourly table showed producer 240/240 for a camera that was off).
export const NetprobeCamera = z.looseObject({ camera: z.string(), ip: z.string().nullable().optional(), producer: z.boolean().nullable().optional(), connected: z.boolean().nullable().optional(), state: z.string().nullable().optional(), consumers: z.number().nullable().optional(), rx_bytes_delta: NullableNum.optional(), ping_ms: NullableNum.optional() });
/** The Wyze bridge's own metrics (`GET :5080/api/metrics`), proxied by the daemon at /api/bridge because 5080 is
 *  loopback-only since 23 Oct (its UI attached eight go2rtc consumers per visit). Shape as observed on 4.5.0. */
export const BridgeMetrics = z.looseObject({
  bridge: z.looseObject({ version: z.string(), uptime_s: z.number(), started_at: z.string(), camera_count: z.number(), streaming_count: z.number(), error_count: z.number(), sse_clients: z.number() }),
  cameras: z.array(z.looseObject({ name: z.string(), nickname: z.string().optional(), model: z.string().optional(), model_name: z.string().optional(), protocol: z.string().optional(), state: z.string(), quality: z.string().optional(), audio: z.boolean().optional(), error_count: z.number().optional(), recording: z.boolean().optional() })),
  wyzeapi: z.array(z.looseObject({ Path: z.string(), Count: z.number(), Errors: z.number(), LastStatus: z.number(), LastLatency: z.number(), TotalNanos: z.number(), FirstCall: z.string(), LastCall: z.string() })).nullable().optional(),
});
export const Wifi = z.looseObject({ rssi_dbm: NullableNum.optional(), noise_dbm: NullableNum.optional(), tx_rate_mbps: NullableNum.optional(), channel: z.unknown().optional(), mcs: z.unknown().optional(), error: z.string().optional() });

export type Status = z.infer<typeof Status>; export type DaemonRow = z.infer<typeof DaemonRow>; export type CameraRow = z.infer<typeof CameraRow>;
export type FrameHead = z.infer<typeof FrameHead>; export type FrameWithDetections = z.infer<typeof FrameWithDetections>; export type Detection = z.infer<typeof Detection>;
export type BaselineSet = z.infer<typeof BaselineSet>; export type BaselineFrame = z.infer<typeof BaselineFrame>; export type Ping = z.infer<typeof Ping>;
export type CountSeries = z.infer<typeof CountSeries>; export type FrameSeries = z.infer<typeof FrameSeries>; export type TrackSummary = z.infer<typeof TrackSummary>;
export type ScoreSummary = z.infer<typeof ScoreSummary>; export type ScoreResponse = z.infer<typeof ScoreResponse>; export type TaxonomyMeta = z.infer<typeof TaxonomyMeta>;
export type TaxonomyVersionItem = z.infer<typeof TaxonomyVersionItem>; export type TaxonomyVersionFull = z.infer<typeof TaxonomyVersionFull>;
export type DetectorStatus = z.infer<typeof DetectorStatus>; export type IngestStatus = z.infer<typeof IngestStatus>; export type NetprobeCamera = z.infer<typeof NetprobeCamera>; export type Wifi = z.infer<typeof Wifi>;
export type BridgeMetrics = z.infer<typeof BridgeMetrics>;

/** Parse or throw with a readable issue list (used at the BFF boundary and by the contract test). */
export function parseContract<T extends z.ZodType>(schema: T, data: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new Error(`${what}: contract violation: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
}
