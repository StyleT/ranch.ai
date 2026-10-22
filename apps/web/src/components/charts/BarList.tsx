// Thin horizontal bars with the value in text ink (never colored text). One hue; status colours are reserved.
export function BarList({ rows, max, format = (v) => String(v), testid }: { rows: { label: string; value: number; hint?: string }[]; max?: number; format?: (v: number) => string; testid?: string }) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="grid gap-1" data-testid={testid}>
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-sm">
          <span className="truncate">{r.label}{r.hint && <span className="text-dim"> {r.hint}</span>}</span><span className="tabular-nums">{format(r.value)}</span>
          <div className="col-span-2 h-2 rounded-sm bg-surface-2" aria-hidden><div className="h-2 rounded-sm bg-chart-1" style={{ width: `${Math.min(100, (100 * r.value) / m)}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
