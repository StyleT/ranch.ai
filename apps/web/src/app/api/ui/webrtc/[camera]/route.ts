export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { proxyWebrtcOffer } from '@/bff/webrtc';
import { errorResponse } from '@/bff/daemon';
export async function POST(req: Request, ctx: { params: Promise<{ camera: string }> }) {
  try { const { camera } = await ctx.params; const sdp = await req.text(); return await proxyWebrtcOffer(camera, sdp, req.signal); } catch (e) { return errorResponse(e); }
}
