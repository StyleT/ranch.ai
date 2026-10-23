import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { server } from './setup-server';
import { invalidate } from '@/bff/daemon';
import { GET as hlsGET } from '@/app/api/ui/hls/[camera]/[file]/route';
import { parseLeaderboard, parseDatasets } from '@/bff/evals';
import { translate } from '@/bff/live';
import { gapFill } from '@/bff/camera';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => invalidate());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('/api/ui/hls/[camera]/[file]', () => {
  const call = (camera: string, file: string, q = '') => hlsGET(new Request(`http://x/api/ui/hls/${camera}/${file}${q}`), { params: Promise.resolve({ camera, file }) });
  it('proxies the playlist with its MIME type, no-store and the recorder age header', async () => {
    const r = await call('donkey_cam', 'index.m3u8'); expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/vnd.apple.mpegurl'); expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.get('x-live-age-s')).toBe('1');
    expect(await r.text()).toContain('#EXT-X-MAP:URI="init.mp4"');
  });
  it('proxies init and segments as video/mp4 with their cache policy', async () => {
    const i = await call('donkey_cam', 'init.mp4'); expect(i.status).toBe(200); expect(i.headers.get('content-type')).toBe('video/mp4'); expect(i.headers.get('cache-control')).toBe('no-store');
    const s = await call('donkey_cam', 'seg000007.m4s'); expect(s.status).toBe(200); expect(s.headers.get('cache-control')).toBe('max-age=60'); expect((await s.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });
  it('refuses anything but the three file shapes and 404s a camera without HLS', async () => {
    expect((await call('donkey_cam', 'evil.txt')).status).toBe(404);
    expect((await call('donkey_cam', 'seg1.m4s')).status).toBe(404);
    expect((await call('donkey_cam', 'seg1761240000-000007.m4s')).status).toBe(404);   // valid per-run shape, not served by the mock daemon
    expect((await call('donkey_cam', 'init-1761240000.mp4')).status).toBe(404);
    expect((await call('Donkey', 'index.m3u8')).status).toBe(404);
    expect((await call('mops_cam', 'index.m3u8')).status).toBe(404);
  });
});

describe('evals parsers', () => {
  const repo = join(process.cwd(), '..', '..');
  it('parses the real leaderboard and datasets files', () => {
    const lb = parseLeaderboard(readFileSync(join(repo, 'evals', 'LEADERBOARD.md'), 'utf8'));
    expect(lb.rows.length).toBeGreaterThan(5); expect(lb.rows.filter((r) => r.prod).length).toBe(1);
    expect(lb.rows[0]!.result).toMatch(/\.json/);
    const ds = parseDatasets(readFileSync(join(repo, 'evals', 'DATASETS.md'), 'utf8'));
    expect(ds.some((d) => d.id === 'frames-ranch-v1')).toBe(true);
  });
});

describe('live translate and gapFill', () => {
  it('translates mqtt topics into named events', () => {
    expect(translate('ranch/frames/donkey_cam', { id: 1, ts: 't', reason: 'change' })).toEqual({ event: 'frame', data: { camera: 'donkey_cam', frame_id: 1, ts: 't', reason: 'change', burst_id: null, seq: null } });
    expect(translate('ranch/status/ingest', { bursts: 1 })?.event).toBe('daemon');
    expect(translate('ranch/other', {})).toBeNull();
  });
  it('fills gaps with nulls on bucket boundaries', () => {
    const since = Date.parse('2026-10-22T10:00:00Z'), until = Date.parse('2026-10-22T10:30:00Z');
    const s = gapFill([{ ts: '2026-10-22T10:05:00Z', value: 2 }, { ts: '2026-10-22T10:20:00Z', value: 1 }], since, until, 300);
    expect(s.length).toBe(6); expect(s.map((p) => p.value)).toEqual([null, 2, null, null, 1, null]);
    expect(gapFill([], Date.parse('2026-10-22T10:02:00Z'), Date.parse('2026-10-22T16:02:00Z'), 300).length).toBe(72);
  });
});
