import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Status, FramesResponse, Ping, parseContract, Tracks } from '../src/index.ts';

test('contracts accept a minimal status and reject a broken one', () => {
  const ok = { ts: '2026-10-22T12:00:00.000Z', host: 'ranch-ai', uptime_s: 1, load: [1, 1, 1], disk_free_gb: 100, disk_total_gb: 460, seed: { total: 0, window_start: null, window_hours: null },
    daemons: [{ label: 'com.ranch.status', pid: 1, last_exit: 0, log: '' }], cameras: [], labels_1h: [], labels_by_camera_1h: [], label_order: ['horse'], taxonomy_version: 1,
    taxonomy_matches_repo: true, horse_label: 'equine', events: [], totals: { frames: 0, detections: 0, events: 0 }, extra_field: 1 };
  assert.equal(parseContract(Status, ok, 'status').host, 'ranch-ai');
  assert.throws(() => parseContract(Status, { ...ok, cameras: [{ name: 'x' }] }, 'status'), /cameras\.0\./);
  assert.ok(Ping.safeParse({ ok: true, ts: ok.ts, pid: 1, rss_mb: 10, taxonomy_version: null, api: 1 }).success);
  assert.ok(FramesResponse.safeParse([]).success);
  assert.ok(Tracks.safeParse([]).success);
});
