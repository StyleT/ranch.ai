export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { taxonomyAction, isAction } from '@/bff/taxonomy';
import { json, errorResponse } from '@/bff/daemon';
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  try { const { action } = await ctx.params; if (!isAction(action)) return json({ error: 'unknown action' }, { status: 404 });
    const body = await req.json().catch(() => ({})); return await taxonomyAction(action, body, req.headers.get('x-ranch-token')); } catch (e) { return errorResponse(e); }
}
