// The camera supervisor (com.ranch.camsup, docs/CAMERA-ARCHITECTURE.md, 23 Oct). Reads facts only: netprobe's retained
// snapshot (session held by go2rtc, ping) and the recorder's playlist age on disk. Never opens a stream, never calls
// go2rtc's API. Applies the ladder (ladder.ts) and writes every decision to the remediation ledger in SQLite with its
// outcome, so the dashboard and the post can show what each rung recovered.
//   rung 2  camera reboot through the Wyze cloud: MQTT `wyzebridge/<cam>/power/set` = restart (the bridge runs
//           RunAction(restart)); the only thing on the mini that reaches a camera on purpose, and the remedy that the
//           cameras' nightly restart already proved
//   rung 3  `launchctl kickstart -k system/com.ranch.go2rtc` (one redial of every camera)
//   rung 4  alert row only
//   1 Nov: rung 1b asks the bridge to stop/start one stream (`wyzebridge/<cam>/state/set`), and a reboot of a camera whose
//   address moved is followed by a bridge rediscover (`wyzebridge/bridge/discover/set`, so it pulls the address the camera
//   just reported to the cloud) and a stop/start of that stream (so the bridge, whose own health check counts a configured
//   source as alive, re-registers it with the new address). The cameras' addresses come from netprobe's `mac_seen_at`.
// RANCH_CAMSUP_DRY_RUN=1 records decisions without acting. Thresholds via RANCH_CAMSUP_* (seconds).
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '@ranch/config';
import { connectBus, topics } from '@ranch/bus';
import { EventStore } from '@ranch/events';
import { advance, decide, DEFAULTS, type CamFacts, type CamState, type LadderConfig } from './ladder.ts';

const TICK_S = Number(process.env.RANCH_CAMSUP_TICK_S ?? 15);
const DRY_RUN = process.env.RANCH_CAMSUP_DRY_RUN === '1';
const WB_TOPIC = process.env.RANCH_WB_TOPIC ?? 'wyzebridge';
const NOT_RECOVERED_AFTER_S = Number(process.env.RANCH_CAMSUP_NOT_RECOVERED_AFTER_S ?? 600);
const PING_WINDOW = 8;   // netprobe snapshots (15 s each) kept per camera for the "answers ping" fact
const cfg: LadderConfig = {
  rebootAfterS: Number(process.env.RANCH_CAMSUP_REBOOT_AFTER_S ?? DEFAULTS.rebootAfterS),
  rebootCooldownS: Number(process.env.RANCH_CAMSUP_REBOOT_COOLDOWN_S ?? DEFAULTS.rebootCooldownS),
  fleetRebootsPerHour: Number(process.env.RANCH_CAMSUP_FLEET_REBOOTS_PER_H ?? DEFAULTS.fleetRebootsPerHour),
  fleetWindowS: Number(process.env.RANCH_CAMSUP_FLEET_WINDOW_S ?? DEFAULTS.fleetWindowS),
  go2rtcRestartAfterS: Number(process.env.RANCH_CAMSUP_GO2RTC_RESTART_AFTER_S ?? DEFAULTS.go2rtcRestartAfterS),
  go2rtcMinCamerasDown: Number(process.env.RANCH_CAMSUP_GO2RTC_MIN_CAMERAS ?? DEFAULTS.go2rtcMinCamerasDown),
  go2rtcCooldownS: Number(process.env.RANCH_CAMSUP_GO2RTC_COOLDOWN_S ?? DEFAULTS.go2rtcCooldownS),
  streamRestartAfterS: Number(process.env.RANCH_CAMSUP_STREAM_RESTART_AFTER_S ?? DEFAULTS.streamRestartAfterS),
  blindRebootAfterS: Number(process.env.RANCH_CAMSUP_BLIND_REBOOT_AFTER_S ?? DEFAULTS.blindRebootAfterS),
  blindRebootCooldownS: Number(process.env.RANCH_CAMSUP_BLIND_REBOOT_COOLDOWN_S ?? DEFAULTS.blindRebootCooldownS),
};
const REDISCOVER_AFTER_REBOOT_S = Number(process.env.RANCH_CAMSUP_REDISCOVER_AFTER_REBOOT_S ?? 120);   // a Wyze cam is back on the cloud ~60-90 s after a reboot
const run = promisify(execFile);
const log = (msg: string, extra: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'camsup', msg, ...extra }) + '\n');

type ProbeRow = { connected?: boolean | null; ping_ms?: number | null; frames_fresh?: boolean | null; consumers?: number | null; ip?: string | null; mac_seen_at?: string | null; address_moved?: boolean | null };
let probe: Record<string, ProbeRow> = {}; let probeTs = 0;
const pingHistory = new Map<string, boolean[]>();
const states = new Map<string, CamState>();
const openRows = new Map<string, number[]>();      // camera -> open ledger ids
const fleetReboots: number[] = []; let lastGo2rtcRestartMs: number | null = null;
const pending: { at: number; what: string; run: () => Promise<void> }[] = [];   // follow-ups scheduled by a decision, run by the main loop

/** The cameras the bridge lists right now; its MQTT commands answer "unknown camera" for any other name (and while it starts). */
async function bridgeCameras(): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${config.bridgeUrl}/api/cameras`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return new Set(((await res.json()) as { name: string }[]).map((c) => c.name));
  } catch { return null; }
}
function liveAgeS(cam: string): number | null { try { return (Date.now() - statSync(join(config.liveDir, cam, 'index.m3u8')).mtimeMs) / 1000; } catch { return null; } }

async function main(): Promise<void> {
  const bus = await connectBus('camsup');
  const store = new EventStore(config.dbPath);
  // adopt open ledger rows from a previous run: an outage noted before a restart is the same outage, not a new row
  for (const r of store.openRemediations()) {
    (openRows.get(r.camera) ?? openRows.set(r.camera, []).get(r.camera)!).push(r.id);
    if (r.action === 'down') { const s = states.get(r.camera) ?? states.set(r.camera, { downSinceMs: null, lastRebootMs: null, rebootsThisOutage: 0, alertedThisOutage: false }).get(r.camera)!; if (s.downSinceMs === null) s.downSinceMs = Date.parse(r.ts); }
  }
  await bus.subscribe(topics.status('netprobe'), (_t, payload) => {
    const p = payload as Record<string, unknown>; if (!p || typeof p !== 'object') return;
    const next: Record<string, ProbeRow> = {};
    for (const [k, v] of Object.entries(p)) if (v && typeof v === 'object' && 'connected' in (v as object)) next[k] = v as ProbeRow;
    probe = next; probeTs = Date.now();
    for (const [cam, row] of Object.entries(next)) { const h = pingHistory.get(cam) ?? pingHistory.set(cam, []).get(cam)!; h.push(row.ping_ms !== null && row.ping_ms !== undefined); if (h.length > PING_WINDOW) h.shift(); }
  });
  log('starting', { dry_run: DRY_RUN, tick_s: TICK_S, ...cfg, wb_topic: WB_TOPIC });

  // the bridge's MQTT command surface (internal/mqtt/subscribe.go): <topic>/<cam>/state/set start|stop, <topic>/<cam>/power/set restart,
  // <topic>/bridge/discover/set <any>
  const wb = (topic: string, payload: string) => new Promise<void>((res) => bus.client.publish(`${WB_TOPIC}/${topic}`, payload, { qos: 0 }, () => res()));
  const streamRestart = async (camera: string) => { await wb(`${camera}/state/set`, 'stop'); await new Promise((r) => setTimeout(r, 5000)); await wb(`${camera}/state/set`, 'start'); };
  const record = (camera: string, rung: number, action: 'down' | 'reattach' | 'stream_restart' | 'camera_reboot' | 'go2rtc_restart' | 'alert', reason: string) => {
    const ts = new Date().toISOString();
    const id = store.insertRemediation({ ts, camera, rung, action, reason, dry_run: DRY_RUN });
    (openRows.get(camera) ?? openRows.set(camera, []).get(camera)!).push(id);
    log('remediation', { id, camera, rung, action, reason, dry_run: DRY_RUN });
    void bus.publish(`ranch/remediation/${camera}`, { id, ts, camera, rung, action, reason, dry_run: DRY_RUN }, { retain: true });
    return id;
  };
  const resolveAll = (camera: string, outcome: string, recoveredAfterS: number | null) => {
    const ts = new Date().toISOString();
    for (const id of openRows.get(camera) ?? []) store.resolveRemediation(id, outcome, ts, recoveredAfterS);
    openRows.delete(camera);
  };

  for (;;) {
    const now = Date.now();
    if (now - probeTs < 120e3) {
      const known = await bridgeCameras();
      const facts: CamFacts[] = Object.entries(probe).filter(([cam]) => !config.camerasExclude.includes(cam)).map(([cam, row]) => {
        const h = pingHistory.get(cam) ?? []; const pingOk = h.length >= 4 ? h.filter(Boolean).length / h.length >= 0.5 : null;
        return { camera: cam, connected: typeof row.connected === 'boolean' ? row.connected : null, pingOk, framesFresh: typeof row.frames_fresh === 'boolean' ? row.frames_fresh : null, consumers: typeof row.consumers === 'number' ? row.consumers : null,
          ip: row.ip ?? null, macSeenAt: row.mac_seen_at ?? null, addressMoved: typeof row.address_moved === 'boolean' ? row.address_moved : null,
          bridgeKnown: known === null ? null : known.has(cam) };
      });
      for (const f of facts) {
        const s = states.get(f.camera) ?? states.set(f.camera, { downSinceMs: null, lastRebootMs: null, rebootsThisOutage: 0, alertedThisOutage: false }).get(f.camera)!;
        const downSince = s.downSinceMs;
        const t = advance(s, f, now);
        if (t === 'went_down' && !(openRows.get(f.camera) ?? []).length) record(f.camera, 0, 'down', `no camera session (ping ${f.pingOk === null ? 'unknown' : f.pingOk ? 'ok' : 'failing'}, live playlist age ${liveAgeS(f.camera)?.toFixed(0) ?? 'n/a'} s)`);
        if (t === 'came_back') { const after = downSince === null ? null : Math.round((now - downSince) / 1000); resolveAll(f.camera, 'recovered', after); log('recovered', { camera: f.camera, down_for_s: after }); }
      }
      // judge actions that did not help within NOT_RECOVERED_AFTER_S
      for (const [camera, ids] of openRows) { const s = states.get(camera); if (!s || s.downSinceMs === null) continue; for (const id of ids) { const row = store.openRemediations(camera).find((r) => r.id === id); if (row && row.action !== 'down' && now - Date.parse(row.ts) > NOT_RECOVERED_AFTER_S * 1000) { store.resolveRemediation(id, 'not_recovered', new Date().toISOString(), null); } } openRows.set(camera, ids.filter((id) => store.openRemediations(camera).some((r) => r.id === id))); }
      for (const d of decide(now, facts, states, fleetReboots, lastGo2rtcRestartMs, cfg)) {
        if (d.action === 'reattach') {
          // rung 1 never touches a camera (it restarts our own ffmpeg), so it is not dry-run gated
          const ts = new Date().toISOString(); const id = store.insertRemediation({ ts, camera: d.camera, rung: 1, action: 'reattach', reason: d.reason, dry_run: false });
          log('remediation', { id, camera: d.camera, rung: 1, action: 'reattach', reason: d.reason });
          try { await run('/usr/bin/pkill', ['-TERM', '-f', `ffmpeg .*rtsp://127.0.0.1:8554/${d.camera}[[:space:]]`], { timeout: 5000 }); store.resolveRemediation(id, 'reattached', new Date().toISOString(), null); } catch (e) { store.resolveRemediation(id, `pkill failed: ${String(e).slice(0, 80)}`, new Date().toISOString(), null); }
          continue;
        }
        if (d.action === 'stream_restart') {
          // rung 1b never touches a camera (the bridge re-registers one stream, go2rtc redials that camera once), so it is not dry-run gated
          const ts = new Date().toISOString(); const id = store.insertRemediation({ ts, camera: d.camera, rung: 1, action: 'stream_restart', reason: d.reason, dry_run: false });
          (openRows.get(d.camera) ?? openRows.set(d.camera, []).get(d.camera)!).push(id);
          log('remediation', { id, camera: d.camera, rung: 1.5, action: 'stream_restart', reason: d.reason });
          try { await streamRestart(d.camera); } catch (e) { log('stream restart failed', { camera: d.camera, error: String(e).slice(0, 120) }); }
          continue;
        }
        record(d.camera, d.rung, d.action, d.reason);
        if (d.action === 'camera_reboot') {
          fleetReboots.push(now);
          if (!DRY_RUN) {
            await wb(`${d.camera}/power/set`, 'restart');   // raw string: the bridge compares the payload text
            if (d.moved) {
              // the camera reports its new address to the cloud when it boots; make the bridge pull it and re-register the stream
              pending.push({ at: now + REDISCOVER_AFTER_REBOOT_S * 1000, what: `rediscover after reboot of ${d.camera}`, run: () => wb('bridge/discover/set', '1') });
              pending.push({ at: now + (REDISCOVER_AFTER_REBOOT_S + 20) * 1000, what: `stream restart after reboot of ${d.camera}`, run: () => streamRestart(d.camera) });
            }
          }
        } else if (d.action === 'go2rtc_restart') {
          lastGo2rtcRestartMs = now;
          if (!DRY_RUN) { try { await run('/usr/bin/sudo', ['-n', '/bin/launchctl', 'kickstart', '-k', 'system/com.ranch.go2rtc'], { timeout: 20_000 }); } catch (e) { log('go2rtc restart failed', { error: String(e).slice(0, 160) }); } }
        }
      }
    } else if (probeTs) log('netprobe snapshot stale', { age_s: Math.round((now - probeTs) / 1000) });
    for (const p of pending.splice(0).filter((p) => p.at <= now ? (log('follow-up', { what: p.what }), true) : (pending.push(p), false))) {
      try { await p.run(); } catch (e) { log('follow-up failed', { what: p.what, error: String(e).slice(0, 120) }); }
    }
    try {
      await bus.publish(topics.status('camsup'), { ts: new Date().toISOString(), pid: process.pid, dry_run: DRY_RUN, rss_mb: Math.round(process.memoryUsage().rss / 1048576), ...cfg,
        cameras: Object.fromEntries([...states].map(([c, s]) => [c, { down_since: s.downSinceMs === null ? null : new Date(s.downSinceMs).toISOString(), reboots_this_outage: s.rebootsThisOutage, last_reboot: s.lastRebootMs === null ? null : new Date(s.lastRebootMs).toISOString() }])),
        fleet_reboots_in_window: fleetReboots.filter((t) => now - t < (cfg.fleetWindowS ?? 300) * 1000).length, fleet_reboots_last_h: fleetReboots.filter((t) => now - t < 3600e3).length, last_go2rtc_restart: lastGo2rtcRestartMs === null ? null : new Date(lastGo2rtcRestartMs).toISOString(), pending: pending.map((p) => ({ at: new Date(p.at).toISOString(), what: p.what })) }, { retain: true });
    } catch { /* broker hiccup */ }
    await new Promise((r) => setTimeout(r, TICK_S * 1000));
  }
}
main().catch((e) => { log('fatal', { error: String(e) }); process.exit(1); });
