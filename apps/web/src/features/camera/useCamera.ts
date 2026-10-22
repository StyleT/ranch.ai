'use client';
import { useQuery } from '@tanstack/react-query';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import type { CameraDetail } from '@/lib/types';
export const useCamera = (name: string, window: string) => useQuery({ queryKey: keys.camera(name, window), queryFn: () => apiGet<CameraDetail>(`/api/ui/cameras/${encodeURIComponent(name)}?window=${window}`), refetchInterval: 30_000 });
