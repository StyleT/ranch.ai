import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { server } from './setup-server';
import { DAEMON, fixture } from '../msw/handlers';
import { invalidate } from '@/bff/daemon';
import { GET as homeGET } from '@/app/api/ui/home/route';
import { GET as healthGET } from '@/app/api/ui/health/route';
import { GET as systemGET } from '@/app/api/ui/system/route';
import { GET as cameraGET } from '@/app/api/ui/cameras/[name]/route';
import type { HomeData, CameraDetail, SystemData } from '@/lib/types';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => invalidate());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('/api/ui/home', () => {
  it('composes health, cameras, alerts and activity from the daemon', async () => {
    const res = await homeGET(); expect(res.status).toBe(200);
    const d = (await res.json()) as HomeData;
    const status = fixture<{ cameras: { name: string }[]; daemons: unknown[] }>('status');
    expect(d.cameras.map((c) => c.name)).toEqual(status.cameras.map((c) => c.name));
    expect(d.health.daemons_total).toBe(status.daemons.length);
    expect(d.cameras[0]!.thumb).toMatch(/^\/api\/ui\/frame\//);
    expect(d.activity.length).toBeGreaterThan(0);
    expect(d.activity[0]!.img).toMatch(/^\/api\/ui\/frame\/\d+$/);
    expect(d.label_order).toContain('horse');
    for (const a of d.alerts) expect(a.href).toMatch(/^\//);
  });
  it('maps an unreachable daemon to 503', async () => {
    server.use(http.get(`${DAEMON}/api/status`, () => HttpResponse.error()));
    const res = await homeGET(); expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('daemon_unreachable');
  });
  it('maps a contract violation to 502', async () => {
    server.use(http.get(`${DAEMON}/api/status`, () => HttpResponse.json({ ts: 'x' })));
    const res = await homeGET(); expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('daemon_contract');
  });
  it('times out a slow daemon as 503', async () => {
    server.use(http.get(`${DAEMON}/api/status`, async () => { await delay(9000); return HttpResponse.json(fixture('status')); }));
    const res = await homeGET(); expect(res.status).toBe(503);
  }, 12_000);
});

describe('/api/ui/cameras/[name]', () => {
  it('returns a gap-filled series for a known camera and 404 for an unknown one', async () => {
    const name = fixture<{ cameras: { name: string }[] }>('status').cameras[0]!.name;
    const res = await cameraGET(new Request(`http://x/api/ui/cameras/${name}?window=6h`), { params: Promise.resolve({ name }) });
    expect(res.status).toBe(200);
    const d = (await res.json()) as CameraDetail;
    expect(d.window.label).toBe('6h'); expect(d.window.bucket_s).toBe(300);
    expect(d.equine_series.length).toBe(72); expect(d.online_series.length).toBe(72);
    expect(d.camera.name).toBe(name);
    const miss = await cameraGET(new Request('http://x/api/ui/cameras/nope'), { params: Promise.resolve({ name: 'nope' }) });
    expect(miss.status).toBe(404);
  });
});

describe('/api/ui/system and /api/ui/health', () => {
  it('system parses daemons, netprobe rows and web stats', async () => {
    const d = (await (await systemGET()).json()) as SystemData;
    expect(d.daemons.some((x) => x.name === 'detector')).toBe(true);
    expect(d.netprobe.length).toBe(fixture<{ cameras: unknown[] }>('status').cameras.length);
    expect(d.web.rss_mb).toBeGreaterThan(0);
  });
  it('health stays 200 when the daemon is down', async () => {
    server.use(http.get(`${DAEMON}/api/ping`, () => HttpResponse.error()));
    const res = await healthGET(); expect(res.status).toBe(200);
    const d = (await res.json()) as { ok: boolean }; expect(d.ok).toBe(false);
  });
});
