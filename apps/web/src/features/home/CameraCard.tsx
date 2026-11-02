'use client';
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { formatAge } from '@/lib/format';
import { tid } from '@/lib/testids';
import { useThumbVersion } from '@/features/live/LiveProvider';
import type { CameraCard as CameraCardT } from '@/lib/types';

export function CameraCard({ c, horseLabel }: { c: CameraCardT; horseLabel: string }) {
  const v = useThumbVersion(c.name);
  return (
    <Link
      href={`/cameras/${c.name}`}
      data-testid={tid.cameraCard(c.name)}
      data-state={c.online ? 'online' : 'offline'}
      id={`camera-${c.name}`}
      className="rounded-card border-line bg-surface hover:border-dim block overflow-hidden border"
    >
      <div className="relative aspect-video bg-black">
        <img
          src={`${c.thumb}?w=640&v=${v || encodeURIComponent(c.thumb_version)}`}
          alt={`${c.name} latest frame`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        <span
          data-testid={tid.cameraCount(c.name)}
          className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white"
        >
          {horseLabel} <b>{c.equine_now ?? '–'}</b>
        </span>
        <Badge tone={c.online ? 'ok' : 'bad'} data-testid={tid.cameraOnline(c.name)}>
          <span className="absolute top-1.5 right-1.5">{c.online ? '● on' : '○ off'}</span>
        </Badge>
      </div>
      <div className="p-2 text-sm">
        <b>{c.name}</b>
        <div className="text-dim">
          {c.last_frame_age_s !== null ? `${formatAge(c.last_frame_age_s)} ago` : 'no frames'} · {c.frames_per_min}/min
        </div>
      </div>
    </Link>
  );
}
