'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useCamera } from './useCamera';
import { useHome } from '@/features/home/useHome';
import { StreamPlayer } from './StreamPlayer';
import { StepLine } from '@/components/charts/StepLine';
import { TimelineStrip } from '@/components/charts/TimelineStrip';
import { Card, Section, Badge, Skeleton } from '@/components/ui';
import { DetectionsBrowser } from '@/features/detections/DetectionsBrowser';
import { formatAge, localTime } from '@/lib/format';
import { useTz } from '@/lib/tz';
import { useThumbVersion } from '@/features/live/LiveProvider';

const WINDOWS = ['1h', '6h', '24h', '7d'] as const;
export function CameraView({ name }: { name: string }) {
  const [win, setWin] = useState<(typeof WINDOWS)[number]>('24h');
  const tz = useTz(); const q = useCamera(name, win); const home = useHome(); const v = useThumbVersion(name);
  if (q.isPending) return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-8 w-64" /><Skeleton className="aspect-video" /><Skeleton className="h-40" /></div>;
  if (q.isError || !q.data) return <Card role="alert" className="text-bad">camera {name}: {q.error?.message ?? 'not found'}</Card>;
  const d = q.data; const c = d.camera; const horse = home.data?.horse_label ?? 'equine';
  const poster = `${c.thumb}?w=1280&v=${v || encodeURIComponent(c.thumb_version)}`;
  const net = d.net as { producer?: boolean; consumers?: number; rx_bytes_delta?: number; ping_ms?: number | null } | null;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2"><Link href="/#cameras" aria-label="Back to home" className="min-h-touch min-w-touch text-xl">‹</Link><h1 className="text-lg font-semibold">{name}</h1><Badge tone={c.online ? 'ok' : 'bad'}>{c.online ? 'online' : 'offline'}</Badge><span className="text-sm text-dim">{c.last_frame_age_s !== null ? `${formatAge(c.last_frame_age_s)} ago` : ''} · {c.model ?? '–'} · {c.fw ?? ''} · {c.ip ?? ''}</span></div>
      <div className="md:grid md:grid-cols-[3fr_2fr] md:gap-4">
        <div>
          <StreamPlayer camera={name} excluded={d.stream.excluded} poster={poster} />
          <p className="mt-1 text-xs text-dim">{c.frames_per_min}/min · {horse}s now <b className="text-fg">{c.equine_now ?? '–'}</b></p>
          <Section title="Recent bursts"><div className="flex gap-2 overflow-x-auto pb-1">{d.bursts.length === 0 && <span className="text-sm text-dim">none in this window</span>}{d.bursts.map((b) => <Link key={b.frame_id} href={`/cameras/${name}?frame=${b.frame_id}&since=${win}`} className="shrink-0"><img src={`${b.img}?w=320`} alt={`burst at ${localTime(b.t, tz)}: ${b.labels.join(', ')}`} className="h-16 w-28 rounded-sm bg-black object-cover" /><span className="block text-[11px] text-dim">{localTime(b.t, tz, { second: undefined })} ×{b.members}{b.moving ? ' ➜' : ''}</span></Link>)}</div></Section>
        </div>
        <div>
          <Section title="History" action={<div role="radiogroup" aria-label="Window" className="flex gap-1">{WINDOWS.map((w) => <button key={w} role="radio" aria-checked={win === w} onClick={() => setWin(w)} className={`min-h-touch rounded-md px-2 text-xs ${win === w ? 'bg-surface-2 text-fg' : 'text-dim'}`}>{w}</button>)}</div>}>
            <Card className="grid gap-3">
              <TimelineStrip points={d.online_series} tz={tz} title={`online · ${win}`} />
              <StepLine points={d.equine_series} tz={tz} title={`${horse} count · ${win}`} />
            </Card>
          </Section>
          <Section title="Signal"><Card className="grid gap-1 text-sm">
            <div><span className="text-dim">motion</span> {d.motion ? `p50 ${d.motion.p50} · p90 ${d.motion.p90} · max ${d.motion.max}` : '–'}</div>
            <div><span className="text-dim">net</span> {net ? `${net.producer ? '● producer' : '○ no producer'} · ${net.consumers ?? 0} consumer${net.consumers === 1 ? '' : 's'} · ${net.rx_bytes_delta ? (net.rx_bytes_delta / 15 / 1048576).toFixed(2) + ' MB/s' : '–'} · ping ${net.ping_ms === null || net.ping_ms === undefined ? '–' : Math.round(net.ping_ms) + ' ms'}` : '–'}</div>
            <div><span className="text-dim">frame</span> {c.width && c.height ? `${c.width}×${c.height}` : '–'}</div>
          </Card></Section>
        </div>
      </div>
      <Section title="Detections"><Suspense><DetectionsBrowser cameras={[name]} labels={home.data?.label_order ?? []} lockCamera={name} cols="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" /></Suspense></Section>
    </>
  );
}
