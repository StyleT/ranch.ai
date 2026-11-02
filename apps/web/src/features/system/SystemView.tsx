'use client';
import { useQuery } from '@tanstack/react-query';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import type { SystemData } from '@/lib/types';
import { Card, Section, Badge, Skeleton } from '@/components/ui';
import { StatusKV } from '@/components/table/StatusKV';
import { DataTable } from '@/components/table/DataTable';
import { BarList } from '@/components/charts/BarList';
import { formatUptime, localTime, formatAge } from '@/lib/format';
import { useTz } from '@/lib/tz';
import { tid } from '@/lib/testids';
import { BridgeSection } from './BridgeSection';
import { Ticker } from './Ticker';

export const useSystem = () =>
  useQuery({ queryKey: keys.system(), queryFn: () => apiGet<SystemData>('/api/ui/system'), refetchInterval: 15_000 });

export function SystemView() {
  const q = useSystem();
  const tz = useTz();
  if (q.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card role="alert" className="text-bad">
        daemon unreachable
      </Card>
    );
  }
  const d = q.data;
  const up = d.daemons.filter((x) => x.up).length;
  return (
    <>
      <h1 className="mb-2 text-lg font-semibold">System</h1>
      <Card className="grid gap-2 text-sm md:grid-cols-2">
        <div>
          <b>{d.host}</b> · up {formatUptime(d.uptime_s)} · web {d.web.rss_mb} MB
          {d.web.build?.commit ? ` · build ${String(d.web.build.commit)}` : ''}
        </div>
        <div>
          frames {d.totals.frames.toLocaleString()} · detections {d.totals.detections.toLocaleString()} · events{' '}
          {d.totals.events}
          {` · buffer ${d.buffer.total.toLocaleString()} frames`}
        </div>
        <BarList
          rows={d.load.map((l, i) => ({ label: `load ${['1m', '5m', '15m'][i]}`, value: l }))}
          max={8}
          format={(v) => v.toFixed(2)}
        />
        <BarList
          rows={[
            {
              label: 'disk used',
              value: d.disk.total_gb && d.disk.free_gb !== null ? d.disk.total_gb - d.disk.free_gb : 0,
              hint: d.disk.free_gb !== null ? `${d.disk.free_gb} GB free` : '',
            },
          ]}
          max={d.disk.total_gb ?? 1}
          format={(v) => `${v} GB`}
        />
      </Card>
      <div className="md:grid md:grid-cols-[3fr_2fr] md:gap-4">
        <Section title={`Daemons ${up}/${d.daemons.length} up`}>
          <ul className="grid gap-2">
            {d.daemons.map((x) => (
              <li key={x.label} data-testid={tid.daemonRow(x.name)} data-state={x.up ? 'up' : 'down'}>
                <Card className="p-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <b>{x.name}</b>
                    <Badge tone={x.up ? 'ok' : 'bad'}>{x.up ? `pid ${x.pid}` : 'down'}</Badge>
                    <span className="text-dim">exit {x.last_exit}</span>
                    {x.rss_mb !== null && <span className="text-dim">rss {x.rss_mb} MB</span>}
                  </div>
                  <div className="mt-1" data-testid={`daemon-status-${x.name}`}>
                    <StatusKV daemon={x.name} status={x.status} />
                  </div>
                  {x.log && (
                    <details className="mt-1">
                      <summary className="text-dim cursor-pointer text-xs">› log</summary>
                      <pre className="text-dim mt-1 font-mono text-[11px] break-all whitespace-pre-wrap">{x.log}</pre>
                    </details>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </Section>
        <div>
          <Section title="Network probe">
            <Card className="p-0">
              <DataTable
                caption="Network probe per camera"
                rows={d.netprobe}
                rowKey={(r) => r.camera}
                rowTestId={(r) => tid.netprobeRow(r.camera)}
                columns={[
                  { key: 'camera', header: 'camera', cell: (r) => <b>{r.camera.replace('_cam', '')}</b> },
                  { key: 'ip', header: 'ip', cell: (r) => r.ip ?? '–', priority: 2 },
                  // connected = go2rtc holds a live session with the camera (producer alone only means "configured", 23 Oct)
                  {
                    key: 'connected',
                    header: 'conn',
                    cell: (r) => {
                      const v = r.connected ?? r.producer;
                      return v === null ? '–' : v ? '●' : '○';
                    },
                  },
                  { key: 'consumers', header: 'cons', cell: (r) => r.consumers ?? '–', align: 'right' },
                  {
                    key: 'rx',
                    header: 'MB/s',
                    cell: (r) => (r.rx_bytes_delta ? (r.rx_bytes_delta / 15 / 1048576).toFixed(2) : '–'),
                    align: 'right',
                  },
                  {
                    key: 'ping',
                    header: 'ping ms',
                    cell: (r) => (r.ping_ms === null ? '–' : Math.round(r.ping_ms)),
                    align: 'right',
                  },
                ]}
              />
              {d.wifi && (
                <p className="text-dim px-2 py-1 text-xs">
                  wifi{' '}
                  {Object.entries(d.wifi)
                    .map(([k, v]) => `${k} ${String(v)}`)
                    .join(' · ')}
                </p>
              )}
            </Card>
          </Section>
          <Section title="Camera availability · 24 h">
            <Card className="p-0" data-testid={tid.availability}>
              <DataTable
                caption="Camera availability over the last 24 hours"
                rows={d.availability}
                rowKey={(r) => r.camera}
                rowTestId={(r) => tid.availabilityRow(r.camera)}
                columns={[
                  { key: 'camera', header: 'camera', cell: (r) => <b>{r.camera.replace('_cam', '')}</b> },
                  {
                    key: 'avail',
                    header: 'connected',
                    cell: (r) =>
                      r.availability === null ? (
                        '–'
                      ) : (
                        <span className={r.availability < 0.9 ? 'text-bad' : r.availability < 0.99 ? 'text-warn' : ''}>
                          {(100 * r.availability).toFixed(1)}%
                        </span>
                      ),
                    align: 'right',
                  },
                  { key: 'outages', header: 'outages', cell: (r) => r.outages, align: 'right' },
                  {
                    key: 'p50',
                    header: 'p50',
                    cell: (r) => (r.outage_p50_s === null ? '–' : formatAge(r.outage_p50_s)),
                    align: 'right',
                    priority: 2,
                  },
                  {
                    key: 'max',
                    header: 'longest',
                    cell: (r) => (r.outage_max_s === null ? '–' : formatAge(r.outage_max_s)),
                    align: 'right',
                    priority: 2,
                  },
                  {
                    key: 'down',
                    header: 'down since',
                    cell: (r) =>
                      r.down_since ? (
                        <time dateTime={r.down_since} className="text-bad">
                          {localTime(r.down_since, tz, { second: undefined })}
                        </time>
                      ) : (
                        '–'
                      ),
                    priority: 2,
                  },
                ]}
              />
              {d.availability.length === 0 && <p className="text-dim px-3 py-2 text-xs">no probe history yet</p>}
            </Card>
          </Section>
          <Section title="Camera supervisor · ledger · 24 h">
            <Card className="p-0" data-testid={tid.remediation}>
              <DataTable
                caption="Supervisor decisions, newest first"
                rows={d.remediation}
                rowKey={(r) => String(r.id)}
                rowTestId={(r) => tid.remediationRow(r.id)}
                rowProps={(r) => ({ 'data-action': r.action })}
                columns={[
                  {
                    key: 'ts',
                    header: 'when',
                    cell: (r) => <time dateTime={r.ts}>{localTime(r.ts, tz, { second: undefined })}</time>,
                  },
                  { key: 'camera', header: 'camera', cell: (r) => <b>{r.camera.replace('_cam', '')}</b> },
                  {
                    key: 'action',
                    header: 'action',
                    cell: (r) => (
                      <Badge tone={r.action === 'down' ? 'bad' : r.action === 'alert' ? 'warn' : 'dim'}>
                        {r.action === 'down' ? 'outage' : r.action.replace('_', ' ')} · r{r.rung}
                        {r.dry_run ? ' · dry' : ''}
                      </Badge>
                    ),
                  },
                  {
                    key: 'outcome',
                    header: 'outcome',
                    cell: (r) =>
                      r.outcome ? (
                        `${r.outcome}${r.recovered_after_s !== null ? ` · ${formatAge(r.recovered_after_s)}` : ''}`
                      ) : (
                        <span className="text-dim">open</span>
                      ),
                  },
                  {
                    key: 'reason',
                    header: 'reason',
                    cell: (r) => <span className="text-dim text-xs">{r.reason}</span>,
                    priority: 2,
                  },
                ]}
              />
              {d.remediation.length === 0 && (
                <p className="text-dim px-3 py-2 text-xs">no outages or actions in the last 24 h</p>
              )}
            </Card>
          </Section>
          {d.bridge ? (
            <BridgeSection b={d.bridge} tz={tz} />
          ) : (
            <Section title="Wyze bridge">
              <Card className="text-dim text-sm">bridge metrics unavailable</Card>
            </Section>
          )}
          <Section title="Live MQTT">
            <Ticker tz={tz} />
          </Section>
        </div>
      </div>
    </>
  );
}
