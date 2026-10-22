'use client';
// Responsive table: a real <table> from md up (sticky header, optional sticky first column), a card list below it
// showing priority-1 cells inline and the rest in a <details>.
import type { ReactNode } from 'react';
export interface Column<T> { key: string; header: ReactNode; cell: (row: T) => ReactNode; priority?: 1 | 2 | 3; align?: 'left' | 'right'; }
export function DataTable<T>({ rows, columns, rowKey, caption, stickyFirst = false, rowTestId, rowProps }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; caption: string; stickyFirst?: boolean; rowTestId?: (r: T) => string; rowProps?: (r: T) => Record<string, string> }) {
  const p1 = columns.filter((c) => (c.priority ?? 1) === 1); const rest = columns.filter((c) => (c.priority ?? 1) !== 1);
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm"><caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-surface"><tr>{columns.map((c, i) => <th key={c.key} className={`border-b border-line px-2 py-1.5 font-medium text-dim ${c.align === 'right' ? 'text-right' : 'text-left'} ${stickyFirst && i === 0 ? 'sticky left-0 bg-surface' : ''}`}>{c.header}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={rowKey(r)} {...(rowTestId ? { 'data-testid': rowTestId(r) } : {})} {...(rowProps?.(r) ?? {})} className="border-b border-line">{columns.map((c, i) => <td key={c.key} className={`px-2 py-1.5 align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${stickyFirst && i === 0 ? 'sticky left-0 bg-surface' : ''}`}>{c.cell(r)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <ul className="grid gap-2 md:hidden">{rows.map((r) => (
        <li key={rowKey(r)} {...(rowTestId ? { 'data-testid': rowTestId(r) + '-card' } : {})} {...(rowProps?.(r) ?? {})} className="rounded-card border border-line bg-surface p-2 text-sm">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">{p1.map((c) => <span key={c.key}>{c.cell(r)}</span>)}</div>
          {rest.length > 0 && <details className="mt-1"><summary className="min-h-touch cursor-pointer list-none text-xs text-dim">details</summary><dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">{rest.map((c) => <div key={c.key} className="contents"><dt className="text-dim">{c.header}</dt><dd>{c.cell(r)}</dd></div>)}</dl></details>}
        </li>
      ))}</ul>
    </>
  );
}
