import { fmt } from './fmt';

export function NestedTable({ name, value }: { name: string; value: Record<string, unknown> }) {
  const rows = Object.entries(value);
  const isTable = rows.length > 0 && rows.every(([, r]) => r && typeof r === 'object' && !Array.isArray(r));
  if (!isTable) {
    return (
      <div className="mt-1">
        <span className="text-dim">{name}</span>{' '}
        {rows.map(([k, r]) => (
          <span key={k} className="mr-2">
            {k} <b>{fmt(r)}</b>
          </span>
        ))}
      </div>
    );
  }
  const cols = [...new Set(rows.flatMap(([, r]) => Object.keys(r as object)))]
    .filter((c) => c !== 'camera')
    .slice(0, 8);
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full">
        <caption className="sr-only">{name}</caption>
        <thead>
          <tr>
            <th className="text-dim text-left font-medium">{name}</th>
            {cols.map((c) => (
              <th key={c} className="text-dim text-right font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, r]) => (
            <tr key={k}>
              <td className="pr-2">{k}</td>
              {cols.map((c) => (
                <td key={c} className="text-right tabular-nums">
                  {fmt((r as Record<string, unknown>)[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
