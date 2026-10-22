'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import { Card, Section, Skeleton } from '@/components/ui';

type Cls = { gold: number; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number; ap: number };
type Slice = { frames: number; classes: Record<string, Cls>; fppf_all: number; fppf_interest: number; horse_count: { mae: number; exact: number }; horse_recall_ci: { lo: number; hi: number } | null; horse_ap: number };
type Result = { ts: string; tag: string; commit: string | null; host: string; command: string; frames: { dataset: string | null; n: number; scored: number }; labels: { dataset: string | null } | null; threshold: number; iou: number;
  results: { model: string; latency: { p50_ms: number; p95_ms: number; peak_rss_mb: number } | null; score?: { thresholds_by_label?: Record<string, number> | null; operating_points: { r_at_fppf01: { recall: number; threshold: number | null }; r_at_p90: { recall: number } }; slices: Record<string, Slice> } }[] };
const f = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toFixed(2));

export function ResultView({ file }: { file: string }) {
  const q = useQuery({ queryKey: keys.result(file), queryFn: () => apiGet<Result>(`/api/ui/evals/results/${encodeURIComponent(file)}`), staleTime: 300_000 });
  const [model, setModel] = useState<string | null>(null); const [slice, setSlice] = useState('all');
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.isError || !q.data) return <Card role="alert" className="text-bad">result not found</Card>;
  const r = q.data; const m = r.results.find((x) => x.model === model) ?? r.results[0]; const s = m?.score?.slices[slice] ?? m?.score?.slices.all;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2"><Link href="/evals" aria-label="Back to evals" className="min-h-touch min-w-touch text-xl">‹</Link><h1 className="text-lg font-semibold">{r.tag}</h1><span className="text-sm text-dim">{r.ts.slice(0, 16).replace('T', ' ')} · commit {r.commit ?? '?'} · {r.host}</span></div>
      <Card className="text-sm">{r.frames.dataset ?? 'frames'} ({r.frames.n}, {r.frames.scored} scored) × {r.labels?.dataset ?? 'no labels'} · threshold {r.threshold} · IoU {r.iou}</Card>
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <label>model <select value={m?.model ?? ''} onChange={(e) => setModel(e.target.value)} aria-label="Model" className="min-h-touch rounded-md border border-line bg-surface px-2">{r.results.map((x) => <option key={x.model}>{x.model}</option>)}</select></label>
        {m?.score && <label>slice <select value={slice} onChange={(e) => setSlice(e.target.value)} aria-label="Slice" className="min-h-touch rounded-md border border-line bg-surface px-2">{Object.keys(m.score.slices).map((k) => <option key={k}>{k}</option>)}</select></label>}
      </div>
      {m?.score && s && (
        <Section title="Scores">
          <Card className="text-sm"><div className="mb-2">horse recall <b>{f(s.classes.horse?.recall)}</b>{s.horse_recall_ci && <span className="text-dim"> [{f(s.horse_recall_ci.lo)}–{f(s.horse_recall_ci.hi)}]</span>} · AP <b>{f(s.horse_ap)}</b> · FPPF all <b>{f(s.fppf_all)}</b> · count-exact <b>{f(s.horse_count.exact)}</b> · R@FPPF≤0.1 <b>{f(m.score.operating_points.r_at_fppf01.recall)}</b>@{m.score.operating_points.r_at_fppf01.threshold ?? '–'} · R@P90 <b>{f(m.score.operating_points.r_at_p90.recall)}</b> · {s.frames} frames</div>
            <div className="overflow-x-auto"><table className="w-full"><caption className="sr-only">Per-class metrics</caption><thead><tr className="text-dim"><th className="text-left font-medium">class</th>{['gold', 'tp', 'fp', 'fn', 'P', 'R', 'AP'].map((h) => <th key={h} className="text-right font-medium">{h}</th>)}</tr></thead>
              <tbody>{Object.entries(s.classes).map(([k, c]) => <tr key={k} className="border-t border-line"><td>{k}</td><td className="text-right">{c.gold}</td><td className="text-right">{c.tp}</td><td className="text-right">{c.fp}</td><td className="text-right">{c.fn}</td><td className="text-right">{f(c.precision)}</td><td className="text-right">{f(c.recall)}</td><td className="text-right">{f(c.ap)}</td></tr>)}</tbody></table></div>
            {m.score.thresholds_by_label && <p className="mt-2 text-xs text-dim">thresholds: {Object.entries(m.score.thresholds_by_label).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>}
          </Card>
        </Section>
      )}
      {m?.latency && <Section title="Latency"><Card className="text-sm">p50 {m.latency.p50_ms.toFixed(1)} ms · p95 {m.latency.p95_ms.toFixed(1)} ms · peak RSS {m.latency.peak_rss_mb} MB</Card></Section>}
      <Section title="Command"><Card><pre className="whitespace-pre-wrap break-all font-mono text-xs text-dim">{r.command}</pre></Card></Section>
    </>
  );
}
