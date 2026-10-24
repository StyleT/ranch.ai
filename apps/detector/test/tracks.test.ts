import { test } from 'node:test';
import assert from 'node:assert/strict';
import { associate, isStable, isMoving, MOVING_MIN } from '../src/tracks.ts';

const box = (id: number, label: string, x: number, y: number, confidence = 0.9, w = 0.1, h = 0.2) => ({ id, label, confidence, x, y, w, h });
const IOU = { gate: 'iou' as const }, DIST = { gate: 'dist' as const, dist: 2 };

for (const [name, opts] of [['iou', IOU], ['dist', DIST]] as const) {
  test(`${name}: a box that stays put is stable and not moving; a slow drift is moving; a one-frame box is neither`, () => {
    const frames = [
      { id: 1, dets: [box(1, 'person', 0.50, 0.20), box(2, 'horse', 0.10, 0.60), box(3, 'dog', 0.80, 0.80)] },
      { id: 2, dets: [box(4, 'person', 0.50, 0.20), box(5, 'horse', 0.13, 0.60)] },
      { id: 3, dets: [box(6, 'person', 0.50, 0.20), box(7, 'horse', 0.16, 0.60)] },
    ];
    const tracks = associate(frames, opts);
    const by = Object.fromEntries(tracks.map((t) => [t.label, t]));
    assert.equal(tracks.length, 3);
    assert.deepEqual(by.person!.ids, [1, 4, 6]); assert.ok(isStable(by.person!)); assert.ok(!isMoving(by.person!)); assert.equal(by.person!.dx, 0);
    assert.deepEqual(by.horse!.ids, [2, 5, 7]); assert.ok(isMoving(by.horse!)); assert.ok(Math.abs(by.horse!.dx - 0.06) < 1e-6); assert.ok(0.06 >= MOVING_MIN);
    assert.deepEqual(by.dog!.ids, [3]); assert.ok(!isStable(by.dog!));
  });

  test(`${name}: the same place under a different label is a different track; a far jump starts a new track`, () => {
    const tracks = associate([
      { id: 1, dets: [box(1, 'person', 0.5, 0.2), box(2, 'horse', 0.5, 0.2)] },
      { id: 2, dets: [box(3, 'person', 0.5, 0.2), box(4, 'horse', 0.9, 0.9)] },   // horse jumps 0.81 of the frame: 4 box sides
    ], opts);
    assert.equal(tracks.length, 3);
    assert.deepEqual(tracks.find((t) => t.label === 'person')!.ids, [1, 3]);
    assert.deepEqual(tracks.filter((t) => t.label === 'horse').map((t) => t.ids), [[2], [4]]);
  });
}

test('a walking person (no overlap between consecutive boxes) fragments under the iou gate and is followed under the dist gate', () => {
  // a person 0.05 wide, 0.15 tall, moving 0.12 of the frame per second: the labeled median on the ranch cameras
  const walk = [
    { id: 1, dets: [box(1, 'person', 0.20, 0.50, 0.9, 0.05, 0.15)] },
    { id: 2, dets: [box(2, 'person', 0.32, 0.50, 0.9, 0.05, 0.15)] },
    { id: 3, dets: [box(3, 'person', 0.44, 0.50, 0.9, 0.05, 0.15)] },
  ];
  const old = associate(walk, IOU);
  assert.equal(old.length, 3); assert.ok(old.every((t) => !isStable(t)), 'iou gate: three one-frame tracks');
  const now = associate(walk, DIST);
  assert.equal(now.length, 1); assert.deepEqual(now[0]!.ids, [1, 2, 3]); assert.ok(isStable(now[0]!)); assert.ok(isMoving(now[0]!));
  assert.ok(Math.abs(now[0]!.dx - 0.24) < 1e-6);
});

test('dist gate: a distant small box is not linked to a near large one of the same label, and two still objects keep their own tracks', () => {
  const tracks = associate([
    { id: 1, dets: [box(1, 'horse', 0.10, 0.10, 0.9, 0.04, 0.04), box(2, 'horse', 0.60, 0.60, 0.9, 0.30, 0.30)] },
    { id: 2, dets: [box(3, 'horse', 0.60, 0.60, 0.9, 0.30, 0.30), box(4, 'horse', 0.10, 0.10, 0.9, 0.04, 0.04)] },
  ], DIST);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.ids).sort(), [[1, 4], [2, 3]]);
  assert.ok(tracks.every((t) => !isMoving(t)));
});

test('a track keeps the highest confidence of its boxes and the raw label of its first box', () => {
  const tracks = associate([
    { id: 1, dets: [{ ...box(1, 'horse', 0.2, 0.2, 0.4), raw_label: 'cow' }] },
    { id: 2, dets: [{ ...box(2, 'horse', 0.2, 0.2, 0.8), raw_label: 'horse' }] },
  ]);
  assert.equal(tracks.length, 1); assert.equal(tracks[0]!.confidence, 0.8); assert.equal(tracks[0]!.raw_label, 'cow');
});
