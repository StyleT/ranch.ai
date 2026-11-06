// Deterministic clips pipeline for the fixture daemon and MSW, relative to `nowMs`: every camera's ring is fresh and
// cutting clips except mops_cam, whose ring stopped 95 s ago (the "bad" tone: input stalled). Same shape as the
// daemon's /api/clips/summary.
const CAMERAS = [
  'back_pasture_cam',
  'back_yard_cam',
  'donkey_cam',
  'front_porch_cam',
  'mops_cam',
  'tractor_cam',
  'wash_stall',
];

export function makeClipsSummary(nowMs: number) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const funnel = (camera: string, candidates: number, cut: number, last_cut_ts: string | null) => ({
    camera,
    candidates,
    cut,
    single: candidates - cut,
    global: 0,
    stale: 0,
    open: 0,
    last_cut_ts,
  });
  return {
    ts: iso(nowMs),
    cameras: CAMERAS.map((camera, i) => {
      const stalled = camera === 'mops_cam';
      const lastCut = stalled ? null : iso(nowMs - (i + 1) * 10 * 60e3);
      return {
        camera,
        ring_age_s: stalled ? 95 : 3,
        motion_max: stalled ? 0 : 0.12,
        h1: funnel(camera, stalled ? 0 : 3, stalled ? 0 : 1, lastCut),
        h24: funnel(camera, stalled ? 4 : 40, stalled ? 0 : 12, lastCut),
      };
    }),
    open_oldest_s: null,
    detector: { inflight: 0, processed: 5000, dropped: 0 },
  };
}
