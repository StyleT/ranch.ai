// The one typed client for the status daemon (docs/WEB-DASHBOARD.md §3): fetch with a timeout, validate against
// @ranch/contracts at the boundary, map failures to HTTP errors, and share in-flight results through a short TTL cache.
import { z } from 'zod';
import { parseContract } from '@ranch/contracts';
import { env } from './env.ts';

export class UpstreamError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly body?: unknown) { super(message); }
}

const DEFAULT_TIMEOUT = 4000;

/** GET a daemon path and validate the JSON. */
export async function daemonJson<T extends z.ZodType>(schema: T, path: string, opts: { timeoutMs?: number } = {}): Promise<z.infer<T>> {
  const res = await daemonFetch(path, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT) });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new UpstreamError(res.status, 'upstream', `daemon ${path} -> ${res.status}`, body);
  try { return parseContract(schema, body, path); } catch (e) { throw new UpstreamError(502, 'daemon_contract', (e as Error).message); }
}

/** POST JSON to the daemon; forwards an optional write token header; returns status + parsed body without validation. */
export async function daemonPost(path: string, body: unknown, opts: { token?: string | null; timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['x-ranch-token'] = opts.token;
  const res = await daemonFetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT) });
  return { status: res.status, body: await res.json().catch(() => ({ error: 'invalid json from daemon' })) };
}

/** Raw fetch to the daemon with connection errors mapped to 503. */
export async function daemonFetch(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(env.daemonUrl + path, { cache: 'no-store', ...init });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UpstreamError(503, 'daemon_unreachable', `daemon unreachable: ${msg}`);
  }
}

// ---- TTL cache sharing in-flight promises (the daemon's own pattern) -------------------------------------------
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 100) for (const [k, v] of cache) if (Date.now() - v.at > 60_000) cache.delete(k);
  return value;
}
export function invalidate(prefix = ''): void { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); }

// ---- response helpers -----------------------------------------------------------------------------------------------
export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(init.headers ?? {}) } });

export function errorResponse(e: unknown): Response {
  if (e instanceof UpstreamError) {
    const body = e.code === 'upstream' && e.body && typeof e.body === 'object' ? e.body : { error: e.code, detail: e.message };
    return json(body, { status: e.status });
  }
  if (e instanceof z.ZodError) return json({ error: 'bad_request', issues: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 400 });
  console.error(JSON.stringify({ ts: new Date().toISOString(), svc: 'web', msg: 'request failed', error: e instanceof Error ? e.message : String(e) }));
  return json({ error: 'internal', detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
export const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), svc: 'web', msg, ...extra }) + '\n');
