import { Suspense } from 'react';
import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query/client';
import { keys } from '@/lib/query/keys';
import { getHome } from '@/bff/home';
import { DetectionsView } from '@/features/detections/DetectionsView';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Detections' };
export default async function DetectionsPage() {
  const qc = getQueryClient();
  await qc.prefetchQuery({ queryKey: keys.home(), queryFn: getHome }).catch(() => undefined);
  return <HydrationBoundary state={dehydrate(qc)}><Suspense fallback={null}><DetectionsView /></Suspense></HydrationBoundary>;
}
