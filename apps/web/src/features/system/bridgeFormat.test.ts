import { describe, it, expect } from 'vitest';
import { nanosToMs, stateTone } from './bridgeFormat';

describe('bridge formatting', () => {
  it('converts Go nanoseconds to whole ms', () => {
    expect(nanosToMs(673739250)).toBe('674'); expect(nanosToMs(0)).toBe('0'); expect(nanosToMs(null)).toBe('–');
  });
  it('maps bridge states to tones', () => {
    expect(stateTone('streaming')).toBe('ok'); expect(stateTone('error')).toBe('bad'); expect(stateTone('connecting')).toBe('warn'); expect(stateTone('offline')).toBe('dim');
  });
});
