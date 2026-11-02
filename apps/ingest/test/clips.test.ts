import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, selectSegments, CLIP, type ClipState } from '../src/clips.ts';

const T0 = Date.parse('2026-11-02T03:00:00Z');
const s = (n: number) => T0 + n * 1000;
const idle = (): ClipState => ({ triggerTs: null, motionLastTs: null, lastCloseTs: 0 });

test('opens on a keyframe whose local motion reaches the open threshold; a quieter one does not', () => {
  const st = idle();
  assert.equal(step(st, { ts: s(0), score: 0.05 }), null);
  assert.equal(st.triggerTs, null);
  assert.deepEqual(step(st, { ts: s(2), score: 0.08 }), { type: 'open', triggerTs: s(2) });
  assert.equal(st.triggerTs, s(2));
});

test('extends while motion continues, closes "quiet" on the first keyframe that is quietS after the last motion', () => {
  const st = idle(); step(st, { ts: s(0), score: 0.3 });
  assert.equal(step(st, { ts: s(2), score: 0.06 }), null);    // continues (>= continueScore)
  assert.equal(st.motionLastTs, s(2));
  assert.equal(step(st, { ts: s(4), score: 0.01 }), null);    // quiet, but only 2 s since motion
  assert.equal(step(st, { ts: s(8), score: 0.01 }), null);    // 6 s
  const ev = step(st, { ts: s(10), score: 0.01 });            // 8 s since motion at s(2)
  assert.deepEqual(ev, { type: 'close', stopped: 'quiet', triggerTs: s(0), endTs: s(10) });
  assert.equal(st.triggerTs, null); assert.equal(st.lastCloseTs, s(10));
});

test('closes "max" at maxS after the trigger even while motion continues', () => {
  const st = idle(); step(st, { ts: s(0), score: 0.3 });
  for (let t = 2; t < CLIP.maxS; t += 2) assert.equal(step(st, { ts: s(t), score: 0.2 }), null);
  assert.deepEqual(step(st, { ts: s(CLIP.maxS), score: 0.2 }), { type: 'close', stopped: 'max', triggerTs: s(0), endTs: s(CLIP.maxS) });
});

test('no new clip opens within cooldownS of a close; after it, motion opens again', () => {
  const st = idle(); step(st, { ts: s(0), score: 0.3 }); step(st, { ts: s(10), score: 0.01 }); step(st, { ts: s(10), score: 0.01 });
  // closed at s(10) by the quiet rule (motion last at s(0)); the next motion inside the cooldown is ignored
  assert.equal(st.triggerTs, null);
  assert.equal(step(st, { ts: s(15), score: 0.5 }), null);
  assert.deepEqual(step(st, { ts: s(21), score: 0.5 }), { type: 'open', triggerTs: s(21) });
});

test('selectSegments: from the segment that contains trigger - prerollS through the one that covers the end, never the newest file', () => {
  // segment names are their first keyframe's UTC second; one GOP each (2 s here)
  const names = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((n) => `2026-11-02T03-00-${String(n).padStart(2, '0')}Z.ts`);
  const got = selectSegments(names, s(11), s(17));   // trigger 11 -> preroll from 6 (5 s back, inside the 6 s segment); end 17 -> segment 16 covers it
  assert.deepEqual(got, names.slice(2, 8));          // 06..16
  assert.deepEqual(selectSegments(names, s(11), s(21)), names.slice(2, 9));   // end beyond the ring: everything but the newest (20)
  assert.deepEqual(selectSegments(names, s(1), s(5)), names.slice(0, 2));     // trigger before the ring starts: from the first
  assert.deepEqual(selectSegments(['2026-11-02T03-00-02Z.ts'], s(2), s(4)), []);   // a single, newest file is never taken
});
