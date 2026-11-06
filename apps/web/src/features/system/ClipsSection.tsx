// The clips pipeline per camera (docs/CLIPS.md): ring input -> motion -> candidates -> clips -> detector. Each column
// is one stage, so a stage that stopped shows where; the reasons repeat the Home tile's tone.
import Link from 'next/link';
import { Card, Section, Badge } from '@/components/ui';
import { DataTable } from '@/components/table/DataTable';
import { formatAge } from '@/lib/format';
import { tid } from '@/lib/testids';
import { RING_STALE_S, type ClipsHealth } from '@/lib/clips';

type Row = ClipsHealth['summary']['cameras'][number];

export function ClipsSection({ clips, nowMs }: { clips: ClipsHealth; nowMs: number }) {
  const s = clips.summary;
  const tot = (k: 'candidates' | 'cut' | 'single' | 'global' | 'stale') => s.cameras.reduce((n, c) => n + c.h24[k], 0);
  return (
    <Section
      id="clips"
      title="Clips pipeline · 1 h / 24 h"
      action={<Badge tone={clips.tone}>{clips.tone === 'ok' ? 'moving' : clips.tone}</Badge>}
    >
      <Card className="p-0" data-testid={tid.clipsSection} data-tone={clips.tone}>
        {clips.reasons.length > 0 && (
          <ul className="px-2 pt-2 text-xs">
            {clips.reasons.map((r) => (
              <li key={r} className={clips.tone === 'bad' ? 'text-bad' : 'text-warn'}>
                {r}
              </li>
            ))}
          </ul>
        )}
        <DataTable<Row>
          caption="Clips pipeline per camera"
          rows={s.cameras}
          rowKey={(r) => r.camera}
          rowTestId={(r) => tid.clipsRow(r.camera)}
          columns={[
            {
              key: 'camera',
              header: 'camera',
              cell: (r) => (
                <Link className="font-semibold underline" href={`/detections?camera=${r.camera}&clip=1&since=24h`}>
                  {r.camera.replace('_cam', '')}
                </Link>
              ),
            },
            {
              key: 'ring',
              header: 'ring',
              cell: (r) => (
                <span className={r.ring_age_s === null || r.ring_age_s > RING_STALE_S ? 'text-bad' : ''}>
                  {r.ring_age_s === null ? 'none' : formatAge(r.ring_age_s)}
                </span>
              ),
              align: 'right',
            },
            {
              key: 'motion',
              header: 'motion',
              cell: (r) => (r.motion_max === null ? '–' : r.motion_max.toFixed(2)),
              align: 'right',
              priority: 2,
            },
            { key: 'h1', header: '1h cut/cand', cell: (r) => `${r.h1.cut}/${r.h1.candidates}`, align: 'right' },
            { key: 'h24', header: '24h cut/cand', cell: (r) => `${r.h24.cut}/${r.h24.candidates}`, align: 'right' },
            {
              key: 'drops',
              header: 'dropped 24h',
              cell: (r) => `${r.h24.single}·${r.h24.global}·${r.h24.stale}`,
              align: 'right',
              priority: 2,
            },
            {
              key: 'last',
              header: 'last clip',
              cell: (r) => (r.h24.last_cut_ts ? formatAge((nowMs - Date.parse(r.h24.last_cut_ts)) / 1000) : '–'),
              align: 'right',
            },
          ]}
        />
        <p className="text-dim px-2 py-1 text-xs">
          24 h: {tot('cut')} clips of {tot('candidates')} candidates · dropped single {tot('single')} · global{' '}
          {tot('global')} · stale {tot('stale')} · open now{' '}
          {s.open_oldest_s === null ? 'none' : `oldest ${formatAge(s.open_oldest_s)}`} · detector queue{' '}
          {s.detector.inflight ?? '–'}
        </p>
      </Card>
    </Section>
  );
}
