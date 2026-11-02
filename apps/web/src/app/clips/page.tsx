import { Suspense } from 'react';
import { ClipsView } from '@/features/clips/ClipsView';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Clips' };
export default function ClipsPage() {
  return (
    <Suspense fallback={null}>
      <ClipsView />
    </Suspense>
  );
}
