'use client';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { inp } from './inputClass';

export function AddForm({
  placeholder,
  onAdd,
  testid,
}: {
  placeholder: string;
  onAdd: (v: string) => void;
  testid?: string;
}) {
  const [v, setV] = useState('');
  return (
    <form
      className="inline-flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) {
          onAdd(v.trim());
          setV('');
        }
      }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        pattern="[a-z][a-z0-9_]*"
        className={`${inp} w-36`}
        {...(testid ? { 'data-testid': testid } : {})}
      />
      <Button type="submit">add</Button>
    </form>
  );
}
