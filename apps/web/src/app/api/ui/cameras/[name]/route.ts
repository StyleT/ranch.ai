export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getCamera, parseWindow } from '@/bff/camera';
import { json, errorResponse } from '@/bff/daemon';
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  try { const { name } = await ctx.params; const w = parseWindow(new URL(req.url).searchParams.get('window')); return json(await getCamera(name, w)); } catch (e) { return errorResponse(e); }
}
