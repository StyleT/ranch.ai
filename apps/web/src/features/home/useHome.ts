'use client';
import { useQuery } from '@tanstack/react-query';
import { keys } from '@/lib/query/keys';
import { apiGet } from '@/lib/query/fetch';
import type { HomeData } from '@/lib/types';
export const useHome = () => useQuery({ queryKey: keys.home(), queryFn: () => apiGet<HomeData>('/api/ui/home'), refetchInterval: 30_000 });
