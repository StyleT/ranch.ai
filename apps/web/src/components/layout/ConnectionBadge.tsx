'use client';
import { useConnection } from '@/features/live/LiveProvider';
import { tid } from '@/lib/testids';

export function ConnectionBadge() {
  const c = useConnection();
  const text = c.state === 'live' ? `live${c.ageS !== null ? ` ${c.ageS} s` : ''}` : c.state === 'stale' ? `updated ${c.ageS ?? '?'} s ago` : c.state === 'reconnecting' ? 'reconnecting…' : c.state === 'offline' ? 'offline' : 'connecting…';
  const color = c.state === 'live' ? 'bg-ok' : c.state === 'reconnecting' || c.state === 'connecting' ? 'bg-warn animate-pulse' : c.state === 'stale' ? 'bg-bad' : 'bg-dim';
  return (
    <span data-testid={tid.connection} data-connection={c.state} aria-live="polite" className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-dim">
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${color}`} />{text}
    </span>
  );
}
