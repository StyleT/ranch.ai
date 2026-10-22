import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query/client';
import { keys } from '@/lib/query/keys';
import { getEvals } from '@/bff/evals';
import { EvalsView } from '@/features/evals/EvalsView';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Evals' };
export default async function EvalsPage() {
  const qc = getQueryClient();
  await qc.prefetchQuery({ queryKey: keys.evals(), queryFn: async () => getEvals() }).catch(() => undefined);
  return <HydrationBoundary state={dehydrate(qc)}><EvalsView /></HydrationBoundary>;
}
