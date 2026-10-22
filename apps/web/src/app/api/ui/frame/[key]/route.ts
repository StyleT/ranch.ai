export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { proxyFrame } from '@/bff/streams';
import { errorResponse } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try { const { key } = await ctx.params; const w = new URL(req.url).searchParams.get('w'); const isId = /^\d+$/.test(key);
    return await proxyFrame(`/api/frame/${encodeURIComponent(key)}`, w, isId ? 'private, max-age=3600' : 'no-store'); } catch (e) { return errorResponse(e); }
}
