import Link from 'next/link';
import { Card, Section } from '@/components/ui';
import { tid } from '@/lib/testids';
import type { HomeData } from '@/lib/types';

export function DetectionsByCamera({ d }: { d: HomeData }) {
  const cams = d.cameras.map((c) => c.name);
  const labels = [...new Set(d.cameras.flatMap((c) => c.detections_1h.map((x) => x.label)))].sort(
    (a, b) => (d.label_order.indexOf(a) + 1 || 99) - (d.label_order.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  const cell = new Map(d.cameras.flatMap((c) => c.detections_1h.map((x) => [`${c.name}|${x.label}`, x] as const)));
  return (
    <Section
      title="Detections · last hour"
      action={
        <Link href="/detections?since=1h" className="text-accent text-xs">
          browse all ›
        </Link>
      }
    >
      <Card className="overflow-x-auto p-0" data-testid={tid.detectionsMatrix}>
        {labels.length === 0 ? (
          <p className="text-dim p-3 text-sm">none</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Detections per camera and label in the last hour</caption>
            <thead>
              <tr>
                <th className="bg-surface text-dim sticky left-0 px-2 py-1 text-left font-medium">label</th>
                {cams.map((c) => (
                  <th key={c} className="px-2 py-1 text-right font-medium">
                    <Link href={`/cameras/${c}`} className="text-accent">
                      {c.replace('_cam', '')}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((l) => (
                <tr key={l} className="border-line border-t">
                  <td className={`bg-surface sticky left-0 px-2 py-1 ${l === 'horse' ? 'text-ok font-semibold' : ''}`}>
                    {l}
                  </td>
                  {cams.map((c) => {
                    const r = cell.get(`${c}|${l}`);
                    const raw = r && Object.keys(r.raw).some((k) => k !== l);
                    return (
                      <td
                        key={c}
                        className="px-2 py-1 text-right tabular-nums"
                        title={
                          raw
                            ? Object.entries(r!.raw)
                                .map(([k, v]) => `${k} ${v}`)
                                .join(', ')
                            : undefined
                        }
                      >
                        {r ? (
                          <Link href={`/detections?camera=${c}&label=${l}&since=1h`} className="hover:underline">
                            {r.n}
                          </Link>
                        ) : (
                          <span className="text-dim">·</span>
                        )}
                        {r && (
                          <span className="text-dim">
                            {' '}
                            {r.conf}
                            {raw ? ' ◦' : ''}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Section>
  );
}
