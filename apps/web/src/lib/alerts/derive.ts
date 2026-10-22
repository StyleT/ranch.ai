// Pure: the alert list on the home page, derived from the status document (docs/WEB-DASHBOARD.md §4.1).
import type { Status } from '@ranch/contracts';
import type { Alert, CameraCard, DaemonView } from '@/lib/types';
import { formatAge } from '@/lib/format';

export function deriveAlerts(i: { status: Status; cameras: CameraCard[]; daemons: DaemonView[]; now: Date }): Alert[] {
  const out: Alert[] = [];
  for (const c of i.cameras) if (!c.online) out.push({ kind: 'camera_offline', text: `${c.name} offline${c.last_frame_age_s !== null ? ` · ${formatAge(c.last_frame_age_s)}` : ''}`, href: `/cameras/${c.name}`, severity: 'bad' });
  for (const d of i.daemons) if (!d.up || d.last_exit !== 0) out.push({ kind: 'daemon_down', text: `${d.name} ${d.up ? `exited ${d.last_exit} last time` : 'down'}`, href: '/system', severity: d.up ? 'warn' : 'bad' });
  const det = i.daemons.find((d) => d.name === 'detector')?.status as { ts?: string } | null | undefined;
  if (det?.ts && i.now.getTime() - Date.parse(det.ts) > 180e3) out.push({ kind: 'detector_stale', text: `detector status is ${formatAge((i.now.getTime() - Date.parse(det.ts)) / 1000)} old`, href: '/system', severity: 'warn' });
  if (!i.status.taxonomy_matches_repo) out.push({ kind: 'taxonomy_drift', text: `taxonomy v${i.status.taxonomy_version ?? '?'} is not in git`, href: '/taxonomy', severity: 'warn' });
  if (i.status.disk_free_gb !== null && i.status.disk_free_gb < 20) out.push({ kind: 'disk_low', text: `disk ${i.status.disk_free_gb} GB free`, href: '/system', severity: 'warn' });
  const ingest = i.daemons.find((d) => d.name === 'ingest')?.status as { burst_throttled?: number } | null | undefined;
  if (ingest?.burst_throttled) out.push({ kind: 'burst_throttled', text: `bursts throttled ${ingest.burst_throttled}× (budget)`, href: '/system', severity: 'warn' });
  if (i.cameras.length && i.cameras.every((c) => c.frames_per_min === 0)) out.push({ kind: 'no_frames', text: 'no frames from any camera in 10 min', href: '/system', severity: 'bad' });
  return out;
}
