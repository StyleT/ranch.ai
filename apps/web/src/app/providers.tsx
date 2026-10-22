'use client';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { makeQueryClient } from '@/lib/query/client';
import { LiveProvider } from '@/features/live/LiveProvider';
import { TzContext } from '@/lib/tz';

export function Providers({ children, tz }: { children: React.ReactNode; tz: string }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <TzContext.Provider value={tz}><LiveProvider>{children}</LiveProvider></TzContext.Provider>
    </QueryClientProvider>
  );
}
