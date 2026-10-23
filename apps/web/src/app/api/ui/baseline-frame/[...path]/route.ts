export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { proxyFrame } from '@/bff/frames';
import { errorResponse, json } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  try { const { path } = await ctx.params; if (path.some((p) => p.includes('..') || !/^[\w.-]+$/.test(p))) return json({ error: 'bad_request' }, { status: 400 });
    return await proxyFrame(`/api/baseline-frame/${path.map(encodeURIComponent).join('/')}`, new URL(req.url).searchParams.get('w'), 'private, max-age=3600'); } catch (e) { return errorResponse(e); }
}
