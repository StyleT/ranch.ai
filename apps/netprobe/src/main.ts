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
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROBE_S = Number(process.env.RANCH_PROBE_S ?? 15);
const WIFI_EVERY = Number(process.env.RANCH_WIFI_EVERY ?? 4); // probes
const run = promisify(execFile);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'netprobe', msg, ...extra }) + '\n');

interface CamInfo {
  name: string;
  ip: string;
  mac: string | null;
}
let camsCache: { at: number; cams: CamInfo[] } = { at: 0, cams: [] };
async function cameras(): Promise<CamInfo[]> {
  if (Date.now() - camsCache.at < 300_000 && camsCache.cams.length) {
    return camsCache.cams;
  }
  try {
    const res = await fetch(`${config.bridgeUrl}/api/cameras`, { signal: AbortSignal.timeout(4000) });
    const list = (await res.json()) as { name: string; ip: string; mac?: string }[];
    camsCache = {
      at: Date.now(),
      cams: list
        .filter((c) => !config.camerasExclude.includes(c.name))
        .map((c) => ({ name: c.name, ip: c.ip, mac: normalizeMac(c.mac) })),
    };
  } catch (e) {
    log('bridge camera list failed', { error: String(e) });
  }
  return camsCache.cams;
}

// Where a camera really is on the LAN. The bridge's `ip` is what the Wyze cloud reports, which is the address the camera
// had when it last booted: a DHCP re-lease while the camera runs leaves the cloud, the bridge and go2rtc dialing an
// address the camera no longer holds (1 Nov: four cameras moved, go2rtc logged "discovery timeout" for 3.5 h, the
// supervisor read "off the network"). The neighbor table knows better: after a subnet sweep every SWEEP_EVERY probes,
// `arp -an` lists every MAC that answered, so the fact `mac_seen_at` is the address the camera's MAC currently holds.
const SWEEP_EVERY = Number(process.env.RANCH_SWEEP_EVERY ?? 20); // probes (20 x 15 s = 5 min)
/** "80482C46E577", "80:48:2c:46:e5:77" or macOS arp's "0:ae:f7:23:c0:e" -> "80:48:2c:46:e5:77". */
export function normalizeMac(raw: string | undefined | null): string | null {
  if (!raw) {
    return null;
  }
  const hex = raw.replace(/[^0-9a-fA-F:]/g, '');
  const parts = hex.includes(':') ? hex.split(':') : (hex.match(/.{1,2}/g) ?? []);
  if (parts.length !== 6 || parts.some((p) => p.length === 0 || p.length > 2)) {
    return null;
  }
  return parts.map((p) => p.padStart(2, '0').toLowerCase()).join(':');
}
/** The neighbor table as mac -> ip (one read of `arp -an`; incomplete entries carry no MAC and are skipped). */
async function arpTable(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { stdout } = await run('/usr/sbin/arp', ['-an'], { timeout: 4000 });
    for (const line of stdout.split('\n')) {
      const m = /\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+) /i.exec(line);
      const mac = m ? normalizeMac(m[2]) : null;
      if (m && mac) {
        out.set(mac, m[1]!);
      }
    }
  } catch (e) {
    log('arp read failed', { error: String(e).slice(0, 120) });
  }
  return out;
}
/** One ping to every host of each /24 the cameras live in, in batches, so the neighbor table is complete and fresh. */
async function sweep(prefixes: Set<string>): Promise<void> {
  const hosts: string[] = [];
  for (const p of prefixes) {
    for (let i = 1; i < 255; i++) {
      hosts.push(`${p}.${i}`);
    }
  }
  for (let i = 0; i < hosts.length; i += 64) {
    await Promise.all(
      hosts
        .slice(i, i + 64)
        .map((h) => run('/sbin/ping', ['-c', '1', '-W', '400', '-q', h], { timeout: 2500 }).catch(() => null)),
    );
  }
}

// `producer` means go2rtc lists the source (true even while the camera is unreachable); `connected` means that
// producer has a remote address, i.e. a live camera session. The distinction mattered on 23 Oct: the hourly table read
// producer 240/240 for a camera that had been off the LAN for ten hours.
interface StreamState {
  producer: boolean;
  connected: boolean;
  state: string | null;
  consumers: number;
  rx_bytes: number | null;
  remote: string | null;
  dial_ip: string | null;
}
async function streamState(name: string): Promise<StreamState | null> {
  try {
    const res = await fetch(`${config.go2rtcUrl}/api/streams?src=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) {
      return {
        producer: false,
        connected: false,
        state: null,
        consumers: 0,
        rx_bytes: null,
        remote: null,
        dial_ip: null,
      };
    }
    if (!res.ok) {
      return null;
    }
    const d = (await res.json()) as {
      producers?: { url?: string; remote_addr?: string; state?: string; receivers?: { bytes?: number }[] }[];
      consumers?: unknown[];
    };
    // go2rtc can list more than one producer entry for a stream after the bridge re-registers it; the live one is the
    // one with a remote address (23 Oct: producers[0] was a dead entry while [1] carried the session, so a connected
    // camera read as down)
    const live = d.producers?.find((x) => x.remote_addr);
    const p = live ?? d.producers?.[0];
    const bytes = p?.receivers?.reduce((s, r) => s + (r.bytes ?? 0), 0);
    // the address go2rtc dials: an idle or failing producer carries its `url` (wyze://<ip>?...), a live one only `remote_addr`
    const dialIp = /^wyze:\/\/([\d.]+)/.exec(p?.url ?? '')?.[1] ?? /^([\d.]+):/.exec(p?.remote_addr ?? '')?.[1] ?? null;
    return {
      producer: !!p,
      connected: !!live,
      state: p?.state ?? null,
      consumers: d.consumers?.length ?? 0,
      rx_bytes: bytes === undefined ? null : bytes,
      remote: live?.remote_addr ?? null,
      dial_ip: dialIp,
    };
  } catch {
    return null;
  }
}

async function ping(ip: string): Promise<number | null> {
  try {
    const { stdout } = await run('/sbin/ping', ['-c', '1', '-W', '1000', '-q', ip], { timeout: 3000 });
    const m = /= ([\d.]+)\/([\d.]+)\//.exec(stdout);
    return m ? Number(m[2]) : null;
  } catch {
    return null;
  }
}

async function wifi(): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run('/usr/bin/sudo', ['-n', '/usr/bin/wdutil', 'info'], { timeout: 8000 });
    const pick = (k: string) => {
      const m = new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'm').exec(stdout);
      return m?.[1]?.trim() ?? null;
    };
    const num = (v: string | null) => (v === null ? null : Number.parseFloat(v));
    return {
      rssi_dbm: num(pick('RSSI')),
      noise_dbm: num(pick('Noise')),
      tx_rate_mbps: num(pick('Tx Rate')),
      channel: pick('Channel'),
      mcs: num(pick('MCS Index')),
    };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

const PROBE_KEEP_D = Number(process.env.RANCH_PROBE_KEEP_D ?? 7);
const FRESH_S = Number(process.env.RANCH_FRESH_S ?? 30);
/** Seconds since the recorder last wrote this camera's newest JPEG buffer frame. Frames on disk are the ground truth for
 *  "the camera delivers video": the recorder always writes the buffer (the HLS playlist is on-demand since 23 Oct), and
 *  go2rtc's stream list can lie (an orphaned stream object after the bridge re-registers, or a session that reads
 *  connected ~90 s after the packets stop). */
function liveAgeS(cam: string): number | null {
  try {
    const dir = join(config.bufferDir, cam);
    const f = readdirSync(dir)
      .filter((x) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jpg$/.test(x))
      .sort()
      .pop();
    return f ? (Date.now() - statSync(join(dir, f)).mtimeMs) / 1000 : null;
  } catch {
    return null;
  }
}

/** Seconds since the recorder last wrote a ring segment for this camera (stream-copied packets only). */
function ringAgeS(cam: string): number | null {
  try {
    const dir = join(config.mediaDir, 'ring', cam);
    const f = readdirSync(dir)
      .filter((x) => x.endsWith('.ts'))
      .sort()
      .pop();
    return f ? Math.round((Date.now() - statSync(join(dir, f)).mtimeMs) / 1000) : null;
  } catch {
    return null;
  }
}
/** The recorder's ffmpeg for this camera and the state of its RTSP socket to go2rtc (none: no :8554 socket at all). */
async function recorderSocket(cam: string): Promise<{ ffmpeg_pid: number | null; rtsp_socket: string | null }> {
  try {
    const { stdout } = await run('/usr/bin/pgrep', ['-f', `ffmpeg .*-skip_frame nokey .*8554/${cam}[[:space:]]`], {
      timeout: 3000,
    });
    const pid = Number(stdout.trim().split('\n')[0]);
    if (!pid) {
      return { ffmpeg_pid: null, rtsp_socket: null };
    }
    const lsof = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP:8554'], { timeout: 3000 }).catch(
      () => ({ stdout: '' }),
    );
    const state = /\((\w+)\)\s*$/m.exec(lsof.stdout)?.[1] ?? 'none';
    return { ffmpeg_pid: pid, rtsp_socket: state };
  } catch {
    return { ffmpeg_pid: null, rtsp_socket: null };
  }
}

async function main(): Promise<void> {
  const bus = await connectBus('netprobe');
  // every sample also lands in SQLite (camera_probe): the availability numbers on the dashboard and the supervisor's
  // facts come from there, not from the unified log (docs/CAMERA-ARCHITECTURE.md, 23 Oct)
  const store = new EventStore(config.dbPath);
  const prev = new Map<string, StreamState>();
  const flowing = new Map<string, boolean>();
  const seenAt = new Map<string, string | null>(); // last reported mac_seen_at per camera, for the transition line
  let arp = new Map<string, string>();
  let sweepNow = true; // a camera's session dropping asks for a sweep on the next probe, not the next 5-minute tick
  let tick = 0;
  log('starting', { probe_s: PROBE_S, go2rtc: config.go2rtcUrl, bridge: config.bridgeUrl });
  for (;;) {
    const t0 = Date.now();
    const cams = await cameras();
    if (sweepNow || tick % SWEEP_EVERY === 0) {
      sweepNow = false;
      await sweep(
        new Set(cams.map((c) => c.ip.split('.').slice(0, 3).join('.')).filter((p) => p.split('.').length === 3)),
      );
    }
    arp = await arpTable();
    const row_ts = new Date().toISOString();
    const snapshot: Record<string, unknown> = { ts: row_ts, pid: process.pid };
    await Promise.all(
      cams.map(async (c) => {
        const [st, rtt] = await Promise.all([streamState(c.name), ping(c.ip)]);
        const macSeenAt = c.mac ? (arp.get(c.mac) ?? null) : null;
        const dialIp = st?.dial_ip ?? c.ip;
        const addressMoved = macSeenAt !== null && dialIp !== macSeenAt; // go2rtc dials where the camera is not
        if (seenAt.has(c.name) && seenAt.get(c.name) !== macSeenAt) {
          log(addressMoved ? 'address moved' : macSeenAt === null ? 'mac not on lan' : 'address back', {
            camera: c.name,
            cloud_ip: c.ip,
            dial_ip: dialIp,
            mac: c.mac,
            mac_seen_at: macSeenAt,
          });
        }
        seenAt.set(c.name, macSeenAt);
        const p = prev.get(c.name);
        const delta =
          st && p && st.rx_bytes !== null && p.rx_bytes !== null && st.remote === p.remote
            ? st.rx_bytes - p.rx_bytes
            : null;
        const liveAge = liveAgeS(c.name);
        const framesFresh = liveAge !== null && liveAge < FRESH_S;
        // connected = video is arriving (the recorder wrote this camera's playlist in the last FRESH_S). go2rtc's session
        // view is kept as session_visible only: it stays "connected" for ~90 s after the packets stop (chaos run 23 Oct:
        // detection took 95 s while the frames had stopped at 15 s) and it misses orphaned stream objects. When the recorder
        // has never written a playlist for the camera (no live dir), the session view is the fallback.
        const row = {
          camera: c.name,
          ip: c.ip,
          dial_ip: dialIp,
          mac: c.mac,
          mac_seen_at: macSeenAt,
          address_moved: addressMoved,
          producer: st?.producer ?? null,
          connected: liveAge === null ? (st?.connected ?? null) : framesFresh,
          session_visible: st?.connected ?? null,
          frames_fresh: framesFresh,
          live_age_s: liveAge === null ? null : Math.round(liveAge),
          state: st?.state ?? null,
          consumers: st?.consumers ?? null,
          rx_bytes_delta: delta,
          remote: st?.remote ?? null,
          ping_ms: rtt,
        };
        log('probe', row);
        snapshot[c.name] = row;
        if (st || framesFresh) {
          try {
            store.insertProbe({
              ts: row_ts,
              camera: c.name,
              connected: row.connected === true,
              ping_ms: rtt,
              consumers: st?.consumers ?? null,
            });
          } catch (e) {
            log('probe insert failed', { error: String(e).slice(0, 120) });
          }
        }
        if (st) {
          if (p && p.producer !== st.producer) {
            log('producer changed', { camera: c.name, producer: st.producer });
          }
          if (p && p.consumers > 0 && st.consumers === 0) {
            // go2rtc lost its last consumer without us asking: record what the recorder's ffmpeg looks like at that moment
            log('consumers dropped', {
              camera: c.name,
              ...(await recorderSocket(c.name)),
              frames_age_s: liveAge === null ? null : Math.round(liveAge),
              ring_age_s: ringAgeS(c.name),
            });
          }
          if (p && p.connected !== st.connected) {
            log('session changed', {
              camera: c.name,
              session_visible: st.connected,
              remote: st.remote,
              state: st.state,
              frames_fresh: framesFresh,
            });
            if (!st.connected) {
              sweepNow = true;
            }
          }
          const isFlowing = delta !== null ? delta > 0 : null;
          if (isFlowing !== null && flowing.get(c.name) !== undefined && flowing.get(c.name) !== isFlowing) {
            log(isFlowing ? 'bytes flowing again' : 'bytes stopped', { camera: c.name, rx_bytes_delta: delta });
          }
          if (isFlowing !== null) {
            flowing.set(c.name, isFlowing);
          }
          prev.set(c.name, st);
        }
      }),
    );
    if (tick % WIFI_EVERY === 0) {
      const w = await wifi();
      log('wifi', w ?? {});
      snapshot.wifi = w;
    }
    try {
      await bus.publish(topics.status('netprobe'), snapshot, { retain: true });
    } catch {
      /* broker hiccup */
    }
    tick++;
    if (tick % 240 === 0) {
      try {
        const n = store.pruneProbes(new Date(Date.now() - PROBE_KEEP_D * 86400e3).toISOString());
        if (n) {
          log('probes pruned', { deleted: n, keep_days: PROBE_KEEP_D });
        }
      } catch {
        /* next hour */
      }
    }
    await new Promise((r) => setTimeout(r, Math.max(1000, PROBE_S * 1000 - (Date.now() - t0))));
  }
}
main().catch((e) => {
  log('fatal', { error: String(e) });
  process.exit(1);
});
