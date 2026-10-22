'use client';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import { apiQuery, type FilterState } from '@/lib/filters/urlState';
import type { DetectionsPage, FrameCard } from '@/lib/types';
import type { BaselineSet } from '@ranch/contracts';

export function useDetections(f: FilterState) {
  const q = apiQuery(f, { limit: '60' });
  return useInfiniteQuery({
    queryKey: keys.detections(q),
    queryFn: ({ pageParam }) => apiGet<DetectionsPage>(`/api/ui/detections?${q}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
    refetchInterval: f.set ? false : 60_000,
  });
}
export const useFrame = (id: number | null) => useQuery({ queryKey: keys.detection(id ?? 0), queryFn: () => apiGet<FrameCard>(`/api/ui/detections/${id}`), enabled: id !== null });
export const useBaselineSets = () => useQuery({ queryKey: keys.baselineSets(), queryFn: () => apiGet<BaselineSet[]>('/api/ui/baseline'), staleTime: 60_000 });
