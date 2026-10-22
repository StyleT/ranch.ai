export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getHealth } from '@/bff/system';
import { json, errorResponse } from '@/bff/daemon';
export async function GET() { try { return json(await getHealth()); } catch (e) { return errorResponse(e); } }
