import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classMetrics, fppf, countAccuracy, operatingPoints, bootstrap, iou, type Scored } from '../src/score.ts';

const fr = (camera: string, period: string, gold: Scored['gold'], pred: Scored['pred']): Scored => ({
  frame: { path: camera + period, camera, period },
  gold,
  pred,
});
const b = (label: string, x: number, c = 0.9) => ({ label, x, y: 0.1, w: 0.2, h: 0.2, confidence: c });

test('matching, precision/recall, AP, FPPF, counts', () => {
  const frames: Scored[] = [
    fr(
      'a',
      'day',
      [b('horse', 0.1), b('horse', 0.5)],
      [b('horse', 0.1, 0.9), b('horse', 0.52, 0.8), b('bench', 0.7, 0.95)],
    ),
    fr('a', 'night', [b('horse', 0.3)], [b('horse', 0.8, 0.6)]),
  ];
  const h = classMetrics(frames, 'horse', 0.5, 0.5);
  assert.equal(h.gold, 3);
  assert.equal(h.tp, 2);
  assert.equal(h.fp, 1);
  assert.equal(h.fn, 1);
  assert.ok(Math.abs(h.recall - 2 / 3) < 1e-9 && Math.abs(h.precision - 2 / 3) < 1e-9);
  assert.ok(h.ap > 0.6 && h.ap <= 0.67);
  assert.equal(fppf(frames, 0.5, 0.5), 1); // bench + the wrong horse, over 2 frames
  assert.equal(fppf(frames, 0.5, 0.5, ['horse']), 0.5);
  const c = countAccuracy(frames, 0.5);
  assert.equal(c.exact, 1);
  assert.equal(c.mae, 0); // counts ignore position: the misplaced night horse still counts as one
  const op = operatingPoints(frames, 0.5);
  assert.ok(op.r_at_p90.recall >= 0);
  const ci = bootstrap(frames, (s) => classMetrics(s, 'horse', 0.5, 0.5).recall, 200);
  assert.ok(ci.lo <= ci.hi);
  assert.ok(
    Math.abs(iou({ label: '', x: 0, y: 0, w: 1, h: 1 }, { label: '', x: 0.5, y: 0, w: 1, h: 1 }) - 1 / 3) < 1e-9,
  );
});

import {
  attributeAgreement,
  clipLevel,
  interpolateGold,
  recallByGoldGroup,
  sizeBucket,
  postureGroup,
  throughput,
  scoreSet,
} from '../src/score.ts';

const cf = (
  clip: number,
  t: number,
  gold: Scored['gold'],
  pred: Scored['pred'],
  extra: Partial<Scored['frame']> = {},
): Scored => ({
  frame: {
    path: `c${clip}-${t}`,
    camera: 'cam',
    period: 'day',
    clip_id: clip,
    t_s: t,
    width: 2560,
    height: 1440,
    ...extra,
  },
  gold,
  pred,
});

test('bootstrap resamples clips, not frames, when every frame has a clip_id', () => {
  // clip 1: perfect; clip 2: every horse missed. Frame-level resampling would spread recall over 0..1 in fine steps;
  // clip-level resampling can only produce 0, 0.5 or 1 (two clips of equal gold count).
  const frames = [
    ...[0, 1, 2, 3].map((t) => cf(1, t, [b('horse', 0.1)], [b('horse', 0.1)])),
    ...[0, 1, 2, 3].map((t) => cf(2, t, [b('horse', 0.1)], [])),
  ];
  const vals = new Set<number>();
  for (let seed = 1; seed <= 30; seed++) {
    const ci = bootstrap(frames, (s) => classMetrics(s, 'horse', 0.5, 0.5).recall, 20, seed);
    vals.add(ci.lo);
    vals.add(ci.hi);
  }
  for (const v of vals) {
    assert.ok(
      [0, 0.5, 1].some((e) => Math.abs(v - e) < 1e-9),
      `clip bootstrap produced ${v}`,
    );
  }
});

test('attribute agreement over matched pairs, with the confusion matrix', () => {
  const frames = [
    cf(
      1,
      0,
      [{ ...b('horse', 0.1), kind: 'horse', posture: 'standing' }],
      [{ ...b('horse', 0.1), kind: 'horse', posture: 'grazing' }],
    ),
    cf(
      1,
      1,
      [{ ...b('horse', 0.1), kind: 'donkey', posture: 'lying_flat' }],
      [{ ...b('horse', 0.1), kind: 'horse', posture: 'lying_flat' }],
    ),
    cf(1, 2, [{ ...b('horse', 0.1), kind: 'horse' }], [{ ...b('horse', 0.1) }]), // no posture on either side: not a pair
    cf(1, 3, [b('horse', 0.1)], [{ ...b('horse', 0.7), kind: 'horse' }]), // unmatched: not a pair
  ];
  const kind = attributeAgreement(frames, 'horse', 'kind', 0.5, 0.5);
  assert.equal(kind.pairs, 2); // the third frame's prediction carries no kind
  assert.equal(kind.agree, 1);
  assert.deepEqual(kind.confusion, { horse: { horse: 1 }, donkey: { horse: 1 } });
  const posture = attributeAgreement(frames, 'horse', 'posture', 0.5, 0.5);
  assert.equal(posture.pairs, 2);
  assert.equal(posture.agree, 1);
});

test('recall by gold group: size buckets and the lying/upright pair', () => {
  const far = { ...b('horse', 0.1), w: 0.02, h: 0.02, posture: 'lying_sternal' }; // 51 px on 2560: far
  const near = { ...b('horse', 0.5), posture: 'standing' }; // 512 px: near
  const frames = [cf(1, 0, [far, near], [{ ...near, confidence: 0.9 }])];
  const bySize = recallByGoldGroup(frames, 'horse', 0.5, 0.5, sizeBucket());
  assert.deepEqual(bySize, { far: { gold: 1, tp: 0, recall: 0 }, near: { gold: 1, tp: 1, recall: 1 } });
  const byPosture = recallByGoldGroup(frames, 'horse', 0.5, 0.5, postureGroup);
  assert.deepEqual(byPosture, { lying: { gold: 1, tp: 0, recall: 0 }, upright: { gold: 1, tp: 1, recall: 1 } });
  assert.deepEqual(recallByGoldGroup([fr('cam', 'day', [far], [])], 'horse', 0.5, 0.5, sizeBucket()), {}); // no frame size: no bucket
});

test('clip-level recall and false alarms by motion source', () => {
  const frames = [
    cf(1, 0, [b('horse', 0.1)], []), // gold horse, found in the next frame
    cf(1, 1, [b('horse', 0.1)], [b('horse', 0.1, 0.9)]),
    cf(2, 0, [b('horse', 0.1)], [b('horse', 0.8, 0.9)]), // gold horse, wrong place every frame: missed
    cf(3, 0, [], [b('person', 0.1, 0.9)]), // empty clip, fires: false alarm
    cf(4, 0, [], [b('bench', 0.1, 0.9)]), // empty clip, a non-interest class: no alarm
    cf(5, 0, [], []),
  ];
  const r = clipLevel(
    frames,
    0.5,
    0.5,
    ['horse', 'person'],
    new Map([
      [3, 'insect'],
      [4, 'lighting'],
      [5, 'none'],
    ]),
  );
  assert.equal(r.clips, 5);
  assert.equal(r.with_gold, 2);
  assert.equal(r.found, 1);
  assert.equal(r.recall, 0.5);
  assert.equal(r.without_gold, 3);
  assert.equal(r.false_alarms, 1);
  assert.deepEqual(r.by_motion_source, {
    insect: { clips: 1, fired: 1 },
    lighting: { clips: 1, fired: 0 },
    none: { clips: 1, fired: 0 },
  });
});

test('gold interpolation between labeled frames per object id', () => {
  const labeled = [
    {
      t_s: 0,
      boxes: [
        { ...b('horse', 0.1), id: 'a1' },
        { ...b('person', 0.5), id: 'p1' },
      ],
    },
    { t_s: 2, boxes: [{ ...b('horse', 0.3), id: 'a1' }] },
  ];
  const mid = interpolateGold(labeled, 1);
  assert.equal(mid.length, 1); // p1 is on one side only
  assert.ok(Math.abs(mid[0]!.x - 0.2) < 1e-9);
  assert.equal(mid[0]!.id, 'a1');
  assert.equal(interpolateGold(labeled, 2).length, 1); // exact labeled time: as labeled
  assert.equal(interpolateGold(labeled, 3).length, 0); // past the last label: nothing
});

test('throughput: the slower stage bounds the pipeline; cameras at native rate under the headroom', () => {
  const rows = Array.from({ length: 100 }, () => ({ decode_ms: 10, ms: 20 }));
  const t = throughput(rows, { headroom: 0.7, camera_fps: [15, 20] });
  assert.equal(t.frames, 100);
  assert.ok(Math.abs(t.fps_pipeline - 50) < 1e-9);
  assert.deepEqual(t.cameras_at_native, { '15fps': 2, '20fps': 1 }); // 35 fps usable
  assert.equal(throughput(rows, { wall_s: 10 }).fps_wall, 10); // wall-clock caps the capacity
});

test('scoreSet carries the clip-level and attribute blocks when the frames have them', () => {
  const frames = [
    cf(
      1,
      0,
      [{ ...b('horse', 0.1), kind: 'horse', posture: 'standing' }],
      [{ ...b('horse', 0.1), kind: 'horse', posture: 'standing' }],
      { stride: 1 },
    ),
    cf(2, 0, [], [], { stride: 1 }),
  ];
  const s = scoreSet(frames, { threshold: 0.5, iou: 0.5 }) as {
    bootstrap_unit: string;
    slices: Record<string, Record<string, unknown>>;
  };
  assert.equal(s.bootstrap_unit, 'clip');
  assert.ok(s.slices['stride:1']);
  const all = s.slices.all!;
  assert.equal((all.clips as { recall: number }).recall, 1);
  assert.equal((all.kind_agreement as { accuracy: number }).accuracy, 1);
  assert.equal((all.posture_agreement as { pairs: number }).pairs, 1);
});
