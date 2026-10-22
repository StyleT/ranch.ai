import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, parseSince, detectionsDiffer } from '../src/index.ts';

test('migrates an empty database and round-trips frames, detections and events', () => {
  const s = new EventStore(':memory:');
  assert.equal(s.schemaVersion, 5);
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

test('retention: change and moved boxes survive; floor frames with the same picture and detections go', () => {
  const s = new EventStore(':memory:');
  const t0 = Date.parse('2026-10-19T00:00:00Z');
  const add = (sec: number, reason: 'floor' | 'change', dets: { label: string; x: number }[] = []) => {
    const ts = new Date(t0 + sec * 1000).toISOString();
    const id = s.insertFrame({ ts, camera: 'cam', path: `/f/${sec}.jpg`, reason });
    s.insertDetections(id, dets.map((d) => ({ model: 'm', label: d.label, confidence: 0.9, x: d.x, y: 0.1, w: 0.1, h: 0.1 })));
    return id;
  };
  add(0, 'floor');                                   // nothing before it, nothing detected: deleted (time alone keeps nothing)
  add(10, 'floor');                                  // identical -> deleted
  add(20, 'floor', [{ label: 'horse', x: 0.5 }]);    // new label -> kept
  add(30, 'floor', [{ label: 'horse', x: 0.5 }]);    // same box -> deleted
  add(40, 'floor', [{ label: 'horse', x: 0.7 }]);    // box moved -> kept
  add(50, 'change', [{ label: 'horse', x: 0.7 }]);   // scene changed -> kept
  add(700, 'floor', [{ label: 'horse', x: 0.7 }]);   // ten minutes later, same picture -> deleted
  const r = s.applyRetention({ olderThanMs: 0, now: new Date(t0 + 3600e3) });
  assert.deepEqual(r.paths.sort(), ['/f/0.jpg', '/f/10.jpg', '/f/30.jpg', '/f/700.jpg']);
  assert.equal(r.kept, 3);
  assert.equal(s.frames({ limit: 100 }).filter((f) => f.kept === 1).length, 3);
  assert.equal(s.applyRetention({ olderThanMs: 0, now: new Date(t0 + 3600e3) }).deleted, 0); // second pass: nothing new
  assert.ok(detectionsDiffer([], [{ label: 'a', x: 0, y: 0, w: 1, h: 1 }]));
  assert.ok(!detectionsDiffer([{ label: 'a', x: 0, y: 0, w: 1, h: 1 }], [{ label: 'a', x: 0.01, y: 0, w: 1, h: 1 }]));
  s.close();
});

test('bursts: members ride with the head in listing and retention', () => {
  const s = new EventStore(':memory:');
  const t0 = Date.parse('2026-10-22T00:00:00Z'); const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
  const head = s.insertFrame({ ts: at(0), camera: 'cam', path: '/b/0.jpg', reason: 'change' }); s.markBurstHead(head);
  s.insertFrame({ ts: at(1), camera: 'cam', path: '/b/1.jpg', reason: 'change', burst_id: head, seq: 1 });
  s.insertFrame({ ts: at(2), camera: 'cam', path: '/b/2.jpg', reason: 'change', burst_id: head, seq: 2 });
  const still = s.insertFrame({ ts: at(10), camera: 'cam', path: '/b/10.jpg', reason: 'floor' });   // detections changed (horse gone): kept
  s.insertFrame({ ts: at(20), camera: 'cam', path: '/b/20.jpg', reason: 'floor' });                  // same as the previous kept: deleted
  const ids = s.insertDetections(head, [{ model: 'm', label: 'horse', confidence: 0.9, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
  s.updateTrack(ids[0]!, { track: 1, seen: 3, dx: 0.05, dy: 0 });
  const list = s.framesWithDetections({ limit: 10 });
  assert.deepEqual(list.map((f) => f.id).slice(1), [still, head]);  // members are not listed on their own
  assert.equal(list[2]!.burst.length, 2);
  assert.equal(s.framesWithDetections({ moving: true, limit: 10 }).length, 1);
  const r = s.applyRetention({ olderThanMs: 0, now: new Date(t0 + 3600e3) });
  assert.equal(r.kept, 2); assert.deepEqual(r.paths.sort(), ['/b/20.jpg']);
  assert.equal(s.burstMembers(head).length, 3);                      // head + 2 members survive together
  s.close();
});
