import { Ping, BridgeMetrics, AvailabilityResponse, RemediationResponse } from '@ranch/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemData, HealthData, BridgeData } from '@/lib/types';
import { daemonJson, cached } from './daemon.ts';
import { getStatus, daemonViews } from './home.ts';

const started = Date.now();
export function buildInfo(): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(join(process.cwd(), 'BUILD_INFO.json'), 'utf8')) as Record<string, unknown>; } catch { return null; }
}
export function webStats() { const m = process.memoryUsage(); return { rss_mb: Math.round(m.rss / 1048576), heap_mb: Math.round(m.heapUsed / 1048576), uptime_s: Math.round((Date.now() - started) / 1000), pid: process.pid, build: buildInfo() }; }

export async function getHealth(): Promise<HealthData> {
  const daemon = await daemonJson(Ping, '/api/ping', { timeoutMs: 1500 }).catch((e: Error) => ({ error: e.message }));
  return { ok: !('error' in daemon), web: webStats(), daemon };
}

export async function getSystem(): Promise<SystemData> {
  const status = await getStatus();
  const daemons = daemonViews(status);
  const probe = (status.daemons.find((d) => d.label === 'com.ranch.netprobe')?.status ?? {}) as Record<string, unknown>;
  const netprobe = status.cameras.map((c) => { const p = probe[c.name] as Record<string, unknown> | undefined; return { camera: c.name, ip: (p?.ip as string | undefined) ?? c.ip ?? null, producer: (p?.producer as boolean | undefined) ?? null, connected: (p?.connected as boolean | undefined) ?? null, consumers: (p?.consumers as number | undefined) ?? null, rx_bytes_delta: (p?.rx_bytes_delta as number | undefined) ?? null, ping_ms: (p?.ping_ms as number | null | undefined) ?? null }; });
  const [ping, bridge, avail, rem] = await Promise.all([
    cached('ping', 5000, () => daemonJson(Ping, '/api/ping', { timeoutMs: 1500 })).catch(() => null),
    // the bridge's own metrics via the daemon (5080 is loopback-only); the page renders without them when the bridge is down
    cached('bridge', 10_000, () => daemonJson(BridgeMetrics, '/api/bridge', { timeoutMs: 4000 })).then((b): BridgeData => ({ bridge: b.bridge, cameras: b.cameras, wyzeapi: b.wyzeapi ?? [] })).catch(() => null),
    cached('availability:fleet', 60_000, () => daemonJson(AvailabilityResponse, '/api/availability?since=24h&bucket=1h')).catch(() => []),
    cached('remediation:fleet', 10_000, () => daemonJson(RemediationResponse, '/api/remediation?since=24h&limit=50')).catch(() => []),
  ]);
  const remediation = rem.map((r) => ({ id: r.id, ts: r.ts, camera: r.camera, rung: r.rung, action: r.action, reason: r.reason, dry_run: r.dry_run, outcome: r.outcome, outcome_ts: r.outcome_ts, recovered_after_s: r.recovered_after_s }));
  const availability = avail.map((a) => ({ camera: a.camera, availability: a.availability, outages: a.outages, outage_p50_s: a.outage_p50_s, outage_max_s: a.outage_max_s, down_since: a.down_since }));
  const w = webStats();
  return { ts: status.ts, host: status.host, uptime_s: status.uptime_s, load: status.load, disk: { free_gb: status.disk_free_gb, total_gb: status.disk_total_gb }, totals: status.totals, buffer: { total: status.buffer.total, stale_s: status.buffer.stale_s ?? null }, daemons, netprobe,
    wifi: (probe.wifi as Record<string, unknown> | undefined) ?? null, web: { rss_mb: w.rss_mb, heap_mb: w.heap_mb, uptime_s: w.uptime_s, build: w.build }, daemon_ping: ping, bridge, availability, remediation };
}
