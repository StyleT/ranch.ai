// Notifications that reach a person (com.ranch.notify, 1 Nov). Until now the only signal of a camera outage was a row on
// the dashboard: front_porch sat dead for 8.6 days and a DHCP re-lease took four cameras out for 3.5 hours before anyone
// looked. This daemon watches netprobe's retained snapshot and the supervisor's ledger events and posts three things to an
// ntfy.sh topic (no account; anyone who knows the topic name can subscribe, which is why the name is random and lives in
// ~/.config/ranch/notify.env on the mini, never in the repo):
//   fleet-down   >= NOTIFY_FLEET_MIN cameras down for >= NOTIFY_FLEET_AFTER_S (one post, one on recovery)
//   camera-down  one camera down for >= NOTIFY_CAMERA_AFTER_S (one post per outage, one on recovery with the duration)
//   daily        at NOTIFY_DAILY_UTC_HOUR: each camera's online share over the last 24 h and the supervisor's actions
// Without the env file it still runs and logs what it would have posted ("channel: none"), so provisioning never waits on it.
import { readFileSync } from 'node:fs';
import { config } from '@ranch/config';
import { connectBus, topics } from '@ranch/bus';
import { EventStore } from '@ranch/events';

const ENV_FILE = process.env.RANCH_NOTIFY_ENV ?? `${process.env.HOME ?? '/Users/ranch'}/.config/ranch/notify.env`;
const FLEET_MIN = Number(process.env.RANCH_NOTIFY_FLEET_MIN ?? 3);
const FLEET_AFTER_S = Number(process.env.RANCH_NOTIFY_FLEET_AFTER_S ?? 600);
const CAMERA_AFTER_S = Number(process.env.RANCH_NOTIFY_CAMERA_AFTER_S ?? 3600);
const DAILY_UTC_HOUR = Number(process.env.RANCH_NOTIFY_DAILY_UTC_HOUR ?? 13); // 08:00 or 09:00 at the ranch
const TICK_S = Number(process.env.RANCH_NOTIFY_TICK_S ?? 30);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'notify', msg, ...extra }) + '\n');

function channel(): { url: string; topic: string } | null {
  try {
    const txt = readFileSync(ENV_FILE, 'utf8');
    const get = (k: string) =>
      /^\s*([A-Z_]+)=(\S+)/m.exec(txt.split('\n').find((l) => l.startsWith(`${k}=`)) ?? '')?.[2] ?? null;
    const topic = get('NTFY_TOPIC');
    if (!topic) {
      return null;
    }
    return { url: get('NTFY_URL') ?? 'https://ntfy.sh', topic };
  } catch {
    return null;
  }
}

const ch = channel();
async function post(
  title: string,
  body: string,
  priority: 'default' | 'high' | 'low' = 'default',
  tags = 'camera',
): Promise<void> {
  log('notify', { title, body, priority, channel: ch ? 'ntfy' : 'none' });
  if (!ch) {
    return;
  }
  try {
    const res = await fetch(`${ch.url}/${ch.topic}`, {
      method: 'POST',
      body,
      headers: { Title: title, Priority: priority, Tags: tags },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log('ntfy post failed', { status: res.status });
    }
  } catch (e) {
    log('ntfy post failed', { error: String(e).slice(0, 120) });
  }
}
const fmtDur = (s: number) =>
  s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} d`;

type ProbeRow = {
  connected?: boolean | null;
  address_moved?: boolean | null;
  mac_seen_at?: string | null;
  ip?: string | null;
};
let probe: Record<string, ProbeRow> = {};
let probeTs = 0;
const downSince = new Map<string, number>(); // camera -> ms when first seen down
const cameraNotified = new Set<string>(); // cameras whose outage was posted (cleared on recovery)
let fleetDownSince: number | null = null;
let fleetNotified = false;
let lastDaily: string | null = null;

async function main(): Promise<void> {
  const bus = await connectBus('notify');
  const store = new EventStore(config.dbPath);
  await bus.subscribe(topics.status('netprobe'), (_t, payload) => {
    const p = payload as Record<string, unknown>;
    if (!p || typeof p !== 'object') {
      return;
    }
    const next: Record<string, ProbeRow> = {};
    for (const [k, v] of Object.entries(p)) {
      if (v && typeof v === 'object' && 'connected' in (v as object) && !config.camerasExclude.includes(k)) {
        next[k] = v as ProbeRow;
      }
    }
    probe = next;
    probeTs = Date.now();
  });
  // the supervisor's actions, as they happen (retained per camera, so the latest one arrives at start too)
  const seenRemediation = new Set<number>();
  await bus.subscribe('ranch/remediation/+', (_t, payload) => {
    const r = payload as {
      id?: number;
      camera?: string;
      rung?: number;
      action?: string;
      reason?: string;
      dry_run?: boolean;
      ts?: string;
    };
    if (!r || typeof r.id !== 'number' || seenRemediation.has(r.id)) {
      return;
    }
    seenRemediation.add(r.id);
    if (r.ts && Date.now() - Date.parse(r.ts) > 600e3) {
      return;
    } // a retained row from before this run
    if (r.action === 'camera_reboot' || r.action === 'go2rtc_restart') {
      void post(
        `${r.camera}: ${r.action === 'camera_reboot' ? 'rebooting camera' : 'restarting go2rtc'} (rung ${r.rung}${r.dry_run ? ', dry run' : ''})`,
        r.reason ?? '',
        'low',
        'wrench',
      );
    }
  });
  log('starting', {
    channel: ch ? `${ch.url}/<topic>` : 'none (no ' + ENV_FILE + ')',
    fleet_min: FLEET_MIN,
    fleet_after_s: FLEET_AFTER_S,
    camera_after_s: CAMERA_AFTER_S,
    daily_utc_hour: DAILY_UTC_HOUR,
  });
  for (;;) {
    const now = Date.now();
    if (now - probeTs < 120e3) {
      const down = Object.entries(probe)
        .filter(([, r]) => r.connected === false)
        .map(([c]) => c);
      for (const c of Object.keys(probe)) {
        if (down.includes(c)) {
          if (!downSince.has(c)) {
            downSince.set(c, now);
          }
        } else if (downSince.has(c)) {
          const since = downSince.get(c)!;
          downSince.delete(c);
          if (cameraNotified.delete(c)) {
            await post(`${c} is back`, `down for ${fmtDur((now - since) / 1000)}`, 'default', 'white_check_mark');
          }
        }
      }
      for (const c of down) {
        const since = downSince.get(c)!;
        if (!cameraNotified.has(c) && now - since >= CAMERA_AFTER_S * 1000) {
          cameraNotified.add(c);
          const r = probe[c]!;
          const where =
            r.address_moved && r.mac_seen_at
              ? `address moved ${r.ip} -> ${r.mac_seen_at}; the supervisor reboots it so the cloud learns the new one`
              : r.mac_seen_at
                ? `answers at ${r.mac_seen_at}, no stream`
                : 'not on the LAN: off Wi-Fi, a reboot cannot reach it; power-cycle it if it does not return by its scheduled restart';
          await post(`${c} down ${fmtDur((now - since) / 1000)}`, where, 'default');
        }
      }
      if (down.length >= FLEET_MIN) {
        if (fleetDownSince === null) {
          fleetDownSince = now;
        }
        if (!fleetNotified && now - fleetDownSince >= FLEET_AFTER_S * 1000) {
          fleetNotified = true;
          await post(`${down.length} cameras down`, down.join(', '), 'high', 'rotating_light');
        }
      } else if (fleetDownSince !== null) {
        const since = fleetDownSince;
        fleetDownSince = null;
        if (fleetNotified) {
          fleetNotified = false;
          await post(
            'fleet recovered',
            `after ${fmtDur((now - since) / 1000)}; still down: ${down.length ? down.join(', ') : 'none'}`,
            'default',
            'white_check_mark',
          );
        }
      }
    }
    const d = new Date(now);
    const day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === DAILY_UTC_HOUR && lastDaily !== day) {
      lastDaily = day;
      try {
        const av = store
          .availability({ since: new Date(now - 86400e3).toISOString() })
          .filter((a) => !config.camerasExclude.includes(a.camera));
        const lines = av.map(
          (a) =>
            `${a.camera} ${a.availability === null ? 'n/a' : Math.round(a.availability * 100) + '%'}${a.down_since ? ' (down now)' : a.outages ? ` ${a.outages} outage${a.outages > 1 ? 's' : ''}` : ''}`,
        );
        await post('cameras, last 24 h', lines.join('\n') || 'no probe data', 'low', 'bar_chart');
      } catch (e) {
        log('daily summary failed', { error: String(e).slice(0, 120) });
      }
    }
    await new Promise((r) => setTimeout(r, TICK_S * 1000));
  }
}
main().catch((e) => {
  log('fatal', { error: String(e) });
  process.exit(1);
});
