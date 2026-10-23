export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { proxyHls } from '@/bff/hls';
import { errorResponse } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ camera: string; file: string }> }) {
  try { const { camera, file } = await ctx.params; return await proxyHls(camera, file, req.signal, new URL(req.url).searchParams.get('scenario')); } catch (e) { return errorResponse(e); }
}
