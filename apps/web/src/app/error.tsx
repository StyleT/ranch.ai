'use client';
import { Card, Button } from '@/components/ui';
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <Card role="alert" className="text-sm"><b className="text-bad">Something went wrong.</b> <span className="text-dim">{error.message}{error.digest ? ` (${error.digest})` : ''}</span><div className="mt-2"><Button onClick={reset}>Try again</Button></div></Card>;
}
