'use client';
import Link from 'next/link';
import { useHome } from './useHome';
import { Card, Section, Badge, Skeleton } from '@/components/ui';
import { formatAge, formatUptime, localTime } from '@/lib/format';
import { tid } from '@/lib/testids';
import { useThumbVersion, useActivity } from '@/features/live/LiveProvider';
import { useTz } from '@/lib/tz';
import type { CameraCard as CameraCardT, HomeData } from '@/lib/types';

export function HomeView() {
  const { data, error, isPending } = useHome();
  if (isPending) return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-16" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  if (error || !data) return <Card role="alert" className="text-bad">daemon unreachable</Card>;
  return (
    <>
      <HealthStrip d={data} />
      <AlertList alerts={data.alerts} />
      <div className="md:grid md:grid-cols-[2fr_1fr] md:gap-4">
        <Section title="Cameras" id="cameras"><div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{data.cameras.map((c) => <CameraCard key={c.name} c={c} horseLabel={data.horse_label} />)}</div></Section>
        <ActivityFeed initial={data.activity} />
      </div>
      <DetectionsByCamera d={data} />
      <Section title="Events"><Card className="text-sm text-dim">{data.events.length ? data.events.map((e) => <div key={e.id}>{e.ts.slice(11, 19)} {e.camera} {e.type} {e.confidence.toFixed(2)} tier {e.tier_decided} {e.verdict ?? ''}</div>) : 'none yet (Phase 2)'}</Card></Section>
    </>
  );
}

function HealthStrip({ d }: { d: HomeData }) {
  const h = d.health; const diskPct = h.disk.free_gb !== null && h.disk.total_gb ? Math.round((100 * h.disk.free_gb) / h.disk.total_gb) : null;
  const tile = (label: string, value: React.ReactNode, tone?: 'ok' | 'bad' | 'warn') => <div className="flex min-w-[96px] shrink-0 flex-col rounded-md bg-surface-2 px-2.5 py-1.5"><span className="text-[11px] uppercase tracking-wider text-dim">{label}</span><span className={`text-sm font-semibold ${tone ? `text-${tone}` : ''}`}>{value}</span></div>;
  return (
    <Card data-testid={tid.healthStrip} className="flex gap-2 overflow-x-auto p-2">
      {tile('host', `${h.host} · ${formatUptime(h.uptime_s)}`)}
      {tile('load', h.load.map((l) => l.toFixed(1)).join(' '))}
      {tile('disk free', diskPct !== null ? `${h.disk.free_gb} GB · ${diskPct}%` : '–', diskPct !== null && diskPct < 10 ? 'warn' : undefined)}
      {tile('daemons', `${h.daemons_up}/${h.daemons_total}`, h.daemons_up === h.daemons_total ? 'ok' : 'bad')}
      {tile('detector', `${h.detector.model ?? '–'} · tax v${h.taxonomy.version ?? '?'}`)}
      {tile('totals', `${d.totals.frames.toLocaleString()} frames · ${d.totals.detections.toLocaleString()} dets`)}
    </Card>
  );
}
function AlertList({ alerts }: { alerts: HomeData['alerts'] }) {
  if (!alerts.length) return null;
  return <ul className="mt-3 grid gap-1">{alerts.map((a) => <li key={a.kind + a.text}><Link href={a.href} data-testid={tid.alert(a.kind, a.text.split(' ')[0] ?? '')} className={`flex min-h-touch items-center rounded-md px-3 text-sm ${a.severity === 'bad' ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn'}`}>▲ {a.text}<span className="flex-1" />›</Link></li>)}</ul>;
}
export function CameraCard({ c, horseLabel }: { c: CameraCardT; horseLabel: string }) {
  const v = useThumbVersion(c.name);
  return (
    <Link href={`/cameras/${c.name}`} data-testid={tid.cameraCard(c.name)} data-state={c.online ? 'online' : 'offline'} id={`camera-${c.name}`} className="block overflow-hidden rounded-card border border-line bg-surface hover:border-dim">
      <div className="relative aspect-video bg-black">
        <img src={`${c.thumb}?w=640&v=${v || encodeURIComponent(c.thumb_version)}`} alt={`${c.name} latest frame`} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        <span data-testid={tid.cameraCount(c.name)} className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">{horseLabel} <b>{c.equine_now ?? '–'}</b></span>
        <Badge tone={c.online ? 'ok' : 'bad'} data-testid={tid.cameraOnline(c.name)}><span className="absolute top-1.5 right-1.5">{c.online ? '● on' : '○ off'}</span></Badge>
      </div>
      <div className="p-2 text-sm"><b>{c.name}</b><div className="text-dim">{c.last_frame_age_s !== null ? `${formatAge(c.last_frame_age_s)} ago` : 'no frames'} · {c.frames_per_min}/min</div></div>
    </Link>
  );
}
function ActivityFeed({ initial }: { initial: HomeData['activity'] }) {
  const tz = useTz(); const live = useActivity();
  const liveItems = live.tracks.flatMap((e) => e.tracks.map((t) => ({ t: new Date(e.at).toISOString(), camera: e.camera, label: t.label, moving: t.moving, members: e.frames, seen: t.seen, conf: t.confidence, frame_id: e.burst_id, img: `/api/ui/frame/${e.burst_id}` })));
  const seen = new Set<string>(); const items = [...liveItems, ...initial].filter((i) => { const k = `${i.frame_id}|${i.label}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
  return (
    <Section title="Activity" action={<span className="text-xs text-dim">last hour</span>}>
      <Card className="max-h-[480px] overflow-auto p-0" data-testid={tid.activityFeed}>
        {items.length === 0 && <p className="p-3 text-sm text-dim">nothing tracked in the last hour</p>}
        <ul className="divide-y divide-line">{items.map((i) => (
          <li key={`${i.frame_id}-${i.label}`}><Link href={`/detections?camera=${i.camera}&frame=${i.frame_id}&since=24h`} className="flex min-h-touch items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2">
            <img src={`${i.img}?w=320`} alt="" loading="lazy" className="h-9 w-16 rounded-sm bg-black object-cover" />
            <span className="min-w-0 flex-1 truncate"><time dateTime={i.t} className="text-dim">{localTime(i.t, tz)}</time> <b>{i.camera.replace('_cam', '')}</b> {i.label}{i.seen > 1 ? ` ×${i.seen}` : ''}{i.moving ? ' · moving' : ''}{i.members > 1 ? ` · burst ×${i.members}` : ''}</span>›
          </Link></li>))}</ul>
      </Card>
    </Section>
  );
}
function DetectionsByCamera({ d }: { d: HomeData }) {
  const cams = d.cameras.map((c) => c.name); const labels = [...new Set(d.cameras.flatMap((c) => c.detections_1h.map((x) => x.label)))].sort((a, b) => (d.label_order.indexOf(a) + 1 || 99) - (d.label_order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const cell = new Map(d.cameras.flatMap((c) => c.detections_1h.map((x) => [`${c.name}|${x.label}`, x] as const)));
  return (
    <Section title="Detections · last hour" action={<Link href="/detections?since=1h" className="text-xs text-accent">browse all ›</Link>}>
      <Card className="overflow-x-auto p-0" data-testid={tid.detectionsMatrix}>
        {labels.length === 0 ? <p className="p-3 text-sm text-dim">none</p> : (
          <table className="w-full text-sm"><caption className="sr-only">Detections per camera and label in the last hour</caption>
            <thead><tr><th className="sticky left-0 bg-surface px-2 py-1 text-left font-medium text-dim">label</th>{cams.map((c) => <th key={c} className="px-2 py-1 text-right font-medium"><Link href={`/cameras/${c}`} className="text-accent">{c.replace('_cam', '')}</Link></th>)}</tr></thead>
            <tbody>{labels.map((l) => <tr key={l} className="border-t border-line"><td className={`sticky left-0 bg-surface px-2 py-1 ${l === 'horse' ? 'font-semibold text-ok' : ''}`}>{l}</td>{cams.map((c) => { const r = cell.get(`${c}|${l}`); const raw = r && Object.keys(r.raw).some((k) => k !== l); return <td key={c} className="px-2 py-1 text-right tabular-nums" title={raw ? Object.entries(r!.raw).map(([k, v]) => `${k} ${v}`).join(', ') : undefined}>{r ? <Link href={`/detections?camera=${c}&label=${l}&since=1h`} className="hover:underline">{r.n}</Link> : <span className="text-dim">·</span>}{r && <span className="text-dim"> {r.conf}{raw ? ' ◦' : ''}</span>}</td>; })}</tr>)}</tbody>
          </table>
        )}
      </Card>
    </Section>
  );
}
