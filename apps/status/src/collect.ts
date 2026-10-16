// Builds the one JSON document the status page renders. Everything is read from what the pipeline already
// produces: SQLite, launchd, the daemon logs, the seed directory, df, the bridge API and retained MQTT status.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, loadavg, uptime } from 'node:os';
import { config } from '@ranch/config';
import type { EventStore, RanchEvent } from '@ranch/events';

const exec = promisify(execFile);

export interface DaemonRow { label: string; pid: number | null; last_exit: number; log: string; status?: Record<string, unknown> | undefined }
export interface CameraRow {
  name: string; online: boolean; last_frame_ts: string | null; last_frame_age_s: number | null; frames_10m: number;
  horse_last_min: number | null; model: string | null; fw: string | null; ip: string | null; seed_frames: number;
}
export interface Status {
  ts: string; host: string; uptime_s: number; load: number[]; disk_free_gb: number | null; disk_total_gb: number | null;
  seed: { total: number; window_start: string | null; window_hours: number | null };
  daemons: DaemonRow[]; cameras: CameraRow[]; labels_1h: { label: string; n: number; conf: number }[];
  events: RanchEvent[]; totals: { frames: number; detections: number; events: number };
}

/** Last non-empty line of a file, reading only its tail. */
function lastLine(path: string): string {
  try {
    const size = statSync(path).size; if (size === 0) return '';
    const fd = openSync(path, 'r'); const len = Math.min(size, 4096); const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len); closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    return (lines[lines.length - 1] ?? '').slice(0, 300);
  } catch { return ''; }
}

async function launchd(): Promise<{ label: string; pid: number | null; last_exit: number }[]> {
  try {
    const { stdout } = await exec('sudo', ['-n', 'launchctl', 'list'], { timeout: 5000 });
    return stdout.split('\n').filter((l) => l.includes('com.ranch.')).map((l) => {
      const [pid, exit, label] = l.trim().split(/\s+/);
      return { label: label ?? '', pid: pid === '-' ? null : Number(pid), last_exit: Number(exit ?? 0) };
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

function seedCounts(): Record<string, number> {
  const dir = join(config.mediaDir, 'seed'); const out: Record<string, number> = {};
  try { for (const c of readdirSync(dir)) { try { out[c] = readdirSync(join(dir, c)).length; } catch { out[c] = 0; } } } catch { /* no seed dir */ }
  return out;
}

export async function collect(store: EventStore, mqttStatus: Map<string, Record<string, unknown>>): Promise<Status> {
  const now = new Date();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const [daemons, df, bridge] = await Promise.all([launchd(), disk(), bridgeCameras()]);
  const seed = seedCounts();
  const db = store.db;
  const camNames = new Set<string>([
    ...Object.keys(bridge).filter((n) => !config.camerasExclude.includes(n)),
    ...(db.prepare('SELECT DISTINCT camera FROM frames').all() as { camera: string }[]).map((r) => r.camera),
  ]);
  const per10m = new Map((db.prepare('SELECT camera, COUNT(*) n FROM frames WHERE ts >= ? GROUP BY camera').all(iso(600e3)) as { camera: string; n: number }[]).map((r) => [r.camera, r.n]));
  const horse = new Map((db.prepare(`SELECT camera, count FROM camera_counts WHERE label = 'horse' AND ts >= ? ORDER BY ts`).all(iso(180e3)) as { camera: string; count: number }[]).map((r) => [r.camera, r.count]));
  const cameras: CameraRow[] = [...camNames].sort().map((name) => {
    const last = store.lastFrame(name);
    const age = last ? (now.getTime() - new Date(last.ts).getTime()) / 1000 : null;
    const b = bridge[name];
    return { name, online: age !== null && age < 60, last_frame_ts: last?.ts ?? null, last_frame_age_s: age === null ? null : Math.round(age),
      frames_10m: per10m.get(name) ?? 0, horse_last_min: horse.get(name) ?? null, model: b?.model ?? null, fw: b?.fw ?? null, ip: b?.ip ?? null, seed_frames: seed[name] ?? 0 };
  });
  const labels = db.prepare(`SELECT d.label, COUNT(*) n, ROUND(AVG(d.confidence), 2) conf FROM detections d JOIN frames f ON f.id = d.frame_id
    WHERE f.ts >= ? GROUP BY d.label ORDER BY n DESC LIMIT 12`).all(iso(3600e3)) as { label: string; n: number; conf: number }[];
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  const seedStart = process.env.SEED_START_EPOCH ? new Date(Number(process.env.SEED_START_EPOCH) * 1000).toISOString() : null;
  return {
    ts: now.toISOString(), host: hostname(), uptime_s: Math.round(uptime()), load: loadavg().map((v) => Math.round(v * 100) / 100),
    disk_free_gb: df.free, disk_total_gb: df.total,
    seed: { total: Object.values(seed).reduce((s, v) => s + v, 0), window_start: seedStart, window_hours: process.env.SEED_HOURS ? Number(process.env.SEED_HOURS) : null },
    daemons: daemons.map((d) => ({ ...d, log: lastLine(`/var/log/ranch-${d.label.replace('com.ranch.', '')}.log`), status: mqttStatus.get(d.label.replace('com.ranch.', '')) })),
    cameras, labels_1h: labels, events: store.events({ limit: 10 }), totals: { frames: n('frames'), detections: n('detections'), events: n('events') },
  };
}
