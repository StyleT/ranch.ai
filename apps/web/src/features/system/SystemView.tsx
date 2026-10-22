'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import type { SystemData } from '@/lib/types';
import { Card, Section, Badge, Skeleton, Button } from '@/components/ui';
import { StatusKV } from '@/components/table/StatusKV';
import { DataTable } from '@/components/table/DataTable';
import { BarList } from '@/components/charts/BarList';
import { formatUptime, localTime } from '@/lib/format';
import { useTz } from '@/lib/tz';
import { useActivity } from '@/features/live/LiveProvider';
import { tid } from '@/lib/testids';

export const useSystem = () => useQuery({ queryKey: keys.system(), queryFn: () => apiGet<SystemData>('/api/ui/system'), refetchInterval: 15_000 });

export function SystemView() {
  const q = useSystem(); const tz = useTz();
  if (q.isPending) return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  if (q.isError || !q.data) return <Card role="alert" className="text-bad">daemon unreachable</Card>;
  const d = q.data; const up = d.daemons.filter((x) => x.up).length;
  return (
    <>
      <h1 className="mb-2 text-lg font-semibold">System</h1>
      <Card className="grid gap-2 text-sm md:grid-cols-2">
        <div><b>{d.host}</b> · up {formatUptime(d.uptime_s)} · web {d.web.rss_mb} MB{d.web.build?.commit ? ` · build ${String(d.web.build.commit)}` : ''}</div>
        <div>frames {d.totals.frames.toLocaleString()} · detections {d.totals.detections.toLocaleString()} · events {d.totals.events}{` · buffer ${d.buffer.total.toLocaleString()} frames`}</div>
        <BarList rows={d.load.map((l, i) => ({ label: `load ${['1m', '5m', '15m'][i]}`, value: l }))} max={8} format={(v) => v.toFixed(2)} />
        <BarList rows={[{ label: 'disk used', value: d.disk.total_gb && d.disk.free_gb !== null ? d.disk.total_gb - d.disk.free_gb : 0, hint: d.disk.free_gb !== null ? `${d.disk.free_gb} GB free` : '' }]} max={d.disk.total_gb ?? 1} format={(v) => `${v} GB`} />
      </Card>
      <div className="md:grid md:grid-cols-[3fr_2fr] md:gap-4">
        <Section title={`Daemons ${up}/${d.daemons.length} up`}>
          <ul className="grid gap-2">{d.daemons.map((x) => (
            <li key={x.label} data-testid={tid.daemonRow(x.name)} data-state={x.up ? 'up' : 'down'}><Card className="p-2">
              <div className="flex flex-wrap items-center gap-2 text-sm"><b>{x.name}</b><Badge tone={x.up ? 'ok' : 'bad'}>{x.up ? `pid ${x.pid}` : 'down'}</Badge><span className="text-dim">exit {x.last_exit}</span>{x.rss_mb !== null && <span className="text-dim">rss {x.rss_mb} MB</span>}</div>
              <div className="mt-1" data-testid={`daemon-status-${x.name}`}><StatusKV daemon={x.name} status={x.status} /></div>
              {x.log && <details className="mt-1"><summary className="cursor-pointer text-xs text-dim">› log</summary><pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-dim">{x.log}</pre></details>}
            </Card></li>))}</ul>
        </Section>
        <div>
          <Section title="Network probe"><Card className="p-0">
            <DataTable caption="Network probe per camera" rows={d.netprobe} rowKey={(r) => r.camera} rowTestId={(r) => tid.netprobeRow(r.camera)} columns={[
              { key: 'camera', header: 'camera', cell: (r) => <b>{r.camera.replace('_cam', '')}</b> }, { key: 'ip', header: 'ip', cell: (r) => r.ip ?? '–', priority: 2 },
              { key: 'producer', header: 'producer', cell: (r) => (r.producer === null ? '–' : r.producer ? '●' : '○') }, { key: 'consumers', header: 'cons', cell: (r) => r.consumers ?? '–', align: 'right' },
              { key: 'rx', header: 'MB/s', cell: (r) => (r.rx_bytes_delta ? (r.rx_bytes_delta / 15 / 1048576).toFixed(2) : '–'), align: 'right' }, { key: 'ping', header: 'ping ms', cell: (r) => (r.ping_ms === null ? '–' : Math.round(r.ping_ms)), align: 'right' },
            ]} />
            {d.wifi && <p className="px-2 py-1 text-xs text-dim">wifi {Object.entries(d.wifi).map(([k, v]) => `${k} ${String(v)}`).join(' · ')}</p>}
          </Card></Section>
          <Section title="Live MQTT"><Ticker tz={tz} /></Section>
        </div>
      </div>
    </>
  );
}
function Ticker({ tz }: { tz: string }) {
  const a = useActivity(); const [paused, setPaused] = useState(false); const [frozen, setFrozen] = useState(a.raw);
  const rows = paused ? frozen : a.raw;
  return <Card className="p-0"><div className="flex items-center px-2 py-1 text-xs text-dim"><span>{rows.length} messages</span><span className="flex-1" /><Button onClick={() => { if (!paused) setFrozen(a.raw); setPaused((p) => !p); }} aria-pressed={paused} className="min-h-8">{paused ? '▶ resume' : '⏸ pause'}</Button></div>
    <ul className="max-h-72 overflow-auto font-mono text-[11px]">{rows.slice(0, 50).map((r, i) => <li key={`${r.at}-${i}`} className="truncate border-t border-line px-2 py-0.5"><span className="text-dim">{localTime(new Date(r.at).toISOString(), tz)}</span> <span className="text-accent">{r.topic}</span> {JSON.stringify(r.payload).slice(0, 220)}</li>)}</ul></Card>;
}
