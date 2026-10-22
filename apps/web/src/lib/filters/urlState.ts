// Filter state of the detections browser <-> URL search params, canonical (sorted keys, defaults omitted) so the
// same state always yields the same URL (docs/WEB-DASHBOARD.md §4.3).
export type Since = '1h' | '6h' | '24h' | '7d';
export interface FilterState {
  set: string | null; model: string | null; camera: string | null; since: Since; label: string | null; min_conf: number | null;
  reason: 'change' | 'floor' | null; with_detections: boolean; moving: boolean; frame: number | null; seq: number;
}
export const DEFAULTS: FilterState = { set: null, model: null, camera: null, since: '1h', label: null, min_conf: null, reason: null, with_detections: false, moving: false, frame: null, seq: 0 };
const SINCES: Since[] = ['1h', '6h', '24h', '7d'];

export function parseFilters(sp: URLSearchParams | Record<string, string | string[] | undefined>): FilterState {
  const get = (k: string): string | null => { const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k]; return Array.isArray(v) ? (v[0] ?? null) : (v ?? null); };
  const num = (k: string) => { const v = get(k); if (v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const since = get('since'); const reason = get('reason'); const mc = num('min_conf');
  return {
    set: get('set') && /^\d{4}-\d{2}-\d{2}$/.test(get('set')!) ? get('set') : null, model: get('model') || null, camera: get('camera') || null,
    since: SINCES.includes(since as Since) ? (since as Since) : '1h', label: get('label') || null, min_conf: mc === null ? null : Math.min(1, Math.max(0, mc)),
    reason: reason === 'change' || reason === 'floor' ? reason : null, with_detections: get('with_detections') === '1', moving: get('moving') === '1',
    frame: num('frame') !== null && Number.isInteger(num('frame')) ? num('frame') : null, seq: Math.max(0, Math.floor(num('seq') ?? 0)),
  };
}
export function serializeFilters(f: FilterState): string {
  const p = new URLSearchParams();
  if (f.camera) p.set('camera', f.camera); if (f.frame !== null) p.set('frame', String(f.frame)); if (f.label) p.set('label', f.label);
  if (f.min_conf !== null) p.set('min_conf', String(f.min_conf)); if (f.model) p.set('model', f.model); if (f.moving) p.set('moving', '1');
  if (f.reason) p.set('reason', f.reason); if (f.seq) p.set('seq', String(f.seq)); if (f.set) p.set('set', f.set);
  if (f.since !== '1h') p.set('since', f.since); if (f.with_detections) p.set('with_detections', '1');
  p.sort(); return p.toString();
}
/** The query the BFF /api/ui/detections understands (viewer state is not part of it). */
export function apiQuery(f: FilterState, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (f.set) { p.set('set', f.set); if (f.model) p.set('model', f.model); }
  if (f.camera) p.set('camera', f.camera); p.set('since', f.since); if (f.label) p.set('label', f.label);
  if (f.min_conf !== null) p.set('min_conf', String(f.min_conf)); if (f.reason) p.set('reason', f.reason);
  if (f.with_detections) p.set('with_detections', '1'); if (f.moving) p.set('moving', '1');
  p.sort(); return p.toString();
}
