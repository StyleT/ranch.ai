'use client';
import { Suspense } from 'react';
import { useHome } from '@/features/home/useHome';
import { DetectionsBrowser } from './DetectionsBrowser';
export function DetectionsView() {
  const home = useHome();
  const cameras = home.data?.cameras.map((c) => c.name) ?? []; const labels = home.data?.label_order ?? [];
  return <Suspense><h1 className="mb-3 text-lg font-semibold">Detections</h1><DetectionsBrowser cameras={cameras} labels={labels} /></Suspense>;
}
