import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { server } from './setup-server';
import { invalidate } from '@/bff/daemon';
import { GET as streamGET } from '@/app/api/ui/stream/[camera]/route';
import { parseLeaderboard, parseDatasets } from '@/bff/evals';
import { translate } from '@/bff/live';
import { gapFill } from '@/bff/camera';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => invalidate());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('/api/ui/stream/[camera]', () => {
  const call = (camera: string, q = '') => { const ac = new AbortController(); return { res: streamGET(new Request(`http://x/api/ui/stream/${camera}${q}`, { signal: ac.signal }), { params: Promise.resolve({ camera }) }), ac }; };
  it('404s unknown cameras and streams the daemon buffer mjpeg for known ones', async () => {
    expect((await call('nope').res).status).toBe(404);
    const { res, ac } = call('donkey_cam'); const r = await res; expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('multipart'); ac.abort();
  });
  it('serves one jpeg with fmt=jpeg, falling back to the kept frame when the buffer is empty', async () => {
    const a = await call('donkey_cam', '?fmt=jpeg').res; expect(a.status).toBe(200); expect(a.headers.get('content-type')).toBe('image/jpeg');
    const b = await call('mops_cam', '?fmt=jpeg').res; expect(b.status).toBe(200);
  });
  it('caps concurrent streams at the configured maximum', async () => {
    const opened = ['donkey_cam', 'wash_stall', 'tractor_cam', 'back_yard_cam'].map((c) => call(c));
    for (const o of opened) expect((await o.res).status).toBe(200);
    expect((await call('front_porch_cam').res).status).toBe(429);
    for (const o of opened) o.ac.abort(); await new Promise((r) => setTimeout(r, 20));
    expect((await call('front_porch_cam', '?fmt=jpeg').res).status).toBe(200);
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
