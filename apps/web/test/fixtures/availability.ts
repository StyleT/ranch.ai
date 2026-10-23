// Deterministic 24 h availability for the fixture daemon and the MSW handlers: one outage per camera at a fixed hour,
// mops_cam down for the last hour, wash_stall perfect. Same shape as the daemon's /api/availability.
export function makeAvailability(cameras: string[], untilMs: number, bucketS: number, only?: string | null) {
  const sinceMs = untilMs - 86400e3; const b = bucketS * 1000; const perBucket = Math.max(1, Math.round(bucketS / 15));
  return cameras.filter((c) => !only || c === only).map((camera, i) => {
    const outageAt = sinceMs + (3 + i * 2) * 3600e3; const outageLen = (i + 1) * 180e3;   // 3 min, 6 min, …
    const downTail = camera === 'mops_cam' ? untilMs - 3600e3 : null;
    const series: { ts: string; connected: number; total: number }[] = [];
    let connected = 0, samples = 0;
    for (let k = Math.floor(sinceMs / b) * b; k <= untilMs; k += b) {
      const down = camera === 'wash_stall' ? 0 : Math.round(Math.max(0, Math.min(k + b, outageAt + outageLen) - Math.max(k, outageAt)) / 15e3) + (downTail !== null && k + b > downTail ? Math.round(Math.min(b, k + b - Math.max(k, downTail)) / 15e3) : 0);
      const up = Math.max(0, perBucket - down); series.push({ ts: new Date(k).toISOString(), connected: up, total: perBucket }); connected += up; samples += perBucket;
    }
    const outs = camera === 'wash_stall' ? [] : [outageLen / 1000, ...(downTail !== null ? [3600] : [])];
    return { camera, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), samples, connected_samples: connected, availability: connected / samples,
      outages: outs.length, outage_p50_s: outs.length ? outs[0]! : null, outage_p90_s: outs.length ? outs[outs.length - 1]! : null, outage_max_s: outs.length ? Math.max(...outs) : null,
      down_since: downTail !== null ? new Date(downTail).toISOString() : null, series };
  });
}
