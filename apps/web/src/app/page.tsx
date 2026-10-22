import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query/client';
import { keys } from '@/lib/query/keys';
import { getHome } from '@/bff/home';
import { HomeView } from '@/features/home/HomeView';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const qc = getQueryClient();
  await qc.prefetchQuery({ queryKey: keys.home(), queryFn: getHome }).catch(() => undefined);
  return <HydrationBoundary state={dehydrate(qc)}><HomeView /></HydrationBoundary>;
}
