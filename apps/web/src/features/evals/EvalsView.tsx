'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import type { EvalsData, LeaderboardRow } from '@/lib/types';
import { Card, Section, Skeleton } from '@/components/ui';
import { DataTable } from '@/components/table/DataTable';
import { tid } from '@/lib/testids';

export const useEvals = () => useQuery({ queryKey: keys.evals(), queryFn: () => apiGet<EvalsData>('/api/ui/evals'), staleTime: 60_000 });
const SORTS = { date: (a: LeaderboardRow, b: LeaderboardRow) => b.date.localeCompare(a.date), model: (a: LeaderboardRow, b: LeaderboardRow) => a.model.localeCompare(b.model), tag: (a: LeaderboardRow, b: LeaderboardRow) => a.tag.localeCompare(b.tag) } as const;

export function EvalsView() {
  const q = useEvals(); const [sort, setSort] = useState<keyof typeof SORTS>('date'); const [prodOnly, setProdOnly] = useState(false);
  if (q.isPending) return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-64" /></div>;
  if (q.isError || !q.data) return <Card role="alert" className="text-bad">evals unavailable</Card>;
  const d = q.data; const rows = [...d.rows].filter((r) => !prodOnly || r.prod).sort(SORTS[sort]);
  return (
    <>
      <h1 className="mb-2 text-lg font-semibold">Evals</h1>
      <Section title="Leaderboard" action={<span className="flex items-center gap-2 text-xs normal-case tracking-normal"><label>sort <select value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)} aria-label="Sort" className="min-h-touch rounded-md border border-line bg-surface px-1">{Object.keys(SORTS).map((k) => <option key={k}>{k}</option>)}</select></label><label className="flex items-center gap-1"><input type="checkbox" checked={prodOnly} onChange={(e) => setProdOnly(e.target.checked)} /> prod only</label></span>}>
        <Card className="p-0"><DataTable caption="Leaderboard" rows={rows} rowKey={(r) => `${r.date}-${r.tag}-${r.model}-${r.labels}`} rowTestId={(r) => tid.evalsRow(r.result, r.model)} rowProps={(r) => ({ 'data-prod': r.prod ? 'true' : 'false' })} columns={[
          { key: 'date', header: 'date', cell: (r) => <span>{r.prod && <span title="production" className="text-warn">★ </span>}{r.date}</span> }, { key: 'tag', header: 'tag', cell: (r) => r.tag }, { key: 'model', header: 'model', cell: (r) => <b>{r.model}</b> },
          { key: 'r', header: 'R@FPPF≤.1', cell: (r) => r.r_at_fppf, align: 'right' }, { key: 'recall', header: 'horse R (CI)', cell: (r) => r.horse_recall, align: 'right' }, { key: 'ap', header: 'AP', cell: (r) => r.ap, align: 'right' },
          { key: 'fppf', header: 'FPPF', cell: (r) => r.fppf_all, align: 'right' }, { key: 'count', header: 'count', cell: (r) => r.count_exact, align: 'right', priority: 2 }, { key: 'p50', header: 'p50 ms', cell: (r) => r.p50_ms, align: 'right', priority: 2 },
          { key: 'labels', header: 'labels', cell: (r) => <span className="text-dim">{r.labels}</span>, priority: 3 }, { key: 'file', header: 'result', cell: (r) => (r.result ? <Link href={`/evals/${r.result.split(' ')[0]}`} className="text-accent">{r.result.split(' ')[0]}</Link> : ''), priority: 2 },
        ]} /></Card>
        {d.notes && <details className="mt-2 text-sm text-dim"><summary className="cursor-pointer">notes</summary><pre className="whitespace-pre-wrap font-sans">{d.notes}</pre></details>}
      </Section>
      <div className="md:grid md:grid-cols-2 md:gap-4">
        <Section title={`Result files (${d.files.length})`}><Card className="p-0"><ul className="divide-y divide-line text-sm">{d.files.map((f) => <li key={f.file}><Link href={`/evals/${f.file}`} className="flex min-h-touch items-center px-3 hover:bg-surface-2">{f.file}<span className="flex-1" /><span className="text-dim">{f.models.join(', ')}</span></Link></li>)}</ul></Card></Section>
        <Section title={`Datasets (${d.datasets.length})`}><Card className="p-0"><ul className="divide-y divide-line text-sm">{d.datasets.map((x) => <li key={x.id} className="px-3 py-1.5"><b>{x.id}</b> <span className="text-dim">{x.kind} · {x.n} · {x.created}{x.parent !== '–' ? ` · from ${x.parent}` : ''}</span></li>)}</ul></Card></Section>
      </div>
    </>
  );
}
