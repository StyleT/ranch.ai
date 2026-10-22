'use client';
// Scaffold home (milestone 2): health strip + camera list from /api/ui/home. The full dashboard lands in M3a.
import { useHome } from './useHome';
import { Card, Section, Badge, Skeleton } from '@/components/ui';
import { formatAge, formatUptime } from '@/lib/format';
import { tid } from '@/lib/testids';

export function HomeView() {
  const { data, error, isPending } = useHome();
  if (isPending) return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-16" /><Skeleton className="h-40" /></div>;
  if (error || !data) return <Card role="alert" className="text-bad">daemon unreachable</Card>;
  return (
    <>
      <Card data-testid={tid.healthStrip} className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span><b>{data.health.host}</b> up {formatUptime(data.health.uptime_s)}</span>
        <span>load {data.health.load.map((l) => l.toFixed(2)).join(' ')}</span>
        <span>disk {data.health.disk.free_gb ?? '–'} / {data.health.disk.total_gb ?? '–'} GB</span>
        <span>daemons {data.health.daemons_up}/{data.health.daemons_total}</span>
        <span>{data.health.detector.model ?? '–'} · tax v{data.health.taxonomy.version ?? '?'}</span>
      </Card>
      {data.alerts.length > 0 && (
        <ul className="mt-3 grid gap-1">{data.alerts.map((a) => <li key={a.kind + a.text} data-testid={tid.alert(a.kind)} className={`rounded-md px-3 py-1.5 text-sm ${a.severity === 'bad' ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn'}`}>▲ {a.text}</li>)}</ul>
      )}
      <Section title="Cameras">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {data.cameras.map((c) => (
            <Card key={c.name} data-testid={tid.cameraCard(c.name)} data-state={c.online ? 'online' : 'offline'} className="p-0 overflow-hidden">
              <img src={`${c.thumb}?w=640&v=${encodeURIComponent(c.thumb_version)}`} alt={`${c.name} latest frame`} loading="lazy" className="aspect-video w-full bg-black object-cover" />
              <div className="p-2 text-sm">
                <div className="flex items-center justify-between"><b>{c.name}</b><Badge tone={c.online ? 'ok' : 'bad'} data-testid={tid.cameraOnline(c.name)}>{c.online ? 'on' : 'off'}</Badge></div>
                <div className="text-dim">{c.last_frame_age_s !== null ? `${formatAge(c.last_frame_age_s)} ago` : 'no frames'} · {data.horse_label}s <b data-testid={tid.cameraCount(c.name)}>{c.equine_now ?? '–'}</b></div>
              </div>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}
