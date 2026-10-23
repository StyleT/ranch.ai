import { describe, it, expect } from 'vitest';
import { deriveLiveState, parsePlaylist, retryDelayMs, badgeText, playlistAgeNow, OFFLINE_AFTER_S, STALL_AFTER_S, STARTING_GRACE_S } from './liveState';

const T0 = Date.parse('2026-10-23T18:00:00.000Z');
const base = { nowMs: T0 + 5_000, visible: true, startedMs: T0, playlistAgeS: 1, playlistPolledMs: T0 + 4_000, edgeGapS: 1.5, lastProgressMs: T0 + 4_500, error: false };

describe('deriveLiveState', () => {
  it('is paused when the page is hidden, whatever else is true', () => {
    expect(deriveLiveState({ ...base, visible: false }).kind).toBe('paused');
  });
  it('is live with latency = recorder write age (extrapolated) + playhead distance to the buffered edge', () => {
    expect(deriveLiveState(base)).toEqual({ kind: 'live', latencyS: 3.5 });   // age 1 s + 1 s since the poll + 1.5 s gap
  });
  it('reports LIVE without a number when the edge is unknown', () => {
    expect(deriveLiveState({ ...base, edgeGapS: null })).toEqual({ kind: 'live', latencyS: null });
  });
  it('is starting during the grace period before the first frame, then stalled', () => {
    const f = { ...base, lastProgressMs: null };
    expect(deriveLiveState({ ...f, nowMs: T0 + 3_000 }).kind).toBe('starting');
    expect(deriveLiveState({ ...f, nowMs: T0 + (STARTING_GRACE_S + 1) * 1000, playlistPolledMs: T0 + STARTING_GRACE_S * 1000 }).kind).toBe('stalled');
  });
  it('is stalled when playback stops advancing but the recorder keeps writing', () => {
    const s = deriveLiveState({ ...base, nowMs: base.lastProgressMs! + (STALL_AFTER_S + 1) * 1000, playlistPolledMs: base.lastProgressMs! + STALL_AFTER_S * 1000, playlistAgeS: 1 });
    expect(s.kind).toBe('stalled');
  });
  it('shows connecting, not offline, while the on-demand encoder spins up (playlist 404, within grace, never played)', () => {
    const f = { ...base, lastProgressMs: null, playlistAgeS: 999, playlistPolledMs: T0 + 2_000, nowMs: T0 + 3_000 };
    expect(deriveLiveState(f).kind).toBe('starting');
    expect(deriveLiveState({ ...f, nowMs: T0 + (STARTING_GRACE_S + 1) * 1000, playlistPolledMs: T0 + STARTING_GRACE_S * 1000 }).kind).toBe('offline');
  });
  it('is offline when the playlist is stale, even if the last frames are still "playing" from the buffer', () => {
    const s = deriveLiveState({ ...base, playlistAgeS: OFFLINE_AFTER_S + 5 });
    expect(s.kind).toBe('offline');
    if (s.kind === 'offline') expect(base.nowMs - s.sinceMs).toBeGreaterThan(OFFLINE_AFTER_S * 1000);
  });
  it('extrapolates the playlist age from the last poll', () => {
    expect(playlistAgeNow({ nowMs: T0, playlistAgeS: 20, playlistPolledMs: T0 - 15_000 })).toBe(35);
    expect(deriveLiveState({ ...base, playlistAgeS: 20, playlistPolledMs: T0 - 15_000 }).kind).toBe('offline');
  });
  it('a fatal player error with a fresh playlist is a stall, not an outage', () => {
    expect(deriveLiveState({ ...base, error: true }).kind).toBe('stalled');
  });
});

describe('parsePlaylist', () => {
  const pl = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:40', '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:1.000000,', 'seg000040.m4s', '#EXT-X-DISCONTINUITY', '#EXTINF:1.000000,', 'seg000041.m4s', ''].join('\n');
  it('returns the segment count, media sequence and target duration', () => {
    expect(parsePlaylist(pl)).toEqual({ targetDurationS: 1, segments: 2, mediaSequence: 40 });
  });
  it('tolerates a minimal playlist', () => {
    expect(parsePlaylist('#EXTM3U\n#EXTINF:2,\nseg000000.m4s\n')).toEqual({ targetDurationS: null, segments: 1, mediaSequence: null });
  });
});

describe('retry and badge', () => {
  it('backs off 5 → 60 s', () => { expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]); });
  it('words the state honestly', () => {
    expect(badgeText({ kind: 'live', latencyS: 3.8 }, T0)).toBe('LIVE · 3.8 s');
    expect(badgeText({ kind: 'offline', sinceMs: T0 - 41_000 }, T0)).toBe('camera reconnecting · 41 s');
    expect(badgeText({ kind: 'offline', sinceMs: T0 - 300_000 }, T0)).toBe('camera reconnecting · 5 min');
    expect(badgeText({ kind: 'stalled', sinceMs: T0 - 9_000 }, T0)).toBe('buffering · 9 s');
  });
});
