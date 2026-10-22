import { Ping } from '@ranch/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemData, HealthData } from '@/lib/types';
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
  const netprobe = status.cameras.map((c) => { const p = probe[c.name] as Record<string, unknown> | undefined; return { camera: c.name, ip: (p?.ip as string | undefined) ?? c.ip ?? null, producer: (p?.producer as boolean | undefined) ?? null, consumers: (p?.consumers as number | undefined) ?? null, rx_bytes_delta: (p?.rx_bytes_delta as number | undefined) ?? null, ping_ms: (p?.ping_ms as number | null | undefined) ?? null }; });
  const ping = await cached('ping', 5000, () => daemonJson(Ping, '/api/ping', { timeoutMs: 1500 })).catch(() => null);
  const w = webStats();
  return { ts: status.ts, host: status.host, uptime_s: status.uptime_s, load: status.load, disk: { free_gb: status.disk_free_gb, total_gb: status.disk_total_gb }, totals: status.totals, seed: status.seed, daemons, netprobe,
    wifi: (probe.wifi as Record<string, unknown> | undefined) ?? null, web: { rss_mb: w.rss_mb, heap_mb: w.heap_mb, uptime_s: w.uptime_s, build: w.build }, daemon_ping: ping };
}
