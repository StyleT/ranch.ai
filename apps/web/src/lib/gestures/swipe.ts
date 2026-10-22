// Pure pointer-gesture state machine for the viewer: horizontal swipe = prev/next frame, vertical swipe = burst
// member, long press = autoplay, release = stop (docs/WEB-DASHBOARD.md §4.3). Feed it pointer events, act on the
// returned actions; it owns no timers (the caller schedules `longPress` via `holdMs`).
export type Action = 'prev' | 'next' | 'member-prev' | 'member-next' | 'autoplay-start' | 'autoplay-stop' | 'tap';
export interface GestureState { down: { x: number; y: number; t: number } | null; moved: boolean; holding: boolean }
export const initialGesture = (): GestureState => ({ down: null, moved: false, holding: false });
export const SWIPE_PX = 48; export const HOLD_MS = 450; export const MOVE_TOLERANCE = 10;

export function onPointerDown(s: GestureState, x: number, y: number, t: number): GestureState { return { down: { x, y, t }, moved: false, holding: false }; }
export function onPointerMove(s: GestureState, x: number, y: number): GestureState {
  if (!s.down) return s; const moved = s.moved || Math.hypot(x - s.down.x, y - s.down.y) > MOVE_TOLERANCE; return moved === s.moved ? s : { ...s, moved };
}
/** Called by the owner's timer at down + HOLD_MS: starts autoplay if the pointer has not moved. */
export function onHoldTimer(s: GestureState): { state: GestureState; actions: Action[] } {
  if (!s.down || s.moved || s.holding) return { state: s, actions: [] };
  return { state: { ...s, holding: true }, actions: ['autoplay-start'] };
}
export function onPointerUp(s: GestureState, x: number, y: number, t: number): { state: GestureState; actions: Action[] } {
  if (!s.down) return { state: s, actions: [] };
  const dx = x - s.down.x, dy = y - s.down.y; const actions: Action[] = []; const moved = s.moved || Math.hypot(dx, dy) > MOVE_TOLERANCE;
  if (s.holding) actions.push('autoplay-stop');
  else if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy)) actions.push(dx < 0 ? 'next' : 'prev');
  else if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > 2 * Math.abs(dx)) actions.push(dy < 0 ? 'member-next' : 'member-prev');
  else if (!moved && t - s.down.t < HOLD_MS) actions.push('tap');
  return { state: initialGesture(), actions };
}
