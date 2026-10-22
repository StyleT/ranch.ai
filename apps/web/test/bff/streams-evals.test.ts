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
  it('404s unknown cameras and serves mjpeg for excluded ones', async () => {
    expect((await call('nope').res).status).toBe(404);
    const { res, ac } = call('mops_cam', '?fmt=mp4'); const r = await res; expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('multipart'); ac.abort();
  });
  it('caps concurrent streams at the configured maximum', async () => {
    const a = call('donkey_cam', '?fmt=mp4'); const b = call('wash_stall', '?fmt=mp4'); const c = call('tractor_cam', '?fmt=mp4');
    expect((await a.res).status).toBe(200); expect((await b.res).status).toBe(200); expect((await c.res).status).toBe(429);
    a.ac.abort(); b.ac.abort(); await new Promise((r) => setTimeout(r, 20));
    const d = call('tractor_cam', '?fmt=jpeg'); expect((await d.res).status).toBe(200);
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
