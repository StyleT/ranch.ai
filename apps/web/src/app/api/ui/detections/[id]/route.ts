export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getDetection } from '@/bff/detections';
import { json, errorResponse } from '@/bff/daemon';
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { const { id } = await ctx.params; if (!/^\d+$/.test(id)) return json({ error: 'bad_request' }, { status: 400 }); return json(await getDetection(Number(id))); } catch (e) { return errorResponse(e); }
}
