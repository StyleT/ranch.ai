import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './setup-server';
import { DAEMON } from '../msw/handlers';
import { invalidate } from '@/bff/daemon';
import { GET as systemGET } from '@/app/api/ui/system/route';
import { GET as cameraGET } from '@/app/api/ui/cameras/[name]/route';
import type { SystemData, CameraDetail } from '@/lib/types';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => invalidate());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('/api/ui/system', () => {
  it('carries the bridge metrics (summary, per-camera state, Wyze API calls) and the probe connected flag', async () => {
    const res = await systemGET(); expect(res.status).toBe(200);
    const d = (await res.json()) as SystemData;
    expect(d.bridge?.bridge.camera_count).toBe(8);
    expect(d.bridge?.cameras.find((c) => c.name === 'mops_cam')?.state).toBe('error');
    expect(d.bridge?.wyzeapi.map((r) => r.Path)).toContain('/app/user/refresh_token');
    for (const row of d.netprobe) expect(row).toHaveProperty('connected');
    expect(d.availability.length).toBe(7);
    expect(d.availability.find((a) => a.camera === 'mops_cam')?.down_since).not.toBeNull();
    expect(d.availability.find((a) => a.camera === 'wash_stall')?.availability).toBe(1);
    expect(d.remediation.length).toBe(4);
    expect(d.remediation[0]!.action).toBe('alert');
    expect(d.remediation.find((r) => r.action === 'camera_reboot')?.dry_run).toBe(true);
  });
  it('the camera detail carries 24 h availability with 15-min buckets and the probe-derived state', async () => {
    const res = await cameraGET(new Request('http://x/api/ui/cameras/donkey_cam'), { params: Promise.resolve({ name: 'donkey_cam' }) }); expect(res.status).toBe(200);
    const d = (await res.json()) as CameraDetail;
    expect(d.availability?.series.length).toBeGreaterThan(90);
    expect(d.availability?.outages).toBeGreaterThan(0);
    expect(['connected', 'degraded', 'down', 'unknown']).toContain(d.camera.state);
    const t = await cameraGET(new Request('http://x/api/ui/cameras/tractor_cam'), { params: Promise.resolve({ name: 'tractor_cam' }) });
    const td = (await t.json()) as CameraDetail;
    expect(td.remediation.map((r) => r.action)).toEqual(['camera_reboot', 'down']);
    expect(td.remediation[0]!.recovered_after_s).toBe(180);
  });
  it('still renders when the bridge is unreachable', async () => {
    server.use(http.get(`${DAEMON}/api/bridge`, () => HttpResponse.json({ error: 'bridge_unreachable' }, { status: 503 })));
    const res = await systemGET(); expect(res.status).toBe(200);
    expect(((await res.json()) as SystemData).bridge).toBeNull();
  });
});
