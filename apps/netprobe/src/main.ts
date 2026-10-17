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

interface StreamState { producer: boolean; consumers: number; rx_bytes: number | null; remote: string | null }
async function streamState(name: string): Promise<StreamState | null> {
  try {
    const res = await fetch(`${config.go2rtcUrl}/api/streams?src=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 404) return { producer: false, consumers: 0, rx_bytes: null, remote: null };
    if (!res.ok) return null;
    const d = (await res.json()) as { producers?: { remote_addr?: string; receivers?: { bytes?: number }[] }[]; consumers?: unknown[] };
    const p = d.producers?.[0];
    const bytes = p?.receivers?.reduce((s, r) => s + (r.bytes ?? 0), 0);
    return { producer: !!p, consumers: d.consumers?.length ?? 0, rx_bytes: bytes === undefined ? null : bytes, remote: p?.remote_addr ?? null };
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

async function main(): Promise<void> {
  const bus = await connectBus('netprobe');
  const prev = new Map<string, StreamState>();
  const flowing = new Map<string, boolean>();
  let tick = 0;
  log('starting', { probe_s: PROBE_S, go2rtc: config.go2rtcUrl, bridge: config.bridgeUrl });
  for (;;) {
    const t0 = Date.now();
    const cams = await cameras();
    const snapshot: Record<string, unknown> = { ts: new Date().toISOString(), pid: process.pid };
    await Promise.all(cams.map(async (c) => {
      const [st, rtt] = await Promise.all([streamState(c.name), ping(c.ip)]);
      const p = prev.get(c.name);
      const delta = st && p && st.rx_bytes !== null && p.rx_bytes !== null && st.remote === p.remote ? st.rx_bytes - p.rx_bytes : null;
      const row = { camera: c.name, ip: c.ip, producer: st?.producer ?? null, consumers: st?.consumers ?? null, rx_bytes_delta: delta, remote: st?.remote ?? null, ping_ms: rtt };
      log('probe', row);
      snapshot[c.name] = row;
      if (st) {
        if (p && p.producer !== st.producer) log('producer changed', { camera: c.name, producer: st.producer });
        const isFlowing = delta !== null ? delta > 0 : null;
        if (isFlowing !== null && flowing.get(c.name) !== undefined && flowing.get(c.name) !== isFlowing) log(isFlowing ? 'bytes flowing again' : 'bytes stopped', { camera: c.name, rx_bytes_delta: delta });
        if (isFlowing !== null) flowing.set(c.name, isFlowing);
        prev.set(c.name, st);
      }
    }));
    if (tick % WIFI_EVERY === 0) { const w = await wifi(); log('wifi', w ?? {}); snapshot.wifi = w; }
    try { await bus.publish(topics.status('netprobe'), snapshot, { retain: true }); } catch { /* broker hiccup */ }
    tick++;
    await new Promise((r) => setTimeout(r, Math.max(1000, PROBE_S * 1000 - (Date.now() - t0))));
  }
}
main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
