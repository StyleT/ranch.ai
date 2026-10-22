import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query/client';
import { keys } from '@/lib/query/keys';
import { getTaxonomy } from '@/bff/taxonomy';
import { TaxonomyEditor } from '@/features/taxonomy/TaxonomyEditor';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Taxonomy' };
export default async function TaxonomyPage() {
  const qc = getQueryClient();
  await qc.prefetchQuery({ queryKey: keys.taxonomy(), queryFn: getTaxonomy }).catch(() => undefined);
  return <HydrationBoundary state={dehydrate(qc)}><TaxonomyEditor /></HydrationBoundary>;
}
