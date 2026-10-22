import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { server } from './setup-server';
import { invalidate } from '@/bff/daemon';
import { fixture } from '../msw/handlers';
import { GET as taxGET } from '@/app/api/ui/taxonomy/route';
import { POST as actionPOST } from '@/app/api/ui/taxonomy/[action]/route';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => invalidate());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const post = (action: string, body: unknown, token?: string) => actionPOST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-ranch-token': token } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ action }) });

describe('/api/ui/taxonomy', () => {
  it('returns the meta document', async () => {
    const d = (await (await taxGET()).json()) as { active: { id: number }; versions: unknown[] };
    expect(d.active.id).toBeGreaterThan(0); expect(d.versions.length).toBeGreaterThan(0);
  });
  it('validates locally and scores through the daemon', async () => {
    const tax = fixture<{ taxonomy: unknown }>('taxonomy').taxonomy;
    expect((await post('validate', { taxonomy: tax })).status).toBe(200);
    expect((await post('validate', { taxonomy: { version: 1 } })).status).toBe(400);
    const r = await post('score', { taxonomy: tax }); expect(r.status).toBe(200);
    expect(((await r.json()) as { gate: { pass: boolean } }).gate).toBeDefined();
  });
  it('forwards the token header on apply and never logs it; preserves 403', async () => {
    const tax = fixture<{ taxonomy: unknown }>('taxonomy').taxonomy;
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect((await post('apply', { taxonomy: tax, note: 'n' })).status).toBe(403);
    const ok = await post('apply', { taxonomy: tax, note: 'n' }, 'test-token'); expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: number }).id).toBe(99);
    expect((await post('revert', { id: 1, note: 'back' }, 'test-token')).status).toBe(200);
    for (const call of logSpy.mock.calls) expect(String(call[0])).not.toContain('test-token');
    logSpy.mockRestore();
    expect((await post('bogus', {})).status).toBe(404);
  });
});
