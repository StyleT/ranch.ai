import { Skeleton } from '@/components/ui';
export default function Loading() { return <div className="grid gap-3" aria-busy="true"><Skeleton className="h-16" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>; }
