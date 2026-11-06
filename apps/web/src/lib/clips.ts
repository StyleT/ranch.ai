// The clips-pipeline indicator (docs/CLIPS.md): one tone and the reasons for it, from the daemon's /api/clips/summary.
// The rules are structural (a stage stopped), not rates: a healthy rate has not been measured on a recorder that keeps
// real time, so a rate threshold would encode today's guess.
import type { ClipsSummary } from '@ranch/contracts';

export const RING_STALE_S = 30; // the ring is written per keyframe (2-18 s apart); 30 s matches RANCH_STALE_S
export const NO_CLIP_WARN_S = 6 * 3600;
export const OPEN_WARN_S = 90; // a clip closes at 60 s at the latest (docs/CLIPS.md); 30 s of slack
export const DETECTOR_QUEUE_WARN = 300; // half of the detector's 600-frame queue

export type ClipsTone = 'ok' | 'warn' | 'bad';
export type ClipsHealth = {
  tone: ClipsTone;
  reasons: string[];
  h1: { candidates: number; cut: number };
  summary: ClipsSummary;
};

export function clipsHealth(s: ClipsSummary, nowMs: number): ClipsHealth {
  const reasons: { tone: ClipsTone; text: string }[] = [];
  const stalled = s.cameras.filter((c) => c.ring_age_s === null || c.ring_age_s > RING_STALE_S);
  if (stalled.length) {
    reasons.push({
      tone: 'bad',
      text: `ring input stalled: ${stalled.map((c) => `${c.camera} ${c.ring_age_s === null ? 'none' : `${c.ring_age_s} s`}`).join(', ')}`,
    });
  }
  const lastCut = Math.max(...s.cameras.map((c) => (c.h24.last_cut_ts ? Date.parse(c.h24.last_cut_ts) : 0)), 0);
  const candidates24 = s.cameras.reduce((n, c) => n + c.h24.candidates, 0);
  if (candidates24 > 0 && nowMs - lastCut > NO_CLIP_WARN_S * 1000) {
    reasons.push({
      tone: 'warn',
      text: `no clip cut in ${lastCut ? `${Math.round((nowMs - lastCut) / 3600e3)} h` : 'the record'} while ${candidates24} candidates in 24 h`,
    });
  }
  if (s.open_oldest_s !== null && s.open_oldest_s > OPEN_WARN_S) {
    reasons.push({ tone: 'warn', text: `a clip open for ${s.open_oldest_s} s (closes at 60 s)` });
  }
  if (s.detector.inflight !== null && s.detector.inflight > DETECTOR_QUEUE_WARN) {
    reasons.push({ tone: 'warn', text: `detector queue ${s.detector.inflight} frames` });
  }
  return {
    tone: reasons.some((r) => r.tone === 'bad') ? 'bad' : reasons.length ? 'warn' : 'ok',
    reasons: reasons.map((r) => r.text),
    h1: {
      candidates: s.cameras.reduce((n, c) => n + c.h1.candidates, 0),
      cut: s.cameras.reduce((n, c) => n + c.h1.cut, 0),
    },
    summary: s,
  };
}
