import { QueryClient } from '@tanstack/react-query';
import { cache } from 'react';

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, gcTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: true, refetchOnReconnect: true } } });
}
/** One QueryClient per server request (React cache) for prefetch + dehydrate in server components. */
export const getQueryClient = cache(makeQueryClient);
