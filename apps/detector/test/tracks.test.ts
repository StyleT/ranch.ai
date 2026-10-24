import { test } from 'node:test';
import assert from 'node:assert/strict';
import { associate, isStable, isMoving, MOVING_MIN } from '../src/tracks.ts';

const box = (id: number, label: string, x: number, y: number, confidence = 0.9) => ({ id, label, confidence, x, y, w: 0.1, h: 0.2 });

test('a box that stays put is stable and not moving; one that drifts is moving; a one-frame box is neither', () => {
  const frames = [
    { id: 1, dets: [box(1, 'person', 0.50, 0.20), box(2, 'horse', 0.10, 0.60), box(3, 'dog', 0.80, 0.80)] },
    { id: 2, dets: [box(4, 'person', 0.50, 0.20), box(5, 'horse', 0.13, 0.60)] },
    { id: 3, dets: [box(6, 'person', 0.50, 0.20), box(7, 'horse', 0.16, 0.60)] },
  ];
  const tracks = associate(frames);
  const by = Object.fromEntries(tracks.map((t) => [t.label, t]));
  assert.equal(tracks.length, 3);
  assert.deepEqual(by.person!.ids, [1, 4, 6]); assert.equal(by.person!.seen, 3);
  assert.ok(isStable(by.person!)); assert.ok(!isMoving(by.person!)); assert.equal(by.person!.dx, 0); assert.equal(by.person!.dy, 0);
  assert.deepEqual(by.horse!.ids, [2, 5, 7]); assert.ok(isStable(by.horse!)); assert.ok(isMoving(by.horse!));
  assert.ok(Math.abs(by.horse!.dx - 0.06) < 1e-6, `dx ${by.horse!.dx}`); assert.ok(0.06 >= MOVING_MIN);
  assert.deepEqual(by.dog!.ids, [3]); assert.ok(!isStable(by.dog!)); assert.ok(!isMoving(by.dog!));
});

test('the same place under a different label is a different track; a jump beyond the IoU gate starts a new track', () => {
  const frames = [
    { id: 1, dets: [box(1, 'person', 0.5, 0.2), box(2, 'horse', 0.5, 0.2)] },
    { id: 2, dets: [box(3, 'person', 0.5, 0.2), box(4, 'horse', 0.9, 0.9)] },
  ];
  const tracks = associate(frames);
  assert.equal(tracks.length, 3);
  assert.deepEqual(tracks.find((t) => t.label === 'person')!.ids, [1, 3]);
  assert.deepEqual(tracks.filter((t) => t.label === 'horse').map((t) => t.ids), [[2], [4]]);
});

test('a track keeps the highest confidence of its boxes and the raw label of its first box', () => {
  const tracks = associate([
    { id: 1, dets: [{ ...box(1, 'horse', 0.2, 0.2, 0.4), raw_label: 'cow' }] },
    { id: 2, dets: [{ ...box(2, 'horse', 0.2, 0.2, 0.8), raw_label: 'horse' }] },
  ]);
  assert.equal(tracks.length, 1); assert.equal(tracks[0]!.confidence, 0.8); assert.equal(tracks[0]!.raw_label, 'cow');
});
