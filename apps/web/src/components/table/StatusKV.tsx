// A daemon's retained status object: known keys first (typed per daemon), nested objects as sub-tables, the rest as chips.
import { KNOWN_STATUS } from '@/lib/system/knownStatus';
import { fmt } from './fmt';
import { NestedTable } from './NestedTable';
export function StatusKV({ daemon, status }: { daemon: string; status: Record<string, unknown> | null }) {
  if (!status) {
    return <span className="text-dim">no status</span>;
  }
  const known = KNOWN_STATUS[daemon] ?? [];
  const shown = new Set<string>(['ts', 'pid', 'cameras']);
  const chips: React.ReactNode[] = [];
  for (const k of known) {
    if (k in status && typeof status[k] !== 'object') {
      shown.add(k);
      chips.push(
        <span key={k} className="mr-2 whitespace-nowrap">
          <span className="text-dim">{k}</span> <b>{fmt(status[k])}</b>
        </span>,
      );
    }
  }
  for (const [k, v] of Object.entries(status)) {
    if (!shown.has(k) && (v === null || typeof v !== 'object')) {
      shown.add(k);
      chips.push(
        <span key={k} className="mr-2 whitespace-nowrap">
          <span className="text-dim">{k}</span> {fmt(v)}
        </span>,
      );
    }
  }
  const nested = Object.entries(status).filter(([k, v]) => !shown.has(k) && v && typeof v === 'object');
  return (
    <div className="text-xs">
      <div className="leading-6">{chips}</div>
      {nested.map(([k, v]) => (
        <NestedTable key={k} name={k} value={v as Record<string, unknown>} />
      ))}
    </div>
  );
}
