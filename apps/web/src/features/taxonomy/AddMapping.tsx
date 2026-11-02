'use client';
import { useState } from 'react';
import { Button } from '@/components/ui';
import type { Cls } from './draftReducer';
import { inp } from './inputClass';

export function AddMapping({
  subs,
  onAdd,
}: {
  subs: { cls: Cls; subclass: string }[];
  onAdd: (raw: string, cls: Cls, sub: string, thr: number) => void;
}) {
  const [raw, setRaw] = useState('');
  const [sub, setSub] = useState(subs[0] ? `${subs[0].cls}/${subs[0].subclass}` : '');
  const [thr, setThr] = useState(0.5);
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!raw.trim() || !sub) {
          return;
        }
        const [cls, s] = sub.split('/') as [Cls, string];
        onAdd(raw.trim(), cls, s, thr);
        setRaw('');
      }}
    >
      <input
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="raw label (model class)"
        aria-label="Raw label"
        className={`${inp} w-44`}
      />
      <select value={sub} onChange={(e) => setSub(e.target.value)} aria-label="Subclass" className={inp}>
        {subs.map((s) => (
          <option key={`${s.cls}/${s.subclass}`} value={`${s.cls}/${s.subclass}`}>
            {s.cls} / {s.subclass}
          </option>
        ))}
      </select>
      <input
        type="number"
        step={0.05}
        min={0}
        max={1}
        value={thr}
        onChange={(e) => setThr(Number(e.target.value))}
        aria-label="Threshold"
        className={`${inp} w-20`}
      />
      <Button type="submit">add mapping</Button>
    </form>
  );
}
