import { describe, it, expect } from 'vitest';
import { initialGesture, onPointerDown, onPointerMove, onPointerUp, onHoldTimer } from './swipe';
describe('swipe', () => {
  it('detects horizontal and vertical swipes by dominance', () => {
    let s = onPointerDown(initialGesture(), 100, 100, 0); s = onPointerMove(s, 30, 110);
    expect(onPointerUp(s, 30, 110, 200).actions).toEqual(['next']);
    s = onPointerDown(initialGesture(), 100, 100, 0); expect(onPointerUp(s, 170, 95, 200).actions).toEqual(['prev']);
    s = onPointerDown(initialGesture(), 100, 100, 0); expect(onPointerUp(s, 105, 40, 200).actions).toEqual(['member-next']);
    s = onPointerDown(initialGesture(), 100, 100, 0); expect(onPointerUp(s, 100, 160, 200).actions).toEqual(['member-prev']);
    s = onPointerDown(initialGesture(), 100, 100, 0); expect(onPointerUp(s, 140, 140, 200).actions).toEqual([]); // diagonal: nothing
  });
  it('taps and long-presses', () => {
    let s = onPointerDown(initialGesture(), 0, 0, 0); expect(onPointerUp(s, 2, 1, 100).actions).toEqual(['tap']);
    s = onPointerDown(initialGesture(), 0, 0, 0); const h = onHoldTimer(s); expect(h.actions).toEqual(['autoplay-start']);
    expect(onPointerUp(h.state, 0, 0, 600).actions).toEqual(['autoplay-stop']);
    s = onPointerMove(onPointerDown(initialGesture(), 0, 0, 0), 30, 0); expect(onHoldTimer(s).actions).toEqual([]); // moved: no hold
  });
});
