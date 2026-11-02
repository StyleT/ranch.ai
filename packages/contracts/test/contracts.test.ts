import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Status, FramesResponse, Ping, parseContract, Tracks, ClipsResponse, FrameHead } from '../src/index.ts';

test('contracts accept a minimal status and reject a broken one', () => {
  const ok = {
    ts: '2026-10-22T12:00:00.000Z',
    host: 'ranch-ai',
    uptime_s: 1,
    load: [1, 1, 1],
    disk_free_gb: 100,
    disk_total_gb: 460,
    buffer: { total: 0, stale_s: 30 },
    daemons: [{ label: 'com.ranch.status', pid: 1, last_exit: 0, log: '' }],
    cameras: [],
    labels_1h: [],
    labels_by_camera_1h: [],
    label_order: ['horse'],
    taxonomy_version: 1,
    taxonomy_matches_repo: true,
    horse_label: 'equine',
    events: [],
    totals: { frames: 0, detections: 0, events: 0 },
    extra_field: 1,
  };
  assert.equal(parseContract(Status, ok, 'status').host, 'ranch-ai');
  assert.throws(() => parseContract(Status, { ...ok, cameras: [{ name: 'x' }] }, 'status'), /cameras\.0\./);
  assert.ok(Ping.safeParse({ ok: true, ts: ok.ts, pid: 1, rss_mb: 10, taxonomy_version: null, api: 1 }).success);
  assert.ok(FramesResponse.safeParse([]).success);
  assert.ok(Tracks.safeParse([]).success);
});

test('clips: the list row and the clip ref on a frame head', () => {
  const clip = {
    id: 31,
    camera: 'back_pasture_cam',
    trigger_ts: '2026-10-22T16:10:05.000Z',
    start_ts: '2026-10-22T16:10:00.000Z',
    end_ts: '2026-10-22T16:10:18.000Z',
    duration_s: 18,
    fps: 15,
    width: 2560,
    height: 1440,
    bytes: 2310441,
    stopped: 'quiet',
    preroll_s: 5,
    expired_at: null,
    labels: ['equine'],
  };
  assert.ok(ClipsResponse.safeParse([clip]).success);
  assert.ok(!ClipsResponse.safeParse([{ ...clip, stopped: 'never' }]).success);
  const head = {
    id: 1,
    ts: clip.start_ts,
    camera: clip.camera,
    path: '/x.jpg',
    width: 1280,
    height: 720,
    bytes: 1,
    change: null,
    reason: 'change',
    kept: null,
    burst_id: 1,
    seq: 0,
    clip_id: 31,
    detections: [],
    burst: [],
  };
  assert.ok(FrameHead.safeParse(head).success); // clip absent: the daemon before 2.4b
  assert.ok(FrameHead.safeParse({ ...head, clip: null }).success);
  assert.ok(FrameHead.safeParse({ ...head, clip: { id: 31, duration_s: 18, stopped: 'quiet' } }).success);
  assert.ok(!FrameHead.safeParse({ ...head, clip: { id: 'x' } }).success);
});
