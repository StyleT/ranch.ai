'use client';
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body style={{ background: '#0f1115', color: '#e6e8ee', fontFamily: 'system-ui', padding: 16 }}><h1>Dashboard error</h1><p>{error.message}</p><button onClick={reset}>Try again</button></body></html>;
}
