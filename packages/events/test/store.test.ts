import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, parseSince } from '../src/index.ts';

test('migrates an empty database and round-trips frames, detections and events', () => {
  const s = new EventStore(':memory:');
  assert.equal(s.schemaVersion, 1);
  const fid = s.insertFrame({ ts: '2026-10-15T00:00:00.000Z', camera: 'front_porch_cam', path: '/x/a.jpg', reason: 'floor', change: 0.01 });
  s.insertDetections(fid, [{ model: 'yolo11n', label: 'horse', confidence: 0.9, x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
  assert.equal(s.detectionsForFrame(fid)[0]?.label, 'horse');
  const id = s.insertEvent({ ts: '2026-10-15T00:00:01.000Z', camera: 'front_porch_cam', type: 'gate_open', confidence: 0.7, tier_decided: 1, evidence_frames: ['/x/a.jpg'] });
  const [e] = s.events({ since: '2026-10-14T00:00:00Z' });
  assert.equal(e?.id, id);
  assert.deepEqual(e?.evidence_frames, ['/x/a.jpg']);
  assert.equal(e?.verdict, null);
  assert.ok(s.setVerdict(id, 'false_positive'));
  assert.equal(s.event(id.slice(0, 8))?.verdict, 'false_positive');
  assert.equal(s.events({ verdict: 'none' }).length, 0);
  s.upsertCameraCount({ ts: '2026-10-15T00:00:00Z', camera: 'c', label: 'horse', count: 2, model: 'm' });
  s.upsertCameraCount({ ts: '2026-10-15T00:00:00Z', camera: 'c', label: 'horse', count: 3, model: 'm' });
  assert.equal(s.cameraCounts()[0]?.count, 3);
  s.close();
});

test('parseSince', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  assert.equal(parseSince('24h', now), '2026-10-14T12:00:00.000Z');
  assert.equal(parseSince('90m', now), '2026-10-15T10:30:00.000Z');
  assert.equal(parseSince('2026-10-01T00:00:00Z', now), '2026-10-01T00:00:00.000Z');
  assert.throws(() => parseSince('yesterday', now));
});
