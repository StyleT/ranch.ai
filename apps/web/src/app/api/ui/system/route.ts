export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getSystem } from '@/bff/system';
import { json, errorResponse } from '@/bff/daemon';
export async function GET() { try { return json(await getSystem()); } catch (e) { return errorResponse(e); } }
