/** One scalar of a daemon's status object, for StatusKV and NestedTable. */
export const fmt = (v: unknown): string =>
  typeof v === 'number'
    ? Number.isInteger(v)
      ? v.toLocaleString()
      : v.toFixed(3)
    : v === null || v === undefined
      ? '–'
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
