import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { server } from './setup-server';
import { invalidate } from '@/bff/daemon';
import { GET as listGET } from '@/app/api/ui/detections/route';
import { GET as oneGET } from '@/app/api/ui/detections/[id]/route';
import { GET as frameGET } from '@/app/api/ui/frame/[key]/route';
import { GET as bframeGET } from '@/app/api/ui/baseline-frame/[...path]/route';
import type { DetectionsPage, FrameCard } from '@/lib/types';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => invalidate());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('/api/ui/detections', () => {
  it('normalizes live frames into cards with bursts and rewritten image urls', async () => {
    const d = (await (await listGET(new Request('http://x/api/ui/detections?since=24h&limit=20'))).json()) as DetectionsPage;
    expect(d.source).toBe('live'); expect(d.items.length).toBeGreaterThan(0);
    for (const f of d.items) { expect(f.img).toBe(`/api/ui/frame/${f.id}`); for (const b of f.burst) expect(b.img).toBe(`/api/ui/frame/${b.id}`); }
    expect(d.next_before).toBe(d.items[d.items.length - 1]!.id);
  });
  it('rejects bad params with 400', async () => {
    expect((await listGET(new Request('http://x/api/ui/detections?since=yesterday'))).status).toBe(400);
    expect((await listGET(new Request('http://x/api/ui/detections?min_conf=7'))).status).toBe(400);
  });
  it('serves baseline sets with gold boxes and client-side label filtering', async () => {
    const d = (await (await listGET(new Request('http://x/api/ui/detections?set=2026-10-20&model=yolo26s&label=horse'))).json()) as DetectionsPage;
    expect(d.source).toBe('baseline'); expect(d.next_before).toBeNull();
    for (const f of d.items) { expect(f.img).toMatch(/^\/api\/ui\/baseline-frame\//); expect(f.detections.some((b) => b.label.startsWith('horse'))).toBe(true); }
  });
  it('returns one head with members, 404 when missing', async () => {
    const f = (await (await oneGET(new Request('http://x'), { params: Promise.resolve({ id: '1' }) })).json()) as FrameCard;
    expect(f.id).toBeGreaterThan(0); expect(Array.isArray(f.burst)).toBe(true);
    expect((await oneGET(new Request('http://x'), { params: Promise.resolve({ id: '999999' }) })).status).toBe(404);
    expect((await oneGET(new Request('http://x'), { params: Promise.resolve({ id: 'abc' }) })).status).toBe(400);
  });
  it('proxies frames with the daemon headers and the right cache policy', async () => {
    const byId = await frameGET(new Request('http://x/api/ui/frame/42?w=320'), { params: Promise.resolve({ key: '42' }) });
    expect(byId.status).toBe(200); expect(byId.headers.get('content-type')).toBe('image/jpeg'); expect(byId.headers.get('cache-control')).toContain('max-age'); expect(byId.headers.get('x-frame-id')).toBe('1');
    const latest = await frameGET(new Request('http://x/api/ui/frame/donkey_cam'), { params: Promise.resolve({ key: 'donkey_cam' }) });
    expect(latest.headers.get('cache-control')).toBe('no-store');
    expect((await bframeGET(new Request('http://x'), { params: Promise.resolve({ path: ['..', 'etc'] }) })).status).toBe(400);
  });
});
