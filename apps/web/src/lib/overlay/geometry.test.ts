import { describe, it, expect } from 'vitest';
import { pctBox, arrow, caption, labelKind, describe as describeFrame, isMoving } from './geometry';
const box = (o: Partial<{ label: string; raw_label: string | null; confidence: number; x: number; y: number; w: number; h: number; seen: number | null; dx: number | null; dy: number | null; gold: boolean }> = {}) =>
  ({ label: 'horse', raw_label: null, confidence: 0.9, x: 0.1, y: 0.2, w: 0.3, h: 0.4, seen: null, dx: null, dy: null, gold: false, ...o });

describe('geometry', () => {
  it('converts normalized boxes to percentages and clamps overflow', () => {
    expect(pctBox(box())).toEqual({ left: '10.000%', top: '20.000%', width: '30.000%', height: '40.000%' });
    expect(pctBox(box({ x: 0.9, w: 0.5 })).width).toBe('10.000%');
  });
  it('draws an arrow only above the movement threshold', () => {
    expect(arrow(box({ dx: 0.01, dy: 0 }))).toBeNull();
    expect(isMoving(box({ dx: 0.05, dy: 0 }))).toBe(true);
    expect(arrow(box({ dx: 0.05, dy: 0 }))).toEqual({ x1: 200, y1: 400, x2: 250, y2: 400 });
  });
  it('captions with the raw label when it differs, seen count, and no confidence for gold', () => {
    expect(caption(box())).toBe('horse 0.90');
    expect(caption(box({ raw_label: 'cow', confidence: 0.71, seen: 3 }))).toBe('horse ← cow 0.71 ×3');
    expect(caption(box({ raw_label: 'horse' }))).toBe('horse 0.90');
    expect(caption(box({ gold: true, label: 'donkey/standing' }))).toBe('donkey/standing');
  });
  it('classifies labels for colour and describes frames', () => {
    expect(labelKind(box())).toBe('horse'); expect(labelKind(box({ label: 'tractor' }))).toBe('vehicle'); expect(labelKind(box({ label: 'bench' }))).toBe('other'); expect(labelKind(box({ gold: true }))).toBe('gold');
    expect(describeFrame('donkey_cam', '14:02:11', [box(), box(), box({ label: 'person' })])).toBe('donkey_cam 14:02:11, horse ×2, person');
    expect(describeFrame('cam', 't', [])).toBe('cam t, no detections');
  });
});
