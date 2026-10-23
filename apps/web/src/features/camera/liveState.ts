// The live view's honest state, derived from facts only (docs/WEB-DASHBOARD.md). No "LIVE" badge over a frozen frame:
// the recorder's playlist age says whether frames are flowing, the video element says whether they are being played.
export type LiveState =
  | { kind: 'paused' }                              // page hidden: the player is torn down
  | { kind: 'starting' }                            // attached, no frame played yet (first STARTING_GRACE_S seconds)
  | { kind: 'live'; latencyS: number | null }       // playing; latency = recorder write age + playhead distance to the buffered edge
  | { kind: 'stalled'; sinceMs: number }            // playlist fresh but playback not advancing (decoder/network on the viewer side)
  | { kind: 'offline'; sinceMs: number };           // the recorder has not written a segment for OFFLINE_AFTER_S: the camera dropped

export const OFFLINE_AFTER_S = 30;   // > list_size × seg_s would mean the playlist is fully stale; 30 s also matches RANCH_STALE_S
export const STALL_AFTER_S = 8;      // playback not advancing for this long while the playlist is fresh
export const STARTING_GRACE_S = 15;

export interface LiveFacts {
  nowMs: number;
  visible: boolean;
  startedMs: number;                 // when the current attach began
  playlistAgeS: number | null;       // x-live-age-s of the last playlist poll (seconds since the recorder rewrote it)
  playlistPolledMs: number | null;   // when that poll happened (the age is extrapolated from it)
  edgeGapS: number | null;           // seconds between the playhead and the end of what the player has buffered
  lastProgressMs: number | null;     // last time the video's currentTime advanced
  error: boolean;                    // a fatal player error since the last attach
}

/** Seconds since the recorder last wrote the playlist, extrapolated from the last poll. */
export const playlistAgeNow = (f: Pick<LiveFacts, 'nowMs' | 'playlistAgeS' | 'playlistPolledMs'>): number | null =>
  f.playlistAgeS === null ? null : f.playlistAgeS + (f.playlistPolledMs === null ? 0 : Math.max(0, f.nowMs - f.playlistPolledMs) / 1000);

export function deriveLiveState(f: LiveFacts): LiveState {
  if (!f.visible) return { kind: 'paused' };
  const ageS = playlistAgeNow(f);
  if (ageS !== null && ageS > OFFLINE_AFTER_S) return { kind: 'offline', sinceMs: f.nowMs - ageS * 1000 };
  const progressing = f.lastProgressMs !== null && f.nowMs - f.lastProgressMs < STALL_AFTER_S * 1000;
  if (progressing && !f.error) {
    // the buffered edge is at most one segment behind what the recorder wrote; what is written is `ageS` old
    const latency = ageS === null || f.edgeGapS === null ? null : Math.round((ageS + Math.max(0, f.edgeGapS)) * 10) / 10;
    return { kind: 'live', latencyS: latency };
  }
  if (f.lastProgressMs === null && !f.error && f.nowMs - f.startedMs < STARTING_GRACE_S * 1000) return { kind: 'starting' };
  return { kind: 'stalled', sinceMs: f.lastProgressMs ?? f.startedMs };
}

/** Segment count and target duration from an HLS media playlist (program-date-time is deliberately not used:
 *  ffmpeg anchors it at muxer start and lets it drift). */
export function parsePlaylist(text: string): { targetDurationS: number | null; segments: number; mediaSequence: number | null } {
  let segments = 0; let target: number | null = null; let seq: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-TARGETDURATION:')) target = Number(line.slice(22)) || null;
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.slice(22));
    else if (line && !line.startsWith('#')) segments++;
  }
  return { targetDurationS: target, segments, mediaSequence: seq };
}

/** Wait before re-attaching after a fatal player error: 5, 10, 20, 40, 60, 60… s. */
export const retryDelayMs = (failures: number): number => Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));

export function badgeText(s: LiveState, nowMs: number): string {
  switch (s.kind) {
    case 'paused': return 'PAUSED';
    case 'starting': return 'connecting…';
    case 'live': return s.latencyS === null ? 'LIVE' : `LIVE · ${s.latencyS.toFixed(1)} s`;
    case 'stalled': return `buffering · ${Math.round((nowMs - s.sinceMs) / 1000)} s`;
    case 'offline': return `camera reconnecting · ${formatSince(nowMs - s.sinceMs)}`;
  }
}
const formatSince = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min`; };
