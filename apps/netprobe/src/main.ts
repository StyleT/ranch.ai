// Network/stream probe: the evidence log for camera dropouts (docs/CAMERAS.md, 16 Oct). Every RANCH_PROBE_S
// seconds it records, per camera, what go2rtc holds for the stream (producer present, consumers, receiver bytes
// since the last probe) and an ICMP probe (Wyze cams answer ping inconsistently, so this is a weak signal, logged
// anyway), plus the mini's own Wi-Fi link (RSSI, noise, tx rate) once a minute. Output is JSON lines on stdout
// (launchd -> /var/log/ranch-netprobe.log) and a retained MQTT snapshot on ranch/status/netprobe. Transitions
// (producer appears/disappears, bytes start/stop flowing) are logged as their own lines so grep finds gap edges.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '@ranch/config';
import { connectBus, topics } from '@ranch/bus';
import { EventStore } from '@ranch/events';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const PROBE_S = Number(process.env.RANCH_PROBE_S ?? 15);
const WIFI_EVERY = Number(process.env.RANCH_WIFI_EVERY ?? 4); // probes
const run = promisify(execFile);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'netprobe', msg, ...extra }) + '\n');

interface CamInfo { name: string; ip: string }
let camsCache: { at: number; cams: CamInfo[] } = { at: 0, cams: [] };
async function cameras(): Promise<CamInfo[]> {
  if (Date.now() - camsCache.at < 300_000 && camsCache.cams.length) return camsCache.cams;
  try {
    const res = await fetch(`${config.bridgeUrl}/api/cameras`, { signal: AbortSignal.timeout(4000) });
    const list = (await res.json()) as { name: string; ip: string }[];
    camsCache = { at: Date.now(), cams: list.filter((c) => !config.camerasExclude.includes(c.name)).map((c) => ({ name: c.name, ip: c.ip })) };
  } catch (e) { log('bridge camera list failed', { error: String(e) }); }
  return camsCache.cams;
}

// `producer` means go2rtc lists the source (true even while the camera is unreachable); `connected` means that
// producer has a remote address, i.e. a live camera session. The distinction mattered on 23 Oct: the hourly table read
// producer 240/240 for a camera that had been off the LAN for ten hours.
interface StreamState { producer: boolean; connected: boolean; state: string | null; consumers: number; rx_bytes: number | null; remote: string | null }
async function streamState(name: string): Promise<StreamState | null> {
  try {
    const res = await fetch(`${config.go2rtcUrl}/api/streams?src=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 404) return { producer: false, connected: false, state: null, consumers: 0, rx_bytes: null, remote: null };
    if (!res.ok) return null;
    const d = (await res.json()) as { producers?: { remote_addr?: string; state?: string; receivers?: { bytes?: number }[] }[]; consumers?: unknown[] };
    // go2rtc can list more than one producer entry for a stream after the bridge re-registers it; the live one is the
    // one with a remote address (23 Oct: producers[0] was a dead entry while [1] carried the session, so a connected
    // camera read as down)
    const live = d.producers?.find((x) => x.remote_addr); const p = live ?? d.producers?.[0];
    const bytes = p?.receivers?.reduce((s, r) => s + (r.bytes ?? 0), 0);
    return { producer: !!p, connected: !!live, state: p?.state ?? null, consumers: d.consumers?.length ?? 0, rx_bytes: bytes === undefined ? null : bytes, remote: live?.remote_addr ?? null };
  } catch { return null; }
}

async function ping(ip: string): Promise<number | null> {
  try {
    const { stdout } = await run('/sbin/ping', ['-c', '1', '-W', '1000', '-q', ip], { timeout: 3000 });
    const m = /= ([\d.]+)\/([\d.]+)\//.exec(stdout);
    return m ? Number(m[2]) : null;
  } catch { return null; }
}

async function wifi(): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run('/usr/bin/sudo', ['-n', '/usr/bin/wdutil', 'info'], { timeout: 8000 });
    const pick = (k: string) => { const m = new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'm').exec(stdout); return m?.[1]?.trim() ?? null; };
    const num = (v: string | null) => (v === null ? null : Number.parseFloat(v));
    return { rssi_dbm: num(pick('RSSI')), noise_dbm: num(pick('Noise')), tx_rate_mbps: num(pick('Tx Rate')), channel: pick('Channel'), mcs: num(pick('MCS Index')) };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
}

const PROBE_KEEP_D = Number(process.env.RANCH_PROBE_KEEP_D ?? 7);
const FRESH_S = Number(process.env.RANCH_FRESH_S ?? 15);
/** Seconds since the recorder last wrote this camera's HLS playlist: frames flowing is the ground truth for "the camera
 *  delivers video". go2rtc's stream list can lie: after the bridge re-registers a stream (DELETE+PUT), the recorder's
 *  ffmpeg keeps consuming the orphaned old stream object while the new one shows no producer and no consumers (23 Oct). */
function liveAgeS(cam: string): number | null { try { return (Date.now() - statSync(join(config.liveDir, cam, 'index.m3u8')).mtimeMs) / 1000; } catch { return null; } }

async function main(): Promise<void> {
  const bus = await connectBus('netprobe');
  // every sample also lands in SQLite (camera_probe): the availability numbers on the dashboard and the supervisor's
  // facts come from there, not from the unified log (docs/CAMERA-ARCHITECTURE.md, 23 Oct)
  const store = new EventStore(config.dbPath);
  const prev = new Map<string, StreamState>();
  const flowing = new Map<string, boolean>();
  let tick = 0;
  log('starting', { probe_s: PROBE_S, go2rtc: config.go2rtcUrl, bridge: config.bridgeUrl });
  for (;;) {
    const t0 = Date.now();
    const cams = await cameras();
    const row_ts = new Date().toISOString();
    const snapshot: Record<string, unknown> = { ts: row_ts, pid: process.pid };
    await Promise.all(cams.map(async (c) => {
      const [st, rtt] = await Promise.all([streamState(c.name), ping(c.ip)]);
      const p = prev.get(c.name);
      const delta = st && p && st.rx_bytes !== null && p.rx_bytes !== null && st.remote === p.remote ? st.rx_bytes - p.rx_bytes : null;
      const liveAge = liveAgeS(c.name); const framesFresh = liveAge !== null && liveAge < FRESH_S;
      // connected = video is arriving (the recorder wrote this camera's playlist in the last FRESH_S). go2rtc's session
      // view is kept as session_visible only: it stays "connected" for ~90 s after the packets stop (chaos run 23 Oct:
      // detection took 95 s while the frames had stopped at 15 s) and it misses orphaned stream objects. When the recorder
      // has never written a playlist for the camera (no live dir), the session view is the fallback.
      const row = { camera: c.name, ip: c.ip, producer: st?.producer ?? null, connected: liveAge === null ? (st?.connected ?? null) : framesFresh, session_visible: st?.connected ?? null, frames_fresh: framesFresh, live_age_s: liveAge === null ? null : Math.round(liveAge), state: st?.state ?? null, consumers: st?.consumers ?? null, rx_bytes_delta: delta, remote: st?.remote ?? null, ping_ms: rtt };
      log('probe', row);
      snapshot[c.name] = row;
      if (st || framesFresh) { try { store.insertProbe({ ts: row_ts, camera: c.name, connected: row.connected === true, ping_ms: rtt, consumers: st?.consumers ?? null }); } catch (e) { log('probe insert failed', { error: String(e).slice(0, 120) }); } }
      if (st) {
        if (p && p.producer !== st.producer) log('producer changed', { camera: c.name, producer: st.producer });
        if (p && p.connected !== st.connected) log('session changed', { camera: c.name, session_visible: st.connected, remote: st.remote, state: st.state, frames_fresh: framesFresh });
        const isFlowing = delta !== null ? delta > 0 : null;
        if (isFlowing !== null && flowing.get(c.name) !== undefined && flowing.get(c.name) !== isFlowing) log(isFlowing ? 'bytes flowing again' : 'bytes stopped', { camera: c.name, rx_bytes_delta: delta });
        if (isFlowing !== null) flowing.set(c.name, isFlowing);
        prev.set(c.name, st);
      }
    }));
    if (tick % WIFI_EVERY === 0) { const w = await wifi(); log('wifi', w ?? {}); snapshot.wifi = w; }
    try { await bus.publish(topics.status('netprobe'), snapshot, { retain: true }); } catch { /* broker hiccup */ }
    tick++;
    if (tick % 240 === 0) { try { const n = store.pruneProbes(new Date(Date.now() - PROBE_KEEP_D * 86400e3).toISOString()); if (n) log('probes pruned', { deleted: n, keep_days: PROBE_KEEP_D }); } catch { /* next hour */ } }
    await new Promise((r) => setTimeout(r, Math.max(1000, PROBE_S * 1000 - (Date.now() - t0))));
  }
}
main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
