import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query/client';
import { keys } from '@/lib/query/keys';
import { getHome } from '@/bff/home';
import { getCamera } from '@/bff/camera';
import { CameraView } from '@/features/camera/CameraView';
export const dynamic = 'force-dynamic';
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) { const { name } = await params; return { title: name }; }
export default async function CameraPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z0-9_]+$/.test(name)) notFound();
  const qc = getQueryClient();
  // prefetchQuery swallows errors, so fetch directly: an unknown camera is a 404 page, a daemon outage renders the client error state
  try { qc.setQueryData(keys.camera(name, '24h'), await getCamera(name, '24h')); } catch (e) { if ((e as { status?: number } | null)?.status === 404) notFound(); } // duck-typed: the class identity is not stable across bundles
  await qc.prefetchQuery({ queryKey: keys.home(), queryFn: getHome }).catch(() => undefined);
  return <HydrationBoundary state={dehydrate(qc)}><Suspense fallback={null}><CameraView name={name} /></Suspense></HydrationBoundary>;
}
