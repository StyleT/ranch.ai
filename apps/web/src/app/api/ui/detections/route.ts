export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getDetections, DetectionsQuery } from '@/bff/detections';
import { json, errorResponse } from '@/bff/daemon';
export async function GET(req: Request) {
  try { const q = DetectionsQuery.parse(Object.fromEntries(new URL(req.url).searchParams)); return json(await getDetections(q)); } catch (e) { return errorResponse(e); }
}
