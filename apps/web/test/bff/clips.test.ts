import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { server } from './setup-server';
import { invalidate } from '@/bff/daemon';
import { GET as clipGET } from '@/app/api/ui/clip/[id]/route';
import { getDetections } from '@/bff/detections';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => invalidate());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('/api/ui/clip/[id]', () => {
  const call = (id: string, range?: string) =>
    clipGET(new Request(`http://x/api/ui/clip/${id}`, { headers: range ? { range } : {} }), {
      params: Promise.resolve({ id }),
    });
  it('serves the whole mp4 with accept-ranges when no Range is asked', async () => {
    const r = await call('31');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('cache-control')).toBe('max-age=3600');
    expect(Number(r.headers.get('content-length'))).toBe((await r.arrayBuffer()).byteLength);
  });
  it('passes a byte range through and returns the daemon 206 with content-range', async () => {
    const r = await call('31', 'bytes=0-99');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect(r.headers.get('content-length')).toBe('100');
    expect((await r.arrayBuffer()).byteLength).toBe(100);
  });
  it('404s an unknown clip and a non-numeric id', async () => {
    expect((await call('32')).status).toBe(404);
    expect((await call('../etc')).status).toBe(404);
  });
});

describe('the clip ref on frame cards', () => {
  it('a frame head sampled from a clip carries the clip ref; others carry null', async () => {
    const page = await getDetections({ since: '24h', limit: 60 });
    expect(page.items[0]!.clip).toEqual({
      id: 31,
      duration_s: 18,
      stopped: 'quiet',
      labels: ['equine', 'person'],
      video: '/api/ui/clip/31',
    });
    expect(page.items[1]!.clip).toBeNull();
    const only = await getDetections({ since: '24h', limit: 60, clip: '1' });
    expect(only.items.map((f) => f.clip?.id)).toEqual([31]);
  });
});
