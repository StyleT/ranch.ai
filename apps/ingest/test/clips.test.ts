import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  step,
  staleCheck,
  selectSegments,
  CLIP,
  idleState,
  blockMaxDiff,
  meanAbsDiff,
  litFraction,
  THUMB_W,
  THUMB_H,
} from '../src/clips.ts';

const T0 = Date.parse('2026-11-02T03:00:00Z');
const s = (n: number) => T0 + n * 1000;
const idle = idleState;
/** A keyframe: score = block-max against the previous keyframe, lit = share of blocks that changed (default: a few). */
const k = (ts: number, score: number, lit = 0.05) => ({ ts, score, lit });
/** Trigger plus two hot keyframes: the persistence the rule asks for before a clip exists. */
const openAt = (st: ReturnType<typeof idle>, t0: number, score = 0.3) => {
  step(st, k(s(t0), score));
  step(st, k(s(t0 + 2), score));
  return step(st, k(s(t0 + 4), score));
};

test('metrics: a moving object lights few blocks with a high block-max; a brightness step lights most of them', () => {
  const a = Buffer.alloc(THUMB_W * THUMB_H, 100);
  const b = Buffer.from(a);
  for (let y = 10; y < 30; y++) {
    for (let x = 20; x < 40; x++) {
      b[y * THUMB_W + x] = 200; // a 20x20 px object appeared (about 9 blocks)
    }
  }
  assert.ok(blockMaxDiff(a, b) >= 0.3);
  assert.ok(meanAbsDiff(a, b) < 0.02);
  assert.ok(litFraction(a, b) < 0.1);
  const c = Buffer.alloc(THUMB_W * THUMB_H, 130); // every pixel 30 brighter: a light switched
  assert.ok(litFraction(a, c) >= 0.5);
  assert.ok(blockMaxDiff(a, c) >= 0.08); // scores like motion, which is why lit decides
});

test('one hot keyframe becomes a candidate, never a clip: dropped as "single" when the window ends', () => {
  const st = idle();
  assert.equal(step(st, k(s(0), 0.05)), null);
  assert.deepEqual(step(st, k(s(2), 0.12)), { type: 'candidate', triggerTs: s(2) });
  assert.equal(step(st, k(s(4), 0.01)), null);
  assert.equal(step(st, k(s(6), 0.01)), null);
  const ev = step(st, k(s(8), 0.01));
  assert.deepEqual(ev, {
    type: 'drop',
    reason: 'single',
    triggerTs: s(2),
    endTs: s(8),
    series: [
      [0, 0.12, 0.05],
      [2, 0.01, 0.05],
      [4, 0.01, 0.05],
      [6, 0.01, 0.05],
    ],
  });
  assert.equal(st.triggerTs, null);
  assert.equal(st.lastCloseTs, 0); // no cooldown after a drop
});

test('a transient (appear, then vanish) scores hot on two pairs and is still dropped', () => {
  const st = idle();
  step(st, k(s(0), 0.12));
  assert.equal(step(st, k(s(2), 0.11)), null); // the vanish pair
  assert.equal(step(st, k(s(4), 0.01)), null);
  assert.equal(step(st, k(s(6), 0.01))?.type, 'drop');
});

test('persistent motion opens at the keyframe that confirms it, with the trigger as triggerTs', () => {
  const st = idle();
  assert.deepEqual(step(st, k(s(0), 0.12)), { type: 'candidate', triggerTs: s(0) });
  assert.equal(step(st, k(s(2), 0.09)), null);
  assert.deepEqual(step(st, k(s(4), 0.07)), { type: 'open', triggerTs: s(0) });
  assert.equal(st.confirmed, true);
});

test('a far-fence horse that pauses still confirms: 2 hot of the next 3 keyframes', () => {
  const st = idle();
  step(st, k(s(0), 0.08));
  step(st, k(s(2), 0.05));
  step(st, k(s(4), 0.01));
  assert.deepEqual(step(st, k(s(6), 0.05)), { type: 'open', triggerTs: s(0) });
});

test('a global change while idle is reported, never a candidate; the next hot keyframe opens one at once', () => {
  const st = idle();
  assert.deepEqual(step(st, { ts: s(0), score: 0.3, lit: 0.8 }), { type: 'global', ts: s(0), score: 0.3, lit: 0.8 });
  assert.equal(st.triggerTs, null);
  assert.deepEqual(step(st, k(s(2), 0.2)), { type: 'candidate', triggerTs: s(2) });
});

test('a global change drops a candidate and neither extends nor closes an open clip', () => {
  const st = idle();
  step(st, k(s(0), 0.2));
  assert.equal(step(st, { ts: s(2), score: 0.3, lit: 0.9 })?.type, 'drop');
  assert.equal((step(st, { ts: s(2), score: 0.3, lit: 0.9 }) as { reason?: string } | null)?.reason, undefined);
  const st2 = idle();
  openAt(st2, 10); // open at s(14), motion last at s(14)
  assert.equal(step(st2, { ts: s(16), score: 0.5, lit: 0.9 }), null);
  assert.equal(st2.motionLastTs, s(14)); // the global keyframe did not extend
  assert.equal(step(st2, k(s(20), 0.01)), null);
  assert.equal(step(st2, k(s(22), 0.01))?.type, 'close'); // 8 s after s(14)
});

test('stale: a candidate is dropped, an open clip closes where the last keyframe was', () => {
  const st = idle();
  step(st, k(s(0), 0.2));
  assert.equal(staleCheck(st, s(10), s(0)), null); // 10 s is not stale yet (staleS 30)
  assert.deepEqual(staleCheck(st, s(31), s(0)), {
    type: 'drop',
    reason: 'stale',
    triggerTs: s(0),
    endTs: s(0),
    series: [[0, 0.2, 0.05]],
  });
  const st2 = idle();
  openAt(st2, 0);
  assert.equal(staleCheck(st2, s(40), s(4))?.type, 'close');
});

test('extends while motion continues, closes "quiet" on the first keyframe that is quietS after the last motion', () => {
  const st = idle();
  openAt(st, 0, 0.3); // trigger s(0), confirmed at s(4), motion last s(4)
  assert.equal(step(st, k(s(6), 0.06)), null); // continues (>= continueScore)
  assert.equal(st.motionLastTs, s(6));
  assert.equal(step(st, k(s(8), 0.01)), null); // quiet, but only 2 s since motion
  assert.equal(step(st, k(s(12), 0.01)), null); // 6 s
  const ev = step(st, k(s(14), 0.01)); // 8 s since motion at s(6)
  assert.equal(ev?.type, 'close');
  assert.deepEqual(ev && 'stopped' in ev ? [ev.stopped, ev.triggerTs, ev.endTs, ev.series.length] : null, [
    'quiet',
    s(0),
    s(14),
    7,
  ]); // trigger + 6 keyframes
  assert.equal(st.triggerTs, null);
  assert.equal(st.lastCloseTs, s(14));
});

test('closes "max" at maxS after the trigger even while motion continues', () => {
  const st = idle();
  openAt(st, 0, 0.3);
  for (let t = 6; t < CLIP.maxS; t += 2) {
    assert.equal(step(st, k(s(t), 0.2)), null);
  }
  const ev = step(st, k(s(CLIP.maxS), 0.2));
  assert.equal(ev?.type, 'close');
  assert.equal(ev && 'stopped' in ev ? ev.stopped : null, 'max');
});

test('no new clip opens within cooldownS of a close; after it, motion opens again', () => {
  const st = idle();
  openAt(st, 0, 0.3); // motion last at s(4)
  assert.equal(step(st, k(s(12), 0.01))?.type, 'close'); // closed at s(12) by the quiet rule, 8 s after s(4)
  assert.equal(st.triggerTs, null);
  assert.equal(step(st, k(s(17), 0.5)), null);
  assert.deepEqual(step(st, k(s(23), 0.5)), { type: 'candidate', triggerTs: s(23) });
});

test("confirmHot 0 is yesterday's rule: the trigger opens the clip at once (the replay tool's baseline)", () => {
  const st = idle();
  assert.deepEqual(step(st, k(s(0), 0.12), { ...CLIP, confirmHot: 0 }), { type: 'open', triggerTs: s(0) });
  assert.equal(st.confirmed, true);
});

test('selectSegments: from the segment that contains trigger - prerollS through the one that covers the end, never the newest file', () => {
  // segment names are their first keyframe's UTC second; one GOP each (2 s here)
  const names = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((n) => `2026-11-02T03-00-${String(n).padStart(2, '0')}Z.ts`);
  const got = selectSegments(names, s(11), s(17)); // trigger 11 -> preroll from 6 (5 s back, inside the 6 s segment); end 17 -> segment 16 covers it
  assert.deepEqual(got, names.slice(2, 8)); // 06..16
  assert.deepEqual(selectSegments(names, s(11), s(21)), names.slice(2, 9)); // end beyond the ring: everything but the newest (20)
  assert.deepEqual(selectSegments(names, s(1), s(5)), names.slice(0, 2)); // trigger before the ring starts: from the first
  assert.deepEqual(selectSegments(['2026-11-02T03-00-02Z.ts'], s(2), s(4)), []); // a single, newest file is never taken
});
