'use client';
import { useHome } from './useHome';
import { Card, Section, Skeleton } from '@/components/ui';
import { HealthStrip } from './HealthStrip';
import { AlertList } from './AlertList';
import { CameraCard } from './CameraCard';
import { ActivityFeed } from './ActivityFeed';
import { DetectionsByCamera } from './DetectionsByCamera';

export function HomeView() {
  const { data, error, isPending } = useHome();
  if (isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <Card role="alert" className="text-bad">
        daemon unreachable
      </Card>
    );
  }
  return (
    <>
      <HealthStrip d={data} />
      <AlertList alerts={data.alerts} />
      <div className="md:grid md:grid-cols-[2fr_1fr] md:gap-4">
        <Section title="Cameras" id="cameras">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {data.cameras.map((c) => (
              <CameraCard key={c.name} c={c} horseLabel={data.horse_label} />
            ))}
          </div>
        </Section>
        <ActivityFeed initial={data.activity} />
      </div>
      <DetectionsByCamera d={data} />
      <Section title="Events">
        <Card className="text-dim text-sm">
          {data.events.length
            ? data.events.map((e) => (
                <div key={e.id}>
                  {e.ts.slice(11, 19)} {e.camera} {e.type} {e.confidence.toFixed(2)} tier {e.tier_decided}{' '}
                  {e.verdict ?? ''}
                </div>
              ))
            : 'none yet (Phase 2)'}
        </Card>
      </Section>
    </>
  );
}
