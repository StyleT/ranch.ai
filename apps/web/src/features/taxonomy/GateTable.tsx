import type { ScoreResponse, ScoreSummary } from '@ranch/contracts';
import { tid } from '@/lib/testids';
import { Badge } from '@/components/ui';

const f = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toFixed(2));
export function delta(a: number | null | undefined, b: number | null | undefined, lowerIsBetter = false): { text: string; good: boolean } | null {
  if (a === null || a === undefined || b === null || b === undefined) return null; const x = b - a; if (Math.abs(x) < 1e-9) return null;
  return { text: `${x > 0 ? '+' : ''}${x.toFixed(2)}`, good: lowerIsBetter ? x < 0 : x > 0 };
}
const Delta = ({ d }: { d: ReturnType<typeof delta> }) => (d ? <span className={`ml-1 text-xs ${d.good ? 'text-ok' : 'text-bad'}`}>({d.text})</span> : null);
const METRICS: { key: string; label: string; get: (s: ScoreSummary) => number | null; lower?: boolean }[] = [
  { key: 'horse_recall', label: 'horse recall', get: (s) => s.horse_recall }, { key: 'horse_ap', label: 'horse AP', get: (s) => s.horse_ap }, { key: 'horse_precision', label: 'horse precision', get: (s) => s.horse_precision },
  { key: 'fppf_all', label: 'FPPF all', get: (s) => s.fppf_all, lower: true }, { key: 'count_exact', label: 'count-exact', get: (s) => s.count_exact },
  { key: 'day_recall', label: 'horse recall · day', get: (s) => s.day_recall }, { key: 'night_recall', label: 'horse recall · night', get: (s) => s.night_recall },
];
export function GateTable({ r }: { r: ScoreResponse }) {
  const classes = [...new Set([...Object.keys(r.active.classes), ...Object.keys(r.draft.classes)])];
  return (
    <div data-testid={tid.gateTable} data-gate={r.gate.pass ? 'pass' : 'fail'} className="text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2"><b>{r.model}</b><span className="text-dim">on {r.frames_dataset} × {r.labels_dataset}</span><Badge tone={r.gate.pass ? 'ok' : 'bad'}>gate {r.gate.pass ? 'pass' : 'FAIL'}</Badge><span className="text-xs text-dim">{r.ms} ms</span></div>
      {r.gate.reasons.length > 0 && <ul className="mb-2 text-xs text-bad">{r.gate.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="overflow-x-auto"><table className="w-full"><caption className="sr-only">Gate metrics, active versus draft</caption>
        <thead><tr className="text-dim"><th className="text-left font-medium">metric</th><th className="text-right font-medium">active v{r.active_version ?? '?'}</th><th className="text-right font-medium">draft</th></tr></thead>
        <tbody>{METRICS.map((m) => { const a = m.get(r.active), b = m.get(r.draft); return <tr key={m.key} data-testid={tid.gateRow(m.key)} className="border-t border-line"><td>{m.label}</td><td className="text-right tabular-nums">{f(a)}{m.key === 'horse_recall' && r.active.horse_ci && <span className="text-xs text-dim"> [{f(r.active.horse_ci.lo)}–{f(r.active.horse_ci.hi)}]</span>}</td><td className="text-right tabular-nums">{f(b)}<Delta d={delta(a, b, m.lower)} />{m.key === 'horse_recall' && r.draft.horse_ci && <span className="text-xs text-dim"> [{f(r.draft.horse_ci.lo)}–{f(r.draft.horse_ci.hi)}]</span>}</td></tr>; })}</tbody>
      </table></div>
      <div className="mt-2 overflow-x-auto"><table className="w-full"><caption className="sr-only">Per-class precision and recall</caption>
        <thead><tr className="text-dim"><th className="text-left font-medium">class</th><th className="text-right font-medium">gold</th><th className="text-right font-medium">active P / R</th><th className="text-right font-medium">draft P / R</th></tr></thead>
        <tbody>{classes.map((c) => { const a = r.active.classes[c], b = r.draft.classes[c]; return <tr key={c} className="border-t border-line"><td>{c}</td><td className="text-right tabular-nums">{b?.gold ?? a?.gold ?? ''}</td><td className="text-right tabular-nums">{a ? `${f(a.precision)} / ${f(a.recall)}` : '–'}</td><td className="text-right tabular-nums">{b ? <>{f(b.precision)}<Delta d={delta(a?.precision, b.precision)} /> / {f(b.recall)}<Delta d={delta(a?.recall, b.recall)} /></> : <span className="text-bad">no longer scored</span>}</td></tr>; })}</tbody>
      </table></div>
    </div>
  );
}
