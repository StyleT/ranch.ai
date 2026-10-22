// Formatting helpers shared by server and client. Times render in the ranch timezone (RANCH_TZ) regardless of the viewer.
export function formatAge(s: number): string {
  if (!Number.isFinite(s)) return '–';
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.floor(s / 86400)} d ${Math.round((s % 86400) / 3600)} h`;
}
export function formatUptime(s: number): string { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600); return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`; }
export function localTime(iso: string, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', ...opts }).format(new Date(iso)); } catch { return iso.slice(11, 19); }
}
export function localDateTime(iso: string, tz: string): string {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch { return iso.slice(0, 16); }
}
export const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(d)}%`);
export const fix = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : v.toFixed(d));
