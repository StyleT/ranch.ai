export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { getClips, ClipsQuery } from '@/bff/clips';
import { json, errorResponse } from '@/bff/daemon';
export async function GET(req: Request) {
  try {
    const q = ClipsQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return json(await getClips(q));
  } catch (e) {
    return errorResponse(e);
  }
}
