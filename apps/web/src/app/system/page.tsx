import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query/client';
import { keys } from '@/lib/query/keys';
import { getSystem } from '@/bff/system';
import { SystemView } from '@/features/system/SystemView';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'System' };
export default async function SystemPage() {
  const qc = getQueryClient();
  await qc.prefetchQuery({ queryKey: keys.system(), queryFn: getSystem }).catch(() => undefined);
  return <HydrationBoundary state={dehydrate(qc)}><SystemView /></HydrationBoundary>;
}
