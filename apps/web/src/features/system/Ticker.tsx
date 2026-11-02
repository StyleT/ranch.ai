'use client';
import { useState } from 'react';
import { Card, Button } from '@/components/ui';
import { localTime } from '@/lib/format';
import { useActivity } from '@/features/live/LiveProvider';

export function Ticker({ tz }: { tz: string }) {
  const a = useActivity();
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(a.raw);
  const rows = paused ? frozen : a.raw;
  return (
    <Card className="p-0">
      <div className="text-dim flex items-center px-2 py-1 text-xs">
        <span>{rows.length} messages</span>
        <span className="flex-1" />
        <Button
          onClick={() => {
            if (!paused) {
              setFrozen(a.raw);
            }
            setPaused((p) => !p);
          }}
          aria-pressed={paused}
          className="min-h-8"
        >
          {paused ? '▶ resume' : '⏸ pause'}
        </Button>
      </div>
      <ul className="max-h-72 overflow-auto font-mono text-[11px]">
        {rows.slice(0, 50).map((r) => (
          <li key={r.seq} className="border-line truncate border-t px-2 py-0.5">
            <span className="text-dim">{localTime(new Date(r.at).toISOString(), tz)}</span>{' '}
            <span className="text-accent">{r.topic}</span> {JSON.stringify(r.payload).slice(0, 220)}
          </li>
        ))}
      </ul>
    </Card>
  );
}
