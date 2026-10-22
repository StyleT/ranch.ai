export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { proxyFrame, proxyLatest } from '@/bff/streams';
import { errorResponse } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try { const { key } = await ctx.params; const w = new URL(req.url).searchParams.get('w'); const isId = /^\d+$/.test(key);
    return isId ? await proxyFrame(`/api/frame/${key}`, w, 'private, max-age=3600') : await proxyLatest(key, w); } catch (e) { return errorResponse(e); }
}
