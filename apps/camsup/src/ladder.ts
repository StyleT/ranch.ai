// The remediation ladder, pure (docs/CAMERA-ARCHITECTURE.md, 23 Oct; address facts 1 Nov). Facts in, decisions out;
// main.ts owns the clock, the ledger and the side effects.
//
//   rung 1   re-attach the recorder's ffmpeg          frames are flowing but go2rtc shows no consumer for the stream for
//            (software only, never dry-run gated)     two ticks: the bridge re-registered the stream (DELETE+PUT) and ffmpeg
//                                                     is consuming an orphaned stream object; the new object will dial the
//                                                     camera a second time on the next attach. Re-attaching moves ffmpeg
//                                                     onto the new object and lets the orphan (and its camera session) die.
//                                                     (A hung dial is rung 1 too, but the recorder's own watchdog handles it.)
//   rung 1b  bridge stream restart                    down ≥ streamRestartAfterS, the camera answers ping at the address the
//            (software only, one camera)              bridge dials, address not moved, not yet tried this outage: the bridge's
//                                                     own health check cannot see a producer that never connects (it counts a
//                                                     configured source as alive), so ask it to stop/start that one stream;
//                                                     go2rtc re-dials that camera only
//   rung 1c  re-register                              go2rtc dials an address the camera's MAC is not at, but the bridge (the
//            (software only, one camera)              cloud) already has the address the MAC is at: the bridge stored the new
//                                                     address without re-registering the stream, so ask it to stop/start that
//                                                     stream now; no reboot, no budget, reattachCooldownS between tries
//   rung 2   camera reboot via the Wyze cloud         down ≥ rebootAfterS and the camera is reachable for a reboot: it answers
//                                                     ping (after rung 1b did not help) OR its MAC is seen at another address
//                                                     that the cloud does not know yet (the cloud reports the address a camera
//                                                     had when it last booted; a DHCP re-lease while it runs leaves the cloud,
//                                                     the bridge and go2rtc dialing a dead address, and only a reboot makes the
//                                                     camera report the new one); cooldown + fleet budget ok
//                                                     (fleetRebootsPerHour per fleetWindowS)
//   rung 2b  blind reboot                             off the LAN (no ping, MAC seen nowhere) for ≥ blindRebootAfterS: one
//                                                     reboot through the cloud in case the camera is cloud-connected on
//                                                     another AP or band and rejoins; once per blindRebootCooldownS
//   rung 3   go2rtc restart                           ≥ go2rtcMinCamerasDown cameras down ≥ go2rtcRestartAfterS with a reboot
//                                                     already tried, go2rtc cooldown ok
//   rung 4   alert only                               down ≥ rebootAfterS, no ping, MAC seen nowhere (off the network: nothing
//                                                     on the mini can help but rung 2b); once per outage

export interface CamFacts {
  camera: string; connected: boolean | null; pingOk: boolean | null; framesFresh?: boolean | null; consumers?: number | null;
  /** ip: the address the bridge (the Wyze cloud) has for the camera; dialIp: the address go2rtc's source dials right now;
   *  macSeenAt: the address the camera's MAC currently holds on the LAN (null: seen nowhere) */
  ip?: string | null; dialIp?: string | null; macSeenAt?: string | null;
  /** the bridge lists this camera right now (its MQTT commands answer "unknown camera" while it is starting or has not
   *  finished discovery; 1 Nov: two reboots sent 100 ms after a bridge re-bootstrap were dropped and the budget spent) */
  bridgeKnown?: boolean | null;
}
export interface CamState {
  downSinceMs: number | null; lastRebootMs: number | null; rebootsThisOutage: number; alertedThisOutage: boolean;
  orphanTicks?: number; lastReattachMs?: number | null; streamRestartTried?: boolean; lastBlindRebootMs?: number | null;
}
export interface LadderConfig {
  rebootAfterS: number; rebootCooldownS: number; fleetRebootsPerHour: number; fleetWindowS?: number;   // fleetRebootsPerHour reboots per fleetWindowS (name kept; 1 Nov: 2 per 300 s)
  go2rtcRestartAfterS: number; go2rtcMinCamerasDown: number; go2rtcCooldownS: number;
  reattachCooldownS?: number; streamRestartAfterS?: number; blindRebootAfterS?: number; blindRebootCooldownS?: number;
}
export type Decision =
  | { rung: 1; action: 'reattach'; camera: string; reason: string }
  | { rung: 1.5; action: 'stream_restart'; camera: string; reason: string }
  | { rung: 1; action: 'reregister'; camera: string; reason: string }
  | { rung: 2; action: 'camera_reboot'; camera: string; reason: string; moved: boolean; blind: boolean }
  | { rung: 3; action: 'go2rtc_restart'; camera: string; reason: string; cameras: string[] }
  | { rung: 4; action: 'alert'; camera: string; reason: string };

export const DEFAULTS: LadderConfig = {
  rebootAfterS: 600, rebootCooldownS: 1800, fleetRebootsPerHour: 2, go2rtcRestartAfterS: 900, go2rtcMinCamerasDown: 3, go2rtcCooldownS: 3600,
  reattachCooldownS: 120, streamRestartAfterS: 120, blindRebootAfterS: 3600, blindRebootCooldownS: 21600, fleetWindowS: 300,
};

/** Advance a camera's state with a new fact. Returns the transition, if any. */
export function advance(state: CamState, f: CamFacts, nowMs: number): 'went_down' | 'came_back' | null {
  if (f.connected === true) {
    if (state.downSinceMs !== null) { state.downSinceMs = null; state.rebootsThisOutage = 0; state.alertedThisOutage = false; state.streamRestartTried = false; return 'came_back'; }
    return null;
  }
  if (f.connected === false && state.downSinceMs === null) { state.downSinceMs = nowMs; return 'went_down'; }
  return null;
}

export function decide(nowMs: number, facts: CamFacts[], states: Map<string, CamState>, fleetRebootTimesMs: number[], lastGo2rtcRestartMs: number | null, cfg: LadderConfig = DEFAULTS): Decision[] {
  const out: Decision[] = [];
  const windowS = cfg.fleetWindowS ?? 300;
  const recentReboots = fleetRebootTimesMs.filter((t) => nowMs - t < windowS * 1000).length;
  let budget = Math.max(0, cfg.fleetRebootsPerHour - recentReboots);
  const downLong: string[] = [];
  const reboot = (f: CamFacts, s: CamState, reason: string, moved: boolean, blind: boolean) => {
    budget--; s.lastRebootMs = nowMs; s.rebootsThisOutage++;
    out.push({ rung: 2, action: 'camera_reboot', camera: f.camera, reason: `${reason} (${s.rebootsThisOutage} this outage, fleet ${recentReboots + 1}/${cfg.fleetRebootsPerHour} per ${windowS >= 3600 ? `${Math.round(windowS / 3600)} h` : `${Math.round(windowS / 60)} min`})`, moved, blind });
  };
  for (const f of facts) {
    const s = states.get(f.camera); if (!s) continue;
    // rung 1: orphaned consumer (frames flow, go2rtc sees no consumer) for two consecutive ticks
    if (f.framesFresh === true && f.consumers === 0) {
      s.orphanTicks = (s.orphanTicks ?? 0) + 1;
      const cooled = s.lastReattachMs === null || s.lastReattachMs === undefined || nowMs - s.lastReattachMs >= (cfg.reattachCooldownS ?? 120) * 1000;
      if (s.orphanTicks >= 2 && cooled) { s.lastReattachMs = nowMs; s.orphanTicks = 0; out.push({ rung: 1, action: 'reattach', camera: f.camera, reason: 'frames flowing but go2rtc shows no consumer: the stream was re-registered and ffmpeg is on an orphaned object; re-attaching so the orphan and its camera session can die' }); }
    } else s.orphanTicks = 0;
    if (s.downSinceMs === null) continue;
    const downS = (nowMs - s.downSinceMs) / 1000;
    const bridgeReady = f.bridgeKnown !== false;   // unknown counts as ready (older netprobe rows); false waits for the next tick
    const dial = f.dialIp ?? f.ip ?? null;
    const stale = !!f.macSeenAt && !!dial && dial !== f.macSeenAt;   // go2rtc dials where the camera is not
    const cloudKnows = stale && f.ip === f.macSeenAt;                 // the bridge already holds the right address
    const moved = stale && !cloudKnows;                               // only a reboot gets the new address into the cloud
    // rung 1c: the right address is in the bridge, the stream just was not re-registered
    if (cloudKnows && bridgeReady) {
      const cooled = s.lastReattachMs === null || s.lastReattachMs === undefined || nowMs - s.lastReattachMs >= (cfg.reattachCooldownS ?? 120) * 1000;
      if (cooled) { s.lastReattachMs = nowMs; out.push({ rung: 1, action: 'reregister', camera: f.camera, reason: `go2rtc dials ${dial} but the camera is at ${f.macSeenAt} and the bridge already has that address: asking the bridge to stop/start this stream (no reboot needed)` }); }
      continue;
    }
    // rung 1b: the bridge cannot see a dead producer; ask it to restart this one stream before anything touches the camera
    if (!moved && f.pingOk === true && bridgeReady && !s.streamRestartTried && downS >= (cfg.streamRestartAfterS ?? 120)) {
      s.streamRestartTried = true;
      out.push({ rung: 1.5, action: 'stream_restart', camera: f.camera, reason: `down ${Math.round(downS)} s, answers ping at ${f.ip ?? 'its address'}: asking the bridge to stop/start this stream (its health check counts a configured source as alive)` });
      continue;
    }
    if (downS < cfg.rebootAfterS) continue;
    const cooled = s.lastRebootMs === null || nowMs - s.lastRebootMs >= cfg.rebootCooldownS * 1000;
    if (!bridgeReady) continue;   // nothing below reaches a camera without the bridge; try again next tick, spend nothing
    if (moved) {
      if (cooled && budget > 0) reboot(f, s, `address moved (${f.ip ?? '?'} -> ${f.macSeenAt}): the cloud still reports the old address, the bridge dials it; reboot so the camera reports the new one`, true, false);
    } else if (f.pingOk === true) {
      if (cooled && budget > 0) reboot(f, s, `down ${Math.round(downS)} s, answers ping, stream restart did not help; reboot via Wyze cloud`, false, false);
    } else if (f.pingOk === false) {
      if (!s.alertedThisOutage) { s.alertedThisOutage = true; out.push({ rung: 4, action: 'alert', camera: f.camera, reason: `down ${Math.round(downS)} s, no ping, MAC seen nowhere on the LAN: off the network, nothing on the mini can help` }); }
      const blindCooled = s.lastBlindRebootMs === null || s.lastBlindRebootMs === undefined || nowMs - s.lastBlindRebootMs >= (cfg.blindRebootCooldownS ?? 21600) * 1000;
      if (downS >= (cfg.blindRebootAfterS ?? 3600) && blindCooled && cooled && budget > 0) { s.lastBlindRebootMs = nowMs; reboot(f, s, `off the LAN for ${Math.round(downS)} s: one reboot through the cloud in case it rejoins`, false, true); }
      continue;
    } else continue;   // no ping fact yet: wait
    if (downS >= cfg.go2rtcRestartAfterS && s.rebootsThisOutage >= 1) downLong.push(f.camera);
  }
  if (downLong.length >= cfg.go2rtcMinCamerasDown && (lastGo2rtcRestartMs === null || nowMs - lastGo2rtcRestartMs >= cfg.go2rtcCooldownS * 1000)) {
    out.push({ rung: 3, action: 'go2rtc_restart', camera: downLong[0]!, cameras: downLong, reason: `${downLong.length} cameras down ≥ ${cfg.go2rtcRestartAfterS} s after a reboot each: restarting go2rtc (all cameras redial once)` });
  }
  return out;
}
