import { describe, it, expect } from 'vitest';
import type { Status } from '@ranch/contracts';
import type { DaemonView } from '@/lib/types';
import { deriveAlerts } from './derive';

const status = { taxonomy_matches_repo: true, disk_free_gb: 100, daemons: [], cameras: [] } as unknown as Status;
const daemon = (name: string, o: Partial<DaemonView>): DaemonView => ({
  name,
  label: `com.ranch.${name}`,
  up: true,
  pid: 100,
  last_exit: 0,
  rss_mb: null,
  log: '',
  status: null,
  ...o,
});

describe('deriveAlerts daemons', () => {
  it('alerts on a down daemon and on an abnormal last exit, not on a provision restart', () => {
    const alerts = deriveAlerts({
      status,
      cameras: [],
      now: new Date(),
      daemons: [
        daemon('status', { last_exit: -15 }), // kickstarted by provision, up again: not an incident
        daemon('detector', { last_exit: 1 }),
        daemon('ingest', { up: false, pid: null, last_exit: 0 }),
        daemon('pf', { pid: null, up: true }), // boot one-shot, measured up by pfctl
      ],
    }).filter((a) => a.kind === 'daemon_down');
    expect(alerts.map((a) => [a.text, a.severity])).toEqual([
      ['detector exited 1 last time', 'warn'],
      ['ingest down', 'bad'],
    ]);
  });
});
