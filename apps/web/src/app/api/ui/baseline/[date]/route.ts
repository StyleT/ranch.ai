export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getDetections, DetectionsQuery } from '@/bff/detections';
import { json, errorResponse } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ date: string }> }) {
  try { const { date } = await ctx.params; const q = DetectionsQuery.parse({ ...Object.fromEntries(new URL(req.url).searchParams), set: date }); return json(await getDetections(q)); } catch (e) { return errorResponse(e); }
}
