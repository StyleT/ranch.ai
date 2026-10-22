'use client';
import { useState } from 'react';
import type { ScoreResponse } from '@ranch/contracts';
import type { Taxonomy } from '@ranch/taxonomy/schema';
import { useTaxonomyMeta, useDraft, useToken, useTaxonomyActions } from './useTaxonomy';
import { allSubclasses, storedLabel, familyLabels, type Cls, type Action } from './draftReducer';
import { GateTable } from './GateTable';
import { Card, Section, Badge, Button, Skeleton } from '@/components/ui';
import { tid } from '@/lib/testids';
import { localDateTime } from '@/lib/format';
import { useTz } from '@/lib/tz';

const inp = 'min-h-touch rounded-md border border-line bg-bg px-2 text-sm';
const Chip = ({ children, onRemove, label }: { children: React.ReactNode; onRemove: () => void; label: string }) => <span className="m-0.5 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-sm">{children}<button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="min-h-touch min-w-6 text-dim hover:text-bad">×</button></span>;
function AddForm({ placeholder, onAdd, testid }: { placeholder: string; onAdd: (v: string) => void; testid?: string }) {
  const [v, setV] = useState('');
  return <form className="inline-flex gap-1" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } }}><input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} pattern="[a-z][a-z0-9_]*" className={`${inp} w-36`} {...(testid ? { 'data-testid': testid } : {})} /><Button type="submit">add</Button></form>;
}

export function TaxonomyEditor() {
  const tz = useTz(); const meta = useTaxonomyMeta(); const active = meta.data?.taxonomy as Taxonomy | undefined;
  const { draft, dispatch, dirty, discard } = useDraft(active, meta.data?.active.id); const { token, setToken } = useToken(); const acts = useTaxonomyActions();
  const [errors, setErrors] = useState<string[] | null>(null); const [ok, setOk] = useState<string | null>(null); const [score, setScore] = useState<ScoreResponse | null>(null); const [scoring, setScoring] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false); const [note, setNote] = useState('');
  if (meta.isPending || !draft) return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-12" /><Skeleton className="h-64" /></div>;
  if (meta.isError || !meta.data || !active) return <Card role="alert" className="text-bad">taxonomy unavailable</Card>;
  const m = meta.data; const d = (a: Action) => { dispatch(a); setOk(null); };
  const subs = allSubclasses(draft);
  const run = async (what: 'validate' | 'score') => {
    setErrors(null); setOk(null);
    if (what === 'validate') { const r = await acts.validate(draft); if (r.status === 200) setOk('valid'); else setErrors(r.body?.errors ?? ['invalid']); return; }
    setScoring(true); try { const r = await acts.score(draft); if (r.status === 200) setScore(r.body as ScoreResponse); else setErrors((r.body as { errors?: string[]; error?: string })?.errors ?? [(r.body as { error?: string })?.error ?? `HTTP ${r.status}`]); } finally { setScoring(false); }
  };
  const doApply = async () => {
    setErrors(null); const r = await acts.apply(draft, note, score && JSON.stringify(score.draft_taxonomy) === JSON.stringify(draft) ? score : null, token);
    if (r.status === 200) { setApplyOpen(false); setNote(''); setScore(null); setOk(`applied as v${r.body?.id}`); } else setErrors(r.body?.errors ?? [r.body?.error ?? `HTTP ${r.status}`]);
  };
  const doRevert = async (id: number) => { const n = window.prompt(`Revert to v${id}: note`); if (n === null) return; const r = await acts.revert(id, n, token); if (r.status === 200) setOk(`reverted as v${r.body?.id}`); else setErrors([r.body?.error ?? `HTTP ${r.status}`]); };
  const loadAsDraft = async (id: number) => { const v = await acts.loadVersion(id); dispatch({ type: 'reset', taxonomy: v.taxonomy as Taxonomy }); };
  return (
    <div data-dirty={dirty ? 'true' : 'false'}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm"><h1 className="text-lg font-semibold">Taxonomy</h1><span className="text-dim">active <b className="text-fg">v{m.active.id}</b> · {m.active.author} · {localDateTime(m.active.created, tz)}{m.active.gate ? ` · gate ${m.active.gate}` : ''}</span>{dirty && <Badge tone="warn">draft has changes</Badge>}</div>
      {!m.matches_repo && <p className="mb-2 rounded-md bg-warn/15 px-3 py-1.5 text-sm text-warn">taxonomy v{m.active.id} is not in git: run <code>make taxonomy-pull</code> on the laptop and commit, or the next provision supersedes it.</p>}
      <div className="sticky top-[44px] z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur">
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="write token" aria-label="Write token" data-testid={tid.taxAction('token')} className={`${inp} w-36`} />
        <Button onClick={() => void run('validate')} data-testid={tid.taxAction('validate')}>Validate</Button>
        <Button onClick={() => void run('score')} disabled={scoring} data-testid={tid.taxAction('score')}>{scoring ? 'scoring…' : 'Score draft'}</Button>
        <Button variant="primary" onClick={() => setApplyOpen(true)} disabled={!dirty} data-testid={tid.taxAction('apply')}>Apply…</Button>
        <Button onClick={() => { discard(); setScore(null); setErrors(null); }} disabled={!dirty} data-testid={tid.taxAction('discard')}>Discard draft</Button>
        {ok && <span className="text-sm text-ok" role="status">{ok}</span>}
      </div>
      {errors && <ul role="alert" className="mt-2 rounded-md bg-bad/15 px-3 py-1.5 text-sm text-bad">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {score && <Card className="mt-3"><GateTable r={score} /></Card>}
      {applyOpen && (
        <div role="dialog" aria-modal="true" aria-labelledby="apply-title" className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 md:items-center">
          <Card className="w-full max-w-lg rounded-b-none md:rounded-card">
            <h2 id="apply-title" className="mb-2 text-base font-semibold">Apply as v{m.active.id + 1}</h2>
            {score ? <p className="text-sm">gate <Badge tone={score.gate.pass ? 'ok' : 'bad'}>{score.gate.pass ? 'pass' : 'fail'}</Badge>{!score.gate.pass && <span className="text-dim"> · recorded on the version</span>}</p> : <p className="text-sm text-dim">draft not scored; apply records no gate</p>}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="what and why" rows={3} required aria-label="Note" data-testid={tid.taxAction('apply-note')} className={`${inp} mt-2 w-full py-1`} />
            <div className="mt-3 flex gap-2"><Button onClick={() => setApplyOpen(false)}>Cancel</Button><span className="flex-1" /><Button variant="primary" disabled={!note.trim() || !token} onClick={() => void doApply()} data-testid={tid.taxAction('apply-confirm')}>Apply</Button></div>
          </Card>
        </div>
      )}
      <Section title="Classes"><div className="grid gap-3 md:grid-cols-3">{(['animal', 'person', 'vehicle'] as Cls[]).map((cls) => { const c = draft.classes[cls]; return (
        <Card key={cls}><b>{cls}</b><div className="mt-1">{c.subclasses.map((s) => <Chip key={s} label={s} onRemove={() => d({ type: 'removeSubclass', cls, name: s })}>{s}</Chip>)}<AddForm placeholder="new subclass" onAdd={(v) => d({ type: 'addSubclass', cls, name: v })} testid={`tax-add-subclass-${cls}`} /></div>
          {c.attribute && <div className="mt-2 text-sm text-dim">{c.attribute.name}: {c.attribute.values ? <>{c.attribute.values.map((v) => <Chip key={v} label={v} onRemove={() => d({ type: 'removeAttrValue', cls, value: v })}>{v}</Chip>)}<AddForm placeholder="new value" onAdd={(v) => d({ type: 'addAttrValue', cls, value: v })} /></> : 'free text'}</div>}
        </Card>); })}</div></Section>
      <Section title="Ignored (never boxed)"><Card>{draft.ignored.map((x) => <Chip key={x} label={x} onRemove={() => d({ type: 'removeIgnored', name: x })}>{x}</Chip>)}<AddForm placeholder="never boxed" onAdd={(v) => d({ type: 'addIgnored', name: v })} /></Card></Section>
      <Section title="Model mappings" action={<span className="text-xs normal-case tracking-normal text-dim">raw label → class / subclass at a threshold; unmapped raw labels are dropped</span>}>
        {Object.entries(draft.mappings).map(([fam, map]) => (
          <Card key={fam} className="mb-3 overflow-x-auto"><b>{fam}</b>{m.detector_family === fam && <span className="ml-2 text-sm text-ok">● active in the detector ({m.detector_model})</span>}
            <table className="mt-1 w-full text-sm"><caption className="sr-only">Mappings for {fam}</caption><thead><tr className="text-dim"><th className="text-left font-medium">raw</th><th className="text-left font-medium">class / subclass</th><th className="text-left font-medium">stored</th><th className="text-left font-medium">threshold</th><th className="text-left font-medium">note</th><th /></tr></thead>
              <tbody>{Object.entries(map).map(([raw, mp]) => <tr key={raw} data-testid={tid.taxMapping(fam, raw)} className="border-t border-line"><td><code>{raw}</code></td>
                <td><select aria-label={`${raw} maps to`} value={`${mp.class}/${mp.subclass}`} onChange={(e) => { const [cls, sub] = e.target.value.split('/') as [Cls, string]; d({ type: 'setMapping', family: fam, raw, cls, subclass: sub }); }} className={inp}>{subs.map((s) => <option key={`${s.cls}/${s.subclass}`} value={`${s.cls}/${s.subclass}`}>{s.cls} / {s.subclass}</option>)}</select></td>
                <td className="text-dim">{storedLabel(mp.class, mp.subclass)}</td>
                <td><input type="number" step={0.05} min={0} max={1} value={mp.threshold} aria-label={`${raw} threshold`} data-testid={tid.taxThreshold(fam, raw)} onChange={(e) => d({ type: 'setThreshold', family: fam, raw, threshold: Number(e.target.value) })} className={`${inp} w-20`} /></td>
                <td><input value={mp.note ?? ''} aria-label={`${raw} note`} onChange={(e) => d({ type: 'setNote', family: fam, raw, note: e.target.value })} className={`${inp} w-full min-w-40`} /></td>
                <td><Button onClick={() => d({ type: 'removeMapping', family: fam, raw })} aria-label={`Remove mapping ${raw}`}>×</Button></td></tr>)}</tbody></table>
            <AddMapping subs={subs} onAdd={(raw, cls, sub, thr) => { d({ type: 'setMapping', family: fam, raw, cls, subclass: sub }); d({ type: 'setThreshold', family: fam, raw, threshold: thr }); }} />
          </Card>
        ))}
        <AddForm placeholder="new model family" onAdd={(v) => d({ type: 'addFamily', family: v })} />
      </Section>
      <Section title="Label order"><Card>{draft.label_order.map((l, i) => <span key={l} className="m-0.5 inline-flex items-center gap-0.5 rounded-full bg-surface-2 px-2 py-0.5 text-sm">{l}<button type="button" aria-label={`Move ${l} up`} onClick={() => d({ type: 'moveOrder', index: i, delta: -1 })} className="min-w-6 text-dim">▲</button><button type="button" aria-label={`Move ${l} down`} onClick={() => d({ type: 'moveOrder', index: i, delta: 1 })} className="min-w-6 text-dim">▼</button><button type="button" aria-label={`Remove ${l} from order`} onClick={() => d({ type: 'removeOrder', index: i })} className="min-w-6 text-dim hover:text-bad">×</button></span>)}
        <select aria-label="Add label to order" className={`${inp} ml-2`} value="" onChange={(e) => { if (e.target.value) d({ type: 'addOrder', label: e.target.value }); }}><option value="">add…</option>{['person', ...new Set(subs.map((s) => s.subclass))].filter((l) => !draft.label_order.includes(l)).map((l) => <option key={l}>{l}</option>)}</select></Card></Section>
      <Section title="Scoring map" action={<span className="text-xs normal-case tracking-normal text-dim">subclass → the label a family can express</span>}>{Object.keys(draft.mappings).map((fam) => { const labels = familyLabels(draft, fam); const sm = draft.scoring_map[fam] ?? {}; return (
        <Card key={fam} className="mb-3"><b>{fam}</b><div className="mt-1 grid gap-1">{Object.entries(sm).map(([s, l]) => <div key={s} className="flex items-center gap-2 text-sm">{s} → <select aria-label={`${s} scores as`} value={l} onChange={(e) => d({ type: 'setScoring', family: fam, subclass: s, label: e.target.value })} className={inp}>{labels.map((x) => <option key={x}>{x}</option>)}</select><Button onClick={() => d({ type: 'removeScoring', family: fam, subclass: s })} aria-label={`Remove scoring for ${s}`}>×</Button></div>)}</div>
          <AddScoring subs={subs.map((s) => s.subclass).filter((s) => !(s in sm))} labels={labels} onAdd={(s, l) => d({ type: 'setScoring', family: fam, subclass: s, label: l })} /></Card>); })}</Section>
      <Section title="History"><Card className="overflow-x-auto p-0"><table className="w-full text-sm"><caption className="sr-only">Taxonomy versions</caption><thead><tr className="text-dim"><th className="px-2 py-1 text-left font-medium">v</th><th className="px-2 py-1 text-left font-medium">created</th><th className="px-2 py-1 text-left font-medium">author</th><th className="px-2 py-1 text-left font-medium">note</th><th className="px-2 py-1 text-left font-medium">gate</th><th className="px-2 py-1 text-left font-medium">horse R / FPPF</th><th /></tr></thead>
        <tbody>{m.versions.map((v) => <tr key={v.id} id={`tax-version-${v.id}`} data-testid={tid.taxVersion(v.id)} data-state={v.active ? 'active' : 'inactive'} className={`border-t border-line ${v.active ? 'text-ok' : ''}`}><td className="px-2 py-1">v{v.id}</td><td className="px-2 py-1"><time dateTime={v.created}>{localDateTime(v.created, tz)}</time></td><td className="px-2 py-1">{v.author}</td><td className="px-2 py-1">{v.note}</td><td className="px-2 py-1">{v.gate ?? ''}</td><td className="px-2 py-1 tabular-nums">{v.score_summary ? `${v.score_summary.horse_recall.toFixed(2)} / ${v.score_summary.fppf_all.toFixed(2)}` : ''}</td>
          <td className="px-2 py-1 whitespace-nowrap">{v.active ? 'active' : <><Button onClick={() => void loadAsDraft(v.id)} className="mr-1">load as draft</Button><Button onClick={() => void doRevert(v.id)} disabled={!token}>revert to</Button></>}</td></tr>)}</tbody></table></Card></Section>
    </div>
  );
}
function AddMapping({ subs, onAdd }: { subs: { cls: Cls; subclass: string }[]; onAdd: (raw: string, cls: Cls, sub: string, thr: number) => void }) {
  const [raw, setRaw] = useState(''); const [sub, setSub] = useState(subs[0] ? `${subs[0].cls}/${subs[0].subclass}` : ''); const [thr, setThr] = useState(0.5);
  return <form className="mt-2 flex flex-wrap items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (!raw.trim() || !sub) return; const [cls, s] = sub.split('/') as [Cls, string]; onAdd(raw.trim(), cls, s, thr); setRaw(''); }}>
    <input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="raw label (model class)" aria-label="Raw label" className={`${inp} w-44`} /><select value={sub} onChange={(e) => setSub(e.target.value)} aria-label="Subclass" className={inp}>{subs.map((s) => <option key={`${s.cls}/${s.subclass}`} value={`${s.cls}/${s.subclass}`}>{s.cls} / {s.subclass}</option>)}</select>
    <input type="number" step={0.05} min={0} max={1} value={thr} onChange={(e) => setThr(Number(e.target.value))} aria-label="Threshold" className={`${inp} w-20`} /><Button type="submit">add mapping</Button></form>;
}
function AddScoring({ subs, labels, onAdd }: { subs: string[]; labels: string[]; onAdd: (s: string, l: string) => void }) {
  const [s, setS] = useState(''); const [l, setL] = useState(labels[0] ?? '');
  return <form className="mt-2 flex flex-wrap items-center gap-1 text-sm" onSubmit={(e) => { e.preventDefault(); if (s && l) onAdd(s, l); }}><select value={s} onChange={(e) => setS(e.target.value)} aria-label="Subclass" className={inp}><option value="">subclass…</option>{subs.map((x) => <option key={x}>{x}</option>)}</select> → <select value={l} onChange={(e) => setL(e.target.value)} aria-label="Label" className={inp}>{labels.map((x) => <option key={x}>{x}</option>)}</select><Button type="submit">add</Button></form>;
}
