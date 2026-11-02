'use client';
import Link from 'next/link';
import { Card, Section } from '@/components/ui';
import { localTime } from '@/lib/format';
import { tid } from '@/lib/testids';
import { useActivity } from '@/features/live/LiveProvider';
import { useTz } from '@/lib/tz';
import type { HomeData } from '@/lib/types';

export function ActivityFeed({ initial }: { initial: HomeData['activity'] }) {
  const tz = useTz();
  const live = useActivity();
  const liveItems = live.tracks.flatMap((e) =>
    e.tracks.map((t) => ({
      t: new Date(e.at).toISOString(),
      camera: e.camera,
      label: t.label,
      moving: t.moving,
      members: e.frames,
      seen: t.seen,
      conf: t.confidence,
      frame_id: e.burst_id,
      img: `/api/ui/frame/${e.burst_id}`,
    })),
  );
  const seen = new Set<string>();
  const items = [...liveItems, ...initial]
    .filter((i) => {
      const k = `${i.frame_id}|${i.label}`;
      if (seen.has(k)) {
        return false;
      }
      seen.add(k);
      return true;
    })
    .slice(0, 30);
  return (
    <Section title="Activity" action={<span className="text-dim text-xs">last hour</span>}>
      <Card className="max-h-[480px] overflow-auto p-0" data-testid={tid.activityFeed}>
        {items.length === 0 && <p className="text-dim p-3 text-sm">nothing tracked in the last hour</p>}
        <ul className="divide-line divide-y">
          {items.map((i) => (
            <li key={`${i.frame_id}-${i.label}`}>
              <Link
                href={`/detections?camera=${i.camera}&frame=${i.frame_id}&since=24h`}
                className="min-h-touch hover:bg-surface-2 flex items-center gap-2 px-3 py-1.5 text-sm"
              >
                <img
                  src={`${i.img}?w=320`}
                  alt=""
                  loading="lazy"
                  className="h-9 w-16 rounded-sm bg-black object-cover"
                />
                <span className="min-w-0 flex-1 truncate">
                  <time dateTime={i.t} className="text-dim">
                    {localTime(i.t, tz)}
                  </time>{' '}
                  <b>{i.camera.replace('_cam', '')}</b> {i.label}
                  {i.seen > 1 ? ` ×${i.seen}` : ''}
                  {i.moving ? ' · moving' : ''}
                  {i.members > 1 ? ` · burst ×${i.members}` : ''}
                </span>
                ›
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}
