// Ring buffer of live track events and raw MQTT lines (for the ticker), subscribable via useSyncExternalStore.
export type TrackEvent = { camera: string; burst_id: number; frames: number; tracks: { track: number; label: string; raw_label: string; seen: number; dx: number; dy: number; moving: boolean; stable: boolean; confidence: number }[]; at: number };
export type RawEvent = { topic: string; payload: unknown; at: number };
type Snapshot = { tracks: TrackEvent[]; raw: RawEvent[] };
let snap: Snapshot = { tracks: [], raw: [] };
const subs = new Set<() => void>();
const emit = () => { for (const s of subs) s(); };
export const activityStore = {
  push(t: Omit<TrackEvent, 'at'>) { snap = { ...snap, tracks: [{ ...t, at: Date.now() }, ...snap.tracks].slice(0, 200) }; emit(); },
  pushRaw(r: { topic: string; payload: unknown }) { snap = { ...snap, raw: [{ ...r, at: Date.now() }, ...snap.raw].slice(0, 100) }; emit(); },
  get: () => snap,
  subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; },
  reset() { snap = { tracks: [], raw: [] }; emit(); },
};
