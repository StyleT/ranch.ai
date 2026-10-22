export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getTaxonomy } from '@/bff/taxonomy';
import { json, errorResponse } from '@/bff/daemon';
export async function GET() { try { return json(await getTaxonomy()); } catch (e) { return errorResponse(e); } }
