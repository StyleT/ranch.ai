export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getBaselineSets } from '@/bff/detections';
import { json, errorResponse } from '@/bff/daemon';
export async function GET() { try { return json(await getBaselineSets()); } catch (e) { return errorResponse(e); } }
