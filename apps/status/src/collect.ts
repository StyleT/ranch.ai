// Builds the one JSON document the status page renders. Everything is read from what the pipeline already
// produces: SQLite, launchd, the daemon logs, the recorder buffer, df, the bridge API and retained MQTT status.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, loadavg, uptime } from 'node:os';
import { config } from '@ranch/config';
import { getTaxonomy, getTaxonomyVersionId, horseIsEquine, loadTaxonomyFile, REPO_TAXONOMY_FILE } from '@ranch/taxonomy';
import { differsFromRepo } from '@ranch/taxonomy/store';
import type { Status as StatusContract } from '@ranch/contracts';
const repoTaxonomy = loadTaxonomyFile(REPO_TAXONOMY_FILE);
import type { EventStore, RanchEvent } from '@ranch/events';

const exec = promisify(execFile);

export type DaemonRow = { label: string; pid: number | null; last_exit: number; rss_mb: number | null; log: string; status?: Record<string, unknown> | undefined }
export type CameraRow = {
  name: string; online: boolean; last_frame_ts: string | null; last_frame_age_s: number | null; frames_10m: number; width: number | null; height: number | null;
  horse_last_min: number | null; model: string | null; fw: string | null; ip: string | null; buffer_frames: number; buffer_age_s: number | null;
  live_age_s: number | null;   // seconds since the recorder last rewrote this camera's HLS playlist (null = no HLS output yet)
  connected: boolean | null;   // netprobe: go2rtc holds a live session with the camera (null = no probe yet)
  state: 'connected' | 'degraded' | 'down' | 'unknown';   // connected + frames flowing | connected but no frames for 10 s | no session | unknown
}
export type Status = {
  ts: string; host: string; uptime_s: number; load: number[]; disk_free_gb: number | null; disk_total_gb: number | null;
  buffer: { total: number; stale_s: number };   // frames in the recorder's rolling on-disk buffer (docs/CAMERA-ARCHITECTURE.md)
  daemons: DaemonRow[]; cameras: CameraRow[]; labels_1h: { label: string; n: number; conf: number }[];
  labels_by_camera_1h: { camera: string; label: string; n: number; conf: number; raw: Record<string, number> }[];
  label_order: string[]; taxonomy_version: number | null; taxonomy_matches_repo: boolean; horse_label: string;
  events: RanchEvent[]; totals: { frames: number; detections: number; events: number };
}

/** Last unified-log line per daemon. Daemon output goes through `logger -t ranch.<name>`; the tag is not stored,
 *  so lines are attributed by the logger process pid (ps shows the tag in its args). Cached for 30 s: `log show`
 *  costs ~0.7 s. */
let logCache: { at: number; lines: Map<string, string> } = { at: 0, lines: new Map() };
async function lastLogLines(): Promise<Map<string, string>> {
  if (Date.now() - logCache.at < 30_000) return logCache.lines;
  const lines = new Map<string, string>();
  try {
    const { stdout: ps } = await exec('/bin/ps', ['-axo', 'pid=,args='], { timeout: 5000 });
    const pidToName = new Map<number, string>();
    for (const l of ps.split('\n')) { const m = /^\s*(\d+)\s+\/usr\/bin\/logger -t ranch\.(\S+)/.exec(l); if (m) pidToName.set(Number(m[1]), m[2]!); }
    // compact style carries the pid as `logger[<pid>:<tid>]`; the json style leaves processIdentifier null.
    const { stdout } = await exec('/usr/bin/sudo', ['-n', '/usr/bin/log', 'show', '--last', '5m', '--predicate', 'process == "logger"', '--style', 'compact'], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
    for (const l of stdout.split('\n')) {
      const m = /^\S+ \S+ \S+ logger\[(\d+):[0-9a-f]+\] (.*)$/.exec(l);
      if (!m) continue;
      const name = pidToName.get(Number(m[1]));
      if (name) lines.set(name, m[2]!.slice(0, 300)); // chronological; last wins
    }
  } catch { /* keep the previous cache */ return logCache.lines; }
  logCache = { at: Date.now(), lines };
  return lines;
}

/** launchctl list for com.ranch.* plus each pid's RSS from ps (the measurement for every daemon, web and bridge included). */
async function launchd(): Promise<{ label: string; pid: number | null; last_exit: number; rss_mb: number | null }[]> {
  try {
    // launchd holds the bash wrapper's pid; the daemon's node process and its logger are in that process group, so
    // the RSS of a daemon is the sum over its group.
    const [{ stdout }, ps] = await Promise.all([exec('sudo', ['-n', 'launchctl', 'list'], { timeout: 5000 }), exec('/bin/ps', ['-axo', 'pgid=,rss='], { timeout: 5000 }).catch(() => ({ stdout: '' }))]);
    const rss = new Map<number, number>();
    for (const l of ps.stdout.split('\n')) { const m = /^\s*(\d+)\s+(\d+)/.exec(l); if (m) rss.set(Number(m[1]), (rss.get(Number(m[1])) ?? 0) + Number(m[2])); }
    return stdout.split('\n').filter((l) => l.includes('com.ranch.')).map((l) => {
      const [pid, exit, label] = l.trim().split(/\s+/);
      const p = pid === '-' ? null : Number(pid);
      return { label: label ?? '', pid: p, last_exit: Number(exit ?? 0), rss_mb: p === null || !rss.has(p) ? null : Math.round(rss.get(p)! / 1024) };
    }).sort((a, b) => a.label.localeCompare(b.label));
  } catch { return []; }
}

async function disk(): Promise<{ free: number | null; total: number | null }> {
  try {
    const { stdout } = await exec('df', ['-g', '/'], { timeout: 5000 });
    const f = stdout.trim().split('\n').pop()?.trim().split(/\s+/) ?? [];
    return { total: Number(f[1]) || null, free: Number(f[3]) || null };
  } catch { return { free: null, total: null }; }
}

let bridgeCache: { at: number; cams: Record<string, { model: string; fw: string; ip: string }> } = { at: 0, cams: {} };
async function bridgeCameras(): Promise<typeof bridgeCache.cams> {
  if (Date.now() - bridgeCache.at < 60_000) return bridgeCache.cams;
  try {
    const res = await fetch(`${config.bridgeUrl}/api/cameras`, { signal: AbortSignal.timeout(3000) });
    const list = (await res.json()) as { name: string; model_name: string; fw_version: string; ip: string }[];
    bridgeCache = { at: Date.now(), cams: Object.fromEntries(list.map((c) => [c.name, { model: c.model_name, fw: c.fw_version, ip: c.ip }])) };
  } catch { bridgeCache.at = Date.now() - 30_000; }
  return bridgeCache.cams;
}

/** The bridge's own metrics (`/api/metrics`: bridge state, per-camera state, Wyze API call counters), proxied for the
 *  dashboard's /system page because 5080 is loopback-only since 23 Oct. Shared in-flight promise, 10 s cache. */
let bridgeMetricsCache: { at: number; value: Promise<unknown> } | undefined;
export function bridgeMetrics(): Promise<unknown> {
  if (!bridgeMetricsCache || Date.now() - bridgeMetricsCache.at > 10_000) {
    const value = (async () => {
      const res = await fetch(`${config.bridgeUrl}/api/metrics`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`bridge /api/metrics ${res.status}`);
      return (await res.json()) as unknown;
    })();
    value.catch(() => { bridgeMetricsCache = undefined; });
    bridgeMetricsCache = { at: Date.now(), value };
  }
  return bridgeMetricsCache.value;
}

/** The recorder's rolling buffer per camera: file count and the age of the newest frame. A camera is online when
 *  that age is under STALE_S (docs/CAMERA-ARCHITECTURE.md); the buffer, not a camera, is what everything reads. */
export const STALE_S = Number(process.env.RANCH_STALE_S ?? 30);
export function bufferState(): Record<string, { frames: number; newest: string | null; ageS: number | null }> {
  const out: Record<string, { frames: number; newest: string | null; ageS: number | null }> = {};
  try {
    for (const c of readdirSync(config.bufferDir)) {
      try { const files = readdirSync(join(config.bufferDir, c)).filter((f) => f.endsWith('.jpg')).sort(); const newest = files[files.length - 1] ?? null;
        out[c] = { frames: files.length, newest, ageS: newest ? (Date.now() - bufferNameMs(newest)) / 1000 : null }; } catch { out[c] = { frames: 0, newest: null, ageS: null }; }
    }
  } catch { /* no buffer dir */ }
  return out;
}
/** The recorder's HLS output per camera: seconds since `index.m3u8` was last rewritten (ffmpeg rewrites it on every
 *  new segment, so a fresh playlist means frames are flowing; docs/WEB-DASHBOARD.md). */
export function liveState(): Record<string, { ageS: number | null }> {
  const out: Record<string, { ageS: number | null }> = {};
  try {
    for (const c of readdirSync(config.liveDir)) {
      try { out[c] = { ageS: Math.max(0, (Date.now() - statSync(join(config.liveDir, c, 'index.m3u8')).mtimeMs) / 1000) }; } catch { out[c] = { ageS: null }; }
    }
  } catch { /* no live dir */ }
  return out;
}
/** Buffer file names are UTC `YYYY-MM-DDTHH-MM-SSZ.jpg`. */
export const bufferNameMs = (name: string): number => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(name); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : NaN; };
export const bufferNewestPath = (camera: string): string | null => { const b = bufferState()[camera]; return b?.newest ? join(config.bufferDir, camera, b.newest) : null; };
/** The newest `n` complete-looking buffer files of a camera, newest first (readers fall back to the previous frame when
 *  the newest fails to decode). Only `<UTC ts>Z.jpg` names: ffmpeg's atomic temp files are `*.jpg.tmp`. */
export function bufferNewestPaths(camera: string, n = 2): string[] {
  try { return readdirSync(join(config.bufferDir, camera)).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jpg$/.test(f)).sort().slice(-n).reverse().map((f) => join(config.bufferDir, camera, f)); } catch { return []; }
}

export async function collect(store: EventStore, mqttStatus: Map<string, Record<string, unknown>>): Promise<Status> {
  return collectStatus(store, mqttStatus) satisfies Promise<StatusContract>;
}

async function collectStatus(store: EventStore, mqttStatus: Map<string, Record<string, unknown>>): Promise<Status> {
  const now = new Date();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const [daemons, df, bridge, logLines] = await Promise.all([launchd(), disk(), bridgeCameras(), lastLogLines()]);
  const buffer = bufferState(); const live = liveState();
  const probe = (mqttStatus.get('netprobe') ?? {}) as Record<string, { connected?: boolean | null } | unknown>;
  const db = store.db;
  const camNames = new Set<string>([
    ...Object.keys(bridge).filter((n) => !config.camerasExclude.includes(n)),
    ...Object.keys(buffer),
    ...(db.prepare('SELECT DISTINCT camera FROM frames').all() as { camera: string }[]).map((r) => r.camera),
  ]);
  const per10m = new Map((db.prepare('SELECT camera, COUNT(*) n FROM frames WHERE ts >= ? GROUP BY camera').all(iso(600e3)) as { camera: string; n: number }[]).map((r) => [r.camera, r.n]));
  const horse = new Map((db.prepare(`SELECT camera, count FROM camera_counts WHERE label = 'horse' AND ts >= ? ORDER BY ts`).all(iso(180e3)) as { camera: string; count: number }[]).map((r) => [r.camera, r.count]));
  const cameras: CameraRow[] = [...camNames].sort().map((name) => {
    const last = store.lastFrame(name);
    const age = last ? (now.getTime() - new Date(last.ts).getTime()) / 1000 : null;
    const b = bridge[name]; const buf = buffer[name];
    const bufAge = buf?.ageS !== null && buf?.ageS !== undefined && Number.isFinite(buf.ageS) ? buf.ageS : null;
    const liveAge = live[name]?.ageS === null || live[name]?.ageS === undefined ? null : Math.round(live[name]!.ageS!);
    const pr = probe[name] as { connected?: boolean | null } | undefined; const connected = typeof pr?.connected === 'boolean' ? pr.connected : null;
    // online = the recorder has a fresh buffered frame; a kept frame in the last minute is the fallback when no buffer exists
    const online = bufAge !== null ? bufAge < STALE_S : age !== null && age < 60;
    return { name, online, last_frame_ts: last?.ts ?? null, last_frame_age_s: age === null ? null : Math.round(age), width: last?.width ?? null, height: last?.height ?? null,
      frames_10m: per10m.get(name) ?? 0, horse_last_min: horse.get(name) ?? null, model: b?.model ?? null, fw: b?.fw ?? null, ip: b?.ip ?? null, buffer_frames: buf?.frames ?? 0, buffer_age_s: bufAge === null ? null : Math.round(bufAge), live_age_s: liveAge, connected, state: connected === null ? 'unknown' : !connected ? 'down' : liveAge !== null && liveAge < 10 ? 'connected' : 'degraded' };
  });
  const labels = db.prepare(`SELECT d.label, COUNT(*) n, ROUND(AVG(d.confidence), 2) conf FROM detections d JOIN frames f ON f.id = d.frame_id
    WHERE f.ts >= ? GROUP BY d.label ORDER BY n DESC LIMIT 12`).all(iso(3600e3)) as { label: string; n: number; conf: number }[];
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  return {
    ts: now.toISOString(), host: hostname(), uptime_s: Math.round(uptime()), load: loadavg().map((v) => Math.round(v * 100) / 100),
    disk_free_gb: df.free, disk_total_gb: df.total,
    buffer: { total: Object.values(buffer).reduce((s, v) => s + v.frames, 0), stale_s: STALE_S },
    daemons: daemons.map((d) => ({ ...d, log: logLines.get(d.label.replace('com.ranch.', '')) ?? '', status: mqttStatus.get(d.label.replace('com.ranch.', '')) })),
    cameras, labels_1h: labels, labels_by_camera_1h: store.detectionsByCamera(iso(3600e3)), label_order: [...getTaxonomy().label_order], taxonomy_version: getTaxonomyVersionId(), taxonomy_matches_repo: !differsFromRepo(repoTaxonomy, store.activeTaxonomy()), horse_label: horseIsEquine(String(mqttStatus.get('detector')?.family ?? 'coco')) ? 'equine' : 'horse', events: store.events({ limit: 10 }), totals: { frames: n('frames'), detections: n('detections'), events: n('events') },
  };
}
