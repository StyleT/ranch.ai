import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteTracker, gateClip, linearAssignment } from '../src/bytetrack.ts';
import type { Pred } from '../src/score.ts';

const box = (x: number, y: number, c = 0.9, label = 'horse', w = 0.1, h = 0.1): Pred => ({
  label,
  confidence: c,
  x,
  y,
  w,
  h,
});

test('linear assignment picks the minimum-cost pairing and respects the threshold', () => {
  const r = linearAssignment(
    [
      [0.1, 0.9, 0.95],
      [0.8, 0.2, 0.9],
    ],
    0.5,
  );
  assert.deepEqual(r.matches.sort(), [
    [0, 0],
    [1, 1],
  ]);
  assert.deepEqual(r.uRows, []);
  assert.deepEqual(r.uCols, [2]);
  const none = linearAssignment([[0.9]], 0.5);
  assert.deepEqual(none, { matches: [], uRows: [0], uCols: [0] });
});

test('one object moving steadily keeps one track id; a flicker gets its own short track', () => {
  const t = new ByteTracker();
  const ids = new Set<number>();
  for (let f = 0; f < 20; f++) {
    const dets = [box(0.1 + f * 0.01, 0.5)];
    if (f === 5) {
      dets.push(box(0.8, 0.8, 0.6)); // one-frame flicker elsewhere
    }
    for (const b of t.update(dets)) {
      if (b.x < 0.5) {
        ids.add(b.track_id);
      }
    }
  }
  assert.equal(ids.size, 1);
  const s = t.summary();
  const mover = s.find((x) => x.frames === 20)!;
  assert.equal(mover.max_streak, 20);
  assert.ok(s.some((x) => x.frames === 1)); // the flicker
});

test('a one-frame miss breaks the streak but not the track; a low-confidence box is recovered in stage 2', () => {
  const t = new ByteTracker();
  for (let f = 0; f < 12; f++) {
    const dets = f === 6 ? [] : [box(0.3 + f * 0.005, 0.3)];
    t.update(dets);
  }
  const s = t.summary();
  assert.equal(s.length, 1); // the track survived the miss (lost for a frame, then re-found)
  assert.equal(s[0]!.frames, 11);
  assert.equal(s[0]!.max_streak, 6);

  const t2 = new ByteTracker();
  t2.update([box(0.3, 0.3)]);
  t2.update([box(0.305, 0.3)]);
  const low = t2.update([box(0.31, 0.3, 0.15)]); // between track_low_thresh 0.1 and track_high_thresh 0.25
  assert.equal(low.length, 1); // stage 2 attached it to the tracked track
  assert.equal(t2.summary()[0]!.frames, 3);
  const t3 = new ByteTracker();
  assert.equal(t3.update([box(0.3, 0.3, 0.15)]).length, 0); // a low box alone starts nothing
});

test('gateClip keeps every box of a qualified track and drops every box of the others', () => {
  const frames = Array.from({ length: 20 }, (_, f) => ({
    frame_no: f,
    detections: [
      box(0.1 + f * 0.005, 0.2), // persists 20 frames -> qualified at N = 10 and 15
      ...(f >= 3 && f <= 5 ? [box(0.7, 0.7, 0.8, 'person')] : []), // 3 frames -> dropped
      ...(f >= 8 && f <= 19 && f !== 14 ? [box(0.5, 0.8, 0.9, 'dog')] : []), // 11 frames with a miss at 14: streaks 6 and 5
    ],
  }));
  const g10 = gateClip(frames, 10);
  const kept10 = g10.frames.flatMap((f) => f.detections.map((d) => d.label));
  assert.equal(kept10.filter((l) => l === 'horse').length, 20); // the first 9 frames before it qualified are kept too
  assert.equal(kept10.filter((l) => l === 'person').length, 0);
  assert.equal(kept10.filter((l) => l === 'dog').length, 0); // consecutive matched frames, not track length
  assert.equal(g10.qualified.size, 1);
  assert.ok(g10.frames[0]!.detections[0]!.track_len === 20);
  const g5 = gateClip(frames, 5);
  assert.equal(g5.frames.flatMap((f) => f.detections).filter((d) => d.label === 'dog').length, 11); // both runs reach 5
  assert.equal(g5.frames.flatMap((f) => f.detections).filter((d) => d.label === 'person').length, 0);
});
