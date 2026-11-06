import { describe, it, expect } from 'vitest';
import type { ClipsSummary } from '@ranch/contracts';
import { clipsHealth } from './clips';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const funnel = (camera: string, o: Partial<ClipsSummary['cameras'][number]['h1']> = {}) => ({
  camera,
  candidates: 0,
  cut: 0,
  single: 0,
  global: 0,
  stale: 0,
  open: 0,
  last_cut_ts: null,
  ...o,
});
const cam = (camera: string, ring_age_s: number | null, h24 = {}, h1 = {}) => ({
  camera,
  ring_age_s,
  motion_max: 0.1,
  h1: funnel(camera, h1),
  h24: funnel(camera, h24),
});
const summary = (o: Partial<ClipsSummary> = {}): ClipsSummary => ({
  ts: '2026-11-06T12:00:00.000Z',
  cameras: [
    cam('a', 4, { candidates: 10, cut: 3, last_cut_ts: '2026-11-06T11:30:00.000Z' }, { candidates: 2, cut: 1 }),
    cam('b', 9, { candidates: 5, cut: 1, last_cut_ts: '2026-11-06T02:00:00.000Z' }, { candidates: 1 }),
  ],
  open_oldest_s: null,
  detector: { inflight: 0, processed: 100, dropped: 0 },
  ...o,
});

describe('clipsHealth', () => {
  it('is ok when every stage moves, and totals the last hour', () => {
    const h = clipsHealth(summary(), NOW);
    expect(h.tone).toBe('ok');
    expect(h.reasons).toEqual([]);
    expect(h.h1).toEqual({ candidates: 3, cut: 1 });
  });

  it('is bad when a camera ring stops or never wrote, whatever else holds', () => {
    const s = summary();
    s.cameras[0]!.ring_age_s = 95;
    s.cameras[1]!.ring_age_s = null;
    const h = clipsHealth(s, NOW);
    expect(h.tone).toBe('bad');
    expect(h.reasons[0]).toBe('ring input stalled: a 95 s, b none');
  });

  it('warns when candidates keep coming but no clip was cut for 6 h', () => {
    const s = summary();
    for (const c of s.cameras) {
      c.h24.last_cut_ts = '2026-11-06T04:00:00.000Z';
    }
    const h = clipsHealth(s, NOW);
    expect(h.tone).toBe('warn');
    expect(h.reasons).toEqual(['no clip cut in 8 h while 15 candidates in 24 h']);
  });

  it('does not warn about missing clips when nothing moved', () => {
    const s = summary();
    for (const c of s.cameras) {
      Object.assign(c.h24, { candidates: 0, cut: 0, last_cut_ts: null });
    }
    expect(clipsHealth(s, NOW).tone).toBe('ok');
  });

  it('warns on a clip open past its 60 s cap and on a deep detector queue', () => {
    const h = clipsHealth(summary({ open_oldest_s: 120, detector: { inflight: 450, processed: 1, dropped: 0 } }), NOW);
    expect(h.tone).toBe('warn');
    expect(h.reasons).toEqual(['a clip open for 120 s (closes at 60 s)', 'detector queue 450 frames']);
  });
});
