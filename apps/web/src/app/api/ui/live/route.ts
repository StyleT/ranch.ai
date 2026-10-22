export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
import { liveResponse } from '@/bff/live';
export function GET(req: Request) { return liveResponse(req.signal, new URL(req.url).searchParams.get('scenario')); }
