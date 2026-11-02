import { Card } from '@/components/ui';
import { formatUptime } from '@/lib/format';
import { tid } from '@/lib/testids';
import type { HomeData } from '@/lib/types';

export function HealthStrip({ d }: { d: HomeData }) {
  const h = d.health;
  const diskPct =
    h.disk.free_gb !== null && h.disk.total_gb ? Math.round((100 * h.disk.free_gb) / h.disk.total_gb) : null;
  const tile = (label: string, value: React.ReactNode, tone?: 'ok' | 'bad' | 'warn') => (
    <div className="bg-surface-2 flex min-w-[96px] shrink-0 flex-col rounded-md px-2.5 py-1.5">
      <span className="text-dim text-[11px] tracking-wider uppercase">{label}</span>
      <span className={`text-sm font-semibold ${tone ? `text-${tone}` : ''}`}>{value}</span>
    </div>
  );
  return (
    <Card
      data-testid={tid.healthStrip}
      role="region"
      aria-label="Health"
      tabIndex={0}
      className="focus-visible:outline-accent flex gap-2 overflow-x-auto p-2 focus-visible:outline"
    >
      {tile('host', `${h.host} · ${formatUptime(h.uptime_s)}`)}
      {tile('load', h.load.map((l) => l.toFixed(1)).join(' '))}
      {tile(
        'disk free',
        diskPct !== null ? `${h.disk.free_gb} GB · ${diskPct}%` : '–',
        diskPct !== null && diskPct < 10 ? 'warn' : undefined,
      )}
      {tile('daemons', `${h.daemons_up}/${h.daemons_total}`, h.daemons_up === h.daemons_total ? 'ok' : 'bad')}
      {tile('detector', `${h.detector.model ?? '–'} · tax v${h.taxonomy.version ?? '?'}`)}
      {tile('totals', `${d.totals.frames.toLocaleString()} frames · ${d.totals.detections.toLocaleString()} dets`)}
    </Card>
  );
}
