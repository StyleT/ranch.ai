import { describe, it, expect } from 'vitest';
import { parseFilters, serializeFilters, apiQuery, DEFAULTS } from './urlState';

describe('urlState', () => {
  it('parses defaults and clamps values', () => {
    expect(parseFilters(new URLSearchParams(''))).toEqual(DEFAULTS);
    const f = parseFilters(new URLSearchParams('since=48h&min_conf=7&reason=x&frame=12.5&seq=-2&set=not-a-date'));
    expect(f.since).toBe('1h'); expect(f.min_conf).toBe(1); expect(f.reason).toBeNull(); expect(f.frame).toBeNull(); expect(f.seq).toBe(0); expect(f.set).toBeNull();
  });
  it('round-trips and serializes canonically with defaults omitted', () => {
    const f = parseFilters(new URLSearchParams('with_detections=1&camera=donkey_cam&since=6h&label=horse&frame=48213&seq=1&min_conf=0.5'));
    const s = serializeFilters(f);
    expect(s).toBe('camera=donkey_cam&frame=48213&label=horse&min_conf=0.5&seq=1&since=6h&with_detections=1');
    expect(parseFilters(new URLSearchParams(s))).toEqual(f);
    expect(serializeFilters(DEFAULTS)).toBe('');
  });
  it('builds the api query without viewer state and with the baseline set', () => {
    const f = parseFilters(new URLSearchParams('set=2026-10-20&model=yolo26s&frame=1&seq=2&label=horse'));
    expect(apiQuery(f, { limit: '60' })).toBe('label=horse&limit=60&model=yolo26s&set=2026-10-20&since=1h');
  });
});
