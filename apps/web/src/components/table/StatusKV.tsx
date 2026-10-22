// A daemon's retained status object: known keys first (typed per daemon), nested objects as sub-tables, the rest as chips.
import { KNOWN_STATUS } from '@/lib/system/knownStatus';

const fmt = (v: unknown): string => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3)) : v === null || v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function StatusKV({ daemon, status }: { daemon: string; status: Record<string, unknown> | null }) {
  if (!status) return <span className="text-dim">no status</span>;
  const known = KNOWN_STATUS[daemon] ?? [];
  const shown = new Set<string>(['ts', 'pid', 'cameras']);
  const chips: React.ReactNode[] = [];
  for (const k of known) if (k in status && typeof status[k] !== 'object') { shown.add(k); chips.push(<span key={k} className="mr-2 whitespace-nowrap"><span className="text-dim">{k}</span> <b>{fmt(status[k])}</b></span>); }
  for (const [k, v] of Object.entries(status)) if (!shown.has(k) && (v === null || typeof v !== 'object')) { shown.add(k); chips.push(<span key={k} className="mr-2 whitespace-nowrap"><span className="text-dim">{k}</span> {fmt(v)}</span>); }
  const nested = Object.entries(status).filter(([k, v]) => !shown.has(k) && v && typeof v === 'object');
  return (
    <div className="text-xs">
      <div className="leading-6">{chips}</div>
      {nested.map(([k, v]) => <NestedTable key={k} name={k} value={v as Record<string, unknown>} />)}
    </div>
  );
}
function NestedTable({ name, value }: { name: string; value: Record<string, unknown> }) {
  const rows = Object.entries(value);
  const isTable = rows.length > 0 && rows.every(([, r]) => r && typeof r === 'object' && !Array.isArray(r));
  if (!isTable) return <div className="mt-1"><span className="text-dim">{name}</span> {rows.map(([k, r]) => <span key={k} className="mr-2">{k} <b>{fmt(r)}</b></span>)}</div>;
  const cols = [...new Set(rows.flatMap(([, r]) => Object.keys(r as object)))].filter((c) => c !== 'camera').slice(0, 8);
  return (
    <div className="mt-1 overflow-x-auto"><table className="w-full"><caption className="sr-only">{name}</caption>
      <thead><tr><th className="text-left font-medium text-dim">{name}</th>{cols.map((c) => <th key={c} className="text-right font-medium text-dim">{c}</th>)}</tr></thead>
      <tbody>{rows.map(([k, r]) => <tr key={k}><td className="pr-2">{k}</td>{cols.map((c) => <td key={c} className="text-right tabular-nums">{fmt((r as Record<string, unknown>)[c])}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
