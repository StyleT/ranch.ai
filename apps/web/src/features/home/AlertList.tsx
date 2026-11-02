import Link from 'next/link';
import { tid } from '@/lib/testids';
import type { HomeData } from '@/lib/types';

export function AlertList({ alerts }: { alerts: HomeData['alerts'] }) {
  if (!alerts.length) {
    return null;
  }
  return (
    <ul className="mt-3 grid gap-1">
      {alerts.map((a) => (
        <li key={a.kind + a.text}>
          <Link
            href={a.href}
            data-testid={tid.alert(a.kind, a.text.split(' ')[0] ?? '')}
            className={`min-h-touch flex items-center rounded-md px-3 text-sm ${a.severity === 'bad' ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn'}`}
          >
            ▲ {a.text}
            <span className="flex-1" />›
          </Link>
        </li>
      ))}
    </ul>
  );
}
