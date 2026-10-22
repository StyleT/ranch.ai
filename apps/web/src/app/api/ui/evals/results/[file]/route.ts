export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getResultFile } from '@/bff/evals';
import { json, errorResponse } from '@/bff/daemon';
export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) { try { const { file } = await ctx.params; return json(getResultFile(file)); } catch (e) { return errorResponse(e); } }
