export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getEvals } from '@/bff/evals';
import { json, errorResponse } from '@/bff/daemon';
export async function GET() { try { return json(getEvals()); } catch (e) { return errorResponse(e); } }
