// Scales and tick helpers for the inline SVG charts (one series each, no library).
export const linear = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));
/** Integer ticks for small counts: 0..max with at most 5 ticks. */
export function intTicks(max: number): number[] { const m = Math.max(1, Math.ceil(max)); const step = m <= 5 ? 1 : Math.ceil(m / 4); const out: number[] = []; for (let v = 0; v <= m; v += step) out.push(v); if (out[out.length - 1] !== m) out.push(m); return out; }
/** Time ticks: every `everyMs` from the first boundary >= start. */
export function timeTicks(startMs: number, endMs: number, everyMs: number): number[] { const out: number[] = []; for (let t = Math.ceil(startMs / everyMs) * everyMs; t <= endMs; t += everyMs) out.push(t); return out; }
export const tickEvery = (spanMs: number) => (spanMs <= 3600e3 ? 15 * 60e3 : spanMs <= 6 * 3600e3 ? 3600e3 : spanMs <= 86400e3 ? 4 * 3600e3 : 86400e3);
export const nearestIndex = (xs: number[], x: number) => { let best = 0; for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - x) < Math.abs(xs[best]! - x)) best = i; return best; };
