'use client';
import { useState } from 'react';
import type { FilterState } from '@/lib/filters/urlState';
import { tid } from '@/lib/testids';
import { useBaselineSets } from './useDetections';

const sel = 'min-h-touch rounded-md border border-line bg-surface px-2 text-sm';
export function FilterBar({ f, onChange, cameras, labels, lockCamera = false }: { f: FilterState; onChange: (next: Partial<FilterState>) => void; cameras: string[]; labels: string[]; lockCamera?: boolean }) {
  const sets = useBaselineSets(); const set = sets.data?.find((s) => s.date === f.set);
  const [more, setMore] = useState(false);
  const extraCount = [f.min_conf !== null, f.reason !== null, f.with_detections, f.moving].filter(Boolean).length;
  return (
    <form role="search" aria-label="Detection filters" onSubmit={(e) => e.preventDefault()} className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {sets.data && sets.data.length > 0 && (
          <select data-testid={tid.filter('set')} aria-label="Source" className={sel} value={f.set ?? ''} onChange={(e) => onChange({ set: e.target.value || null, model: e.target.value ? (sets.data!.find((s) => s.date === e.target.value)?.models.find((m) => !m.startsWith('labels:')) ?? null) : null, frame: null, seq: 0 })}>
            <option value="">live frames</option>{sets.data.map((s) => <option key={s.date} value={s.date}>baseline {s.date} ({s.n})</option>)}
          </select>
        )}
        {set && <select data-testid={tid.filter('model')} aria-label="Overlay" className={sel} value={f.model ?? ''} onChange={(e) => onChange({ model: e.target.value || null })}>{set.models.map((m) => <option key={m} value={m}>{m.startsWith('labels:') ? `labels · ${m.slice(7)}` : m}</option>)}</select>}
        {!lockCamera && <select data-testid={tid.filter('camera')} aria-label="Camera" className={sel} value={f.camera ?? ''} onChange={(e) => onChange({ camera: e.target.value || null })}><option value="">all cameras</option>{cameras.map((c) => <option key={c}>{c}</option>)}</select>}
        {!set && <select data-testid={tid.filter('since')} aria-label="Window" className={sel} value={f.since} onChange={(e) => onChange({ since: e.target.value as FilterState['since'] })}><option value="1h">last hour</option><option value="6h">6 h</option><option value="24h">24 h</option><option value="7d">7 days</option></select>}
        <select data-testid={tid.filter('label')} aria-label="Label" className={sel} value={f.label ?? ''} onChange={(e) => onChange({ label: e.target.value || null })}><option value="">any label</option>{labels.map((l) => <option key={l}>{l}</option>)}</select>
        <button type="button" className={`${sel} text-dim md:hidden`} onClick={() => setMore((v) => !v)} aria-expanded={more}>⚲ more{extraCount ? ` (${extraCount})` : ''}</button>
      </div>
      <div className={`flex-wrap items-center gap-3 ${more ? 'flex' : 'hidden md:flex'}`}>
        <label className="flex items-center gap-1 text-sm">min conf <input data-testid={tid.filter('min-conf')} type="number" min={0} max={1} step={0.05} className={`${sel} w-20`} value={f.min_conf ?? ''} onChange={(e) => onChange({ min_conf: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        {!set && <select data-testid={tid.filter('reason')} aria-label="Reason" className={sel} value={f.reason ?? ''} onChange={(e) => onChange({ reason: (e.target.value || null) as FilterState['reason'] })}><option value="">any reason</option><option value="change">scene change</option><option value="floor">floor</option></select>}
        <label className="flex min-h-touch items-center gap-1.5 text-sm"><input data-testid={tid.filter('with-detections')} type="checkbox" checked={f.with_detections} onChange={(e) => onChange({ with_detections: e.target.checked })} /> only with detections</label>
        {!set && <label className="flex min-h-touch items-center gap-1.5 text-sm"><input data-testid={tid.filter('moving')} type="checkbox" checked={f.moving} onChange={(e) => onChange({ moving: e.target.checked })} /> moving only</label>}
      </div>
    </form>
  );
}
