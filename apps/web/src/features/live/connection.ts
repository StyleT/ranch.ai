// Pure watchdog state machine for the live connection (docs/WEB-DASHBOARD.md §4.3). The 16 Oct lessons:
// reconnect after 45 s of silence, refresh on visibility, never trust an open socket by itself.
export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'stale' | 'offline';
export interface Conn { state: ConnState; lastStatusAt: number | null; openedAt: number | null; reconnects: number }
export type ConnEvent = { type: 'open' } | { type: 'status' } | { type: 'error' } | { type: 'tick' } | { type: 'visible' } | { type: 'offline' } | { type: 'online' };
export const STALE_MS = 45_000;

export const initialConn = (): Conn => ({ state: 'connecting', lastStatusAt: null, openedAt: null, reconnects: 0 });

/** Returns the next state and whether the caller must reopen the EventSource and refetch. */
export function reduceConn(c: Conn, e: ConnEvent, now: number): { conn: Conn; reconnect: boolean; refetch: boolean } {
  switch (e.type) {
    case 'open': return { conn: { ...c, state: c.lastStatusAt ? 'live' : 'connecting', openedAt: now }, reconnect: false, refetch: false };
    case 'status': return { conn: { ...c, state: 'live', lastStatusAt: now }, reconnect: false, refetch: false };
    case 'error': return { conn: { ...c, state: 'reconnecting', reconnects: c.reconnects + 1 }, reconnect: false, refetch: false };
    case 'offline': return { conn: { ...c, state: 'offline' }, reconnect: false, refetch: false };
    case 'online': return { conn: { ...c, state: 'reconnecting', reconnects: c.reconnects + 1 }, reconnect: true, refetch: true };
    case 'visible': { const stale = c.lastStatusAt !== null && now - c.lastStatusAt > STALE_MS; return { conn: stale ? { ...c, state: 'reconnecting', reconnects: c.reconnects + 1 } : c, reconnect: stale, refetch: true }; }
    case 'tick': {
      if (c.state === 'offline') return { conn: c, reconnect: false, refetch: false };
      const since = c.lastStatusAt ?? c.openedAt; if (since === null || now - since <= STALE_MS) return { conn: c, reconnect: false, refetch: false };
      return { conn: { ...c, state: 'stale', reconnects: c.reconnects + 1 }, reconnect: true, refetch: true };
    }
  }
}
export const ageSeconds = (c: Conn, now: number): number | null => (c.lastStatusAt === null ? null : Math.round((now - c.lastStatusAt) / 1000));
