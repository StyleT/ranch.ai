export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { proxyClip } from '@/bff/clips';
import { errorResponse } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return await proxyClip(id, req.headers.get('range'), req.signal);
  } catch (e) {
    return errorResponse(e);
  }
}
