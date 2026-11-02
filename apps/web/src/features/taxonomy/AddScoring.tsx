'use client';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { inp } from './inputClass';

export function AddScoring({
  subs,
  labels,
  onAdd,
}: {
  subs: string[];
  labels: string[];
  onAdd: (s: string, l: string) => void;
}) {
  const [s, setS] = useState('');
  const [l, setL] = useState(labels[0] ?? '');
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-1 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (s && l) {
          onAdd(s, l);
        }
      }}
    >
      <select value={s} onChange={(e) => setS(e.target.value)} aria-label="Subclass" className={inp}>
        <option value="">subclass…</option>
        {subs.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>{' '}
      →{' '}
      <select value={l} onChange={(e) => setL(e.target.value)} aria-label="Label" className={inp}>
        {labels.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      <Button type="submit">add</Button>
    </form>
  );
}
