export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getHome } from '@/bff/home';
import { json, errorResponse } from '@/bff/daemon';
export async function GET() { try { return json(await getHome()); } catch (e) { return errorResponse(e); } }
