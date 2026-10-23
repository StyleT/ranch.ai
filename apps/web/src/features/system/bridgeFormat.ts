/** The bridge reports Go durations in nanoseconds; the page shows whole milliseconds. */
export const nanosToMs = (nanos: number | null | undefined): string => (nanos === null || nanos === undefined ? '–' : String(Math.round(nanos / 1e6)));

/** Badge tone for a bridge camera state (streaming / connecting / discovering / offline / error). */
export const stateTone = (state: string): 'ok' | 'warn' | 'bad' | 'dim' => (state === 'streaming' ? 'ok' : state === 'error' ? 'bad' : state === 'connecting' || state === 'discovering' ? 'warn' : 'dim');
