import type { BridgeData } from '@/lib/types';
import { Card, Section, Badge } from '@/components/ui';
import { DataTable } from '@/components/table/DataTable';
import { formatUptime, localDateTime } from '@/lib/format';
import { nanosToMs, stateTone } from './bridgeFormat';
import { tid } from '@/lib/testids';

/** The bridge's own /metrics page, re-homed here: its UI on :5080 is loopback-only since 23 Oct because every visit
 *  attached one go2rtc consumer per camera (docs/CAMERA-ARCHITECTURE.md). Data via the daemon's /api/bridge. */
export function BridgeSection({ b, tz }: { b: BridgeData; tz: string }) {
  const tiles: [string, string | number][] = [
    ['cameras', b.bridge.camera_count],
    ['streaming', b.bridge.streaming_count],
    ['errored', b.bridge.error_count],
    ['SSE clients', b.bridge.sse_clients],
    [`up · v${b.bridge.version}`, formatUptime(b.bridge.uptime_s)],
  ];
  return (
    <Section
      title="Wyze bridge"
      action={
        <a className="text-accent text-xs underline" href="/api/ui/system">
          json
        </a>
      }
    >
      <Card className="grid gap-2 p-0">
        <div data-testid={tid.bridgeSummary} className="flex flex-wrap gap-4 px-3 pt-3 text-sm">
          {tiles.map(([k, v]) => (
            <div key={k}>
              <b className="block text-lg tabular-nums">{v}</b>
              <span className="text-dim text-xs">{k}</span>
            </div>
          ))}
        </div>
        <DataTable
          caption="Bridge camera state"
          rows={b.cameras}
          rowKey={(r) => r.name}
          rowTestId={(r) => tid.bridgeCamera(r.name)}
          columns={[
            { key: 'name', header: 'camera', cell: (r) => <b>{r.name.replace('_cam', '')}</b> },
            { key: 'state', header: 'state', cell: (r) => <Badge tone={stateTone(r.state)}>{r.state}</Badge> },
            { key: 'model', header: 'model', cell: (r) => r.model_name ?? r.model ?? '–', priority: 2 },
            {
              key: 'protocol',
              header: 'protocol',
              cell: (r) => `${r.protocol ?? '–'}${r.quality ? ` · ${r.quality}` : ''}`,
              priority: 2,
            },
            { key: 'errors', header: 'errors', cell: (r) => r.error_count ?? 0, align: 'right' },
            { key: 'rec', header: 'rec', cell: (r) => (r.recording ? '●' : '○'), priority: 3 },
          ]}
        />
        <DataTable
          caption="Wyze API calls"
          rows={b.wyzeapi}
          rowKey={(r) => r.Path}
          rowTestId={(r) => tid.bridgeApiRow(r.Path)}
          columns={[
            { key: 'path', header: 'Wyze API path', cell: (r) => <code className="text-xs">{r.Path}</code> },
            { key: 'calls', header: 'calls', cell: (r) => r.Count, align: 'right' },
            { key: 'errors', header: 'errors', cell: (r) => r.Errors, align: 'right' },
            { key: 'status', header: 'last', cell: (r) => r.LastStatus, align: 'right', priority: 2 },
            { key: 'lat', header: 'ms', cell: (r) => nanosToMs(r.LastLatency), align: 'right', priority: 2 },
            {
              key: 'at',
              header: 'last call',
              cell: (r) => <time dateTime={r.LastCall}>{localDateTime(r.LastCall, tz)}</time>,
              priority: 3,
            },
          ]}
        />
        <p className="text-dim px-3 pb-2 text-xs">
          The bridge UI (:5080) is reachable only from the mini: opening it attaches a go2rtc consumer per camera. Use{' '}
          <code>make tunnel</code>.
        </p>
      </Card>
    </Section>
  );
}
