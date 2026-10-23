// Deterministic supervisor ledger for the fixture daemon and MSW: tractor_cam had an outage with a dry-run reboot that
// recovered; mops_cam is down now with an alert (not pinging). Same shape as the daemon's /api/remediation.
export function makeRemediation(untilMs: number, camera?: string | null) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = [
    { id: 4, ts: iso(untilMs - 50 * 60e3), camera: 'mops_cam', rung: 4, action: 'alert' as const, reason: 'down 610 s and not answering ping: off the network, nothing on the mini can help', dry_run: false, outcome: null, outcome_ts: null, recovered_after_s: null },
    { id: 3, ts: iso(untilMs - 60 * 60e3), camera: 'mops_cam', rung: 0, action: 'down' as const, reason: 'no camera session (ping failing, live playlist age 42 s)', dry_run: false, outcome: null, outcome_ts: null, recovered_after_s: null },
    { id: 2, ts: iso(untilMs - 3 * 3600e3 + 600e3), camera: 'tractor_cam', rung: 2, action: 'camera_reboot' as const, reason: 'down 600 s, answers ping, re-attach did not help; reboot via Wyze cloud (1 this outage, fleet 1/2 per hour)', dry_run: true, outcome: 'recovered', outcome_ts: iso(untilMs - 3 * 3600e3 + 780e3), recovered_after_s: 180 },
    { id: 1, ts: iso(untilMs - 3 * 3600e3), camera: 'tractor_cam', rung: 0, action: 'down' as const, reason: 'no camera session (ping ok, live playlist age 61 s)', dry_run: false, outcome: 'recovered', outcome_ts: iso(untilMs - 3 * 3600e3 + 780e3), recovered_after_s: 780 },
  ];
  return rows.filter((r) => !camera || r.camera === camera);
}
