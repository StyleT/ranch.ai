export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { proxyStream } from '@/bff/streams';
import { errorResponse } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ camera: string }> }) {
  try { const { camera } = await ctx.params; const u = new URL(req.url); return await proxyStream(camera, u.searchParams.get('fmt'), u.searchParams.get('w'), req.signal); } catch (e) { return errorResponse(e); }
}
