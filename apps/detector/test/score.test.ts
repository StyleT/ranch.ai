import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classMetrics, fppf, countAccuracy, operatingPoints, bootstrap, iou, type Scored } from '../src/score.ts';

const fr = (camera: string, period: string, gold: Scored['gold'], pred: Scored['pred']): Scored => ({ frame: { path: camera + period, camera, period }, gold, pred });
const b = (label: string, x: number, c = 0.9) => ({ label, x, y: 0.1, w: 0.2, h: 0.2, confidence: c });

test('matching, precision/recall, AP, FPPF, counts', () => {
  const frames: Scored[] = [
    fr('a', 'day', [b('horse', 0.1), b('horse', 0.5)], [b('horse', 0.1, 0.9), b('horse', 0.52, 0.8), b('bench', 0.7, 0.95)]),
    fr('a', 'night', [b('horse', 0.3)], [b('horse', 0.8, 0.6)]),
  ];
  const h = classMetrics(frames, 'horse', 0.5, 0.5);
  assert.equal(h.gold, 3); assert.equal(h.tp, 2); assert.equal(h.fp, 1); assert.equal(h.fn, 1);
  assert.ok(Math.abs(h.recall - 2 / 3) < 1e-9 && Math.abs(h.precision - 2 / 3) < 1e-9);
  assert.ok(h.ap > 0.6 && h.ap <= 0.67);
  assert.equal(fppf(frames, 0.5, 0.5), 1); // bench + the wrong horse, over 2 frames
  assert.equal(fppf(frames, 0.5, 0.5, ['horse']), 0.5);
  const c = countAccuracy(frames, 0.5); assert.equal(c.exact, 1); assert.equal(c.mae, 0); // counts ignore position: the misplaced night horse still counts as one
  const op = operatingPoints(frames, 0.5); assert.ok(op.r_at_p90.recall >= 0);
  const ci = bootstrap(frames, (s) => classMetrics(s, 'horse', 0.5, 0.5).recall, 200); assert.ok(ci.lo <= ci.hi);
  assert.ok(Math.abs(iou({ label: '', x: 0, y: 0, w: 1, h: 1 }, { label: '', x: 0.5, y: 0, w: 1, h: 1 }) - 1 / 3) < 1e-9);
});
