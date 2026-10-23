// The remediation ladder, pure (docs/CAMERA-ARCHITECTURE.md, 23 Oct). Facts in, decisions out; main.ts owns the clock,
// the ledger and the side effects.
//
//   rung 1  re-attach the recorder's ffmpeg          frames are flowing but go2rtc shows no consumer for the stream for
//           (software only, never dry-run gated)     two ticks: the bridge re-registered the stream (DELETE+PUT) and ffmpeg
//                                                    is consuming an orphaned stream object; the new object will dial the
//                                                    camera a second time on the next attach. Re-attaching moves ffmpeg
//                                                    onto the new object and lets the orphan (and its camera session) die.
//                                                    (A hung dial is rung 1 too, but the recorder's own watchdog handles it.)
//   rung 2  camera reboot via the Wyze cloud         down ≥ rebootAfterS, camera answers ping, cooldown + fleet budget ok
//   rung 3  go2rtc restart                           ≥ go2rtcMinCamerasDown cameras down ≥ go2rtcRestartAfterS with a reboot
//                                                    already tried, go2rtc cooldown ok
//   rung 4  alert only                               down ≥ rebootAfterS and the camera does not answer ping (off the network:
//                                                    nothing on the mini can help); once per outage

export interface CamFacts { camera: string; connected: boolean | null; pingOk: boolean | null; framesFresh?: boolean | null; consumers?: number | null }
export interface CamState { downSinceMs: number | null; lastRebootMs: number | null; rebootsThisOutage: number; alertedThisOutage: boolean; orphanTicks?: number; lastReattachMs?: number | null }
export interface LadderConfig {
  rebootAfterS: number; rebootCooldownS: number; fleetRebootsPerHour: number;
  go2rtcRestartAfterS: number; go2rtcMinCamerasDown: number; go2rtcCooldownS: number;
  reattachCooldownS?: number;
}
export type Decision =
  | { rung: 1; action: 'reattach'; camera: string; reason: string }
  | { rung: 2; action: 'camera_reboot'; camera: string; reason: string }
  | { rung: 3; action: 'go2rtc_restart'; camera: string; reason: string; cameras: string[] }
  | { rung: 4; action: 'alert'; camera: string; reason: string };

export const DEFAULTS: LadderConfig = { rebootAfterS: 600, rebootCooldownS: 1800, fleetRebootsPerHour: 2, go2rtcRestartAfterS: 900, go2rtcMinCamerasDown: 3, go2rtcCooldownS: 3600, reattachCooldownS: 120 };

/** Advance a camera's state with a new fact. Returns the transition, if any. */
export function advance(state: CamState, f: CamFacts, nowMs: number): 'went_down' | 'came_back' | null {
  if (f.connected === true) {
    if (state.downSinceMs !== null) { state.downSinceMs = null; state.rebootsThisOutage = 0; state.alertedThisOutage = false; return 'came_back'; }
    return null;
  }
  if (f.connected === false && state.downSinceMs === null) { state.downSinceMs = nowMs; return 'went_down'; }
  return null;
}

export function decide(nowMs: number, facts: CamFacts[], states: Map<string, CamState>, fleetRebootTimesMs: number[], lastGo2rtcRestartMs: number | null, cfg: LadderConfig = DEFAULTS): Decision[] {
  const out: Decision[] = [];
  const recentReboots = fleetRebootTimesMs.filter((t) => nowMs - t < 3600e3).length;
  let budget = Math.max(0, cfg.fleetRebootsPerHour - recentReboots);
  const downLong: string[] = [];
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
    if (downS < cfg.rebootAfterS) continue;
    if (f.pingOk === false) {
      if (!s.alertedThisOutage) { s.alertedThisOutage = true; out.push({ rung: 4, action: 'alert', camera: f.camera, reason: `down ${Math.round(downS)} s and not answering ping: off the network, nothing on the mini can help` }); }
      continue;
    }
    if (f.pingOk !== true) continue;   // no ping fact yet: wait
    const cooled = s.lastRebootMs === null || nowMs - s.lastRebootMs >= cfg.rebootCooldownS * 1000;
    if (cooled && budget > 0) {
      budget--; s.lastRebootMs = nowMs; s.rebootsThisOutage++;
      out.push({ rung: 2, action: 'camera_reboot', camera: f.camera, reason: `down ${Math.round(downS)} s, answers ping, re-attach did not help; reboot via Wyze cloud (${s.rebootsThisOutage} this outage, fleet ${recentReboots + 1}/${cfg.fleetRebootsPerHour} per hour)` });
    }
    if (downS >= cfg.go2rtcRestartAfterS && s.rebootsThisOutage >= 1) downLong.push(f.camera);
  }
  if (downLong.length >= cfg.go2rtcMinCamerasDown && (lastGo2rtcRestartMs === null || nowMs - lastGo2rtcRestartMs >= cfg.go2rtcCooldownS * 1000)) {
    out.push({ rung: 3, action: 'go2rtc_restart', camera: downLong[0]!, cameras: downLong, reason: `${downLong.length} cameras down ≥ ${cfg.go2rtcRestartAfterS} s after a reboot each: restarting go2rtc (all cameras redial once)` });
  }
  return out;
}
