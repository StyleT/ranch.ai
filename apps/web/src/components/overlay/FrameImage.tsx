'use client';
import { useState } from 'react';
/** Frame <img> with width buckets via `sizes`, lazy by default, skeleton until loaded, error state. */
export function FrameImage({ src, alt, sizes = '(min-width: 1024px) 400px, (min-width: 768px) 33vw, 50vw', priority = false }: { src: string; alt: string; sizes?: string; priority?: boolean }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const sep = src.includes('?') ? '&' : '?';
  const srcSet = [320, 640, 1280, 1920].map((w) => `${src}${sep}w=${w} ${w}w`).join(', ');
  return (
    <>
      {state === 'loading' && <div aria-hidden className="absolute inset-0 animate-pulse bg-surface-2" />}
      {state === 'error' && <div role="img" aria-label={`${alt} (unavailable)`} className="absolute inset-0 flex items-center justify-center text-xs text-dim">no image</div>}
      <img src={`${src}${sep}w=640`} srcSet={srcSet} sizes={sizes} alt={alt} loading={priority ? 'eager' : 'lazy'} decoding="async" onLoad={() => setState('ok')} onError={() => setState('error')} className={`h-full w-full object-cover ${state === 'ok' ? '' : 'opacity-0'}`} />
    </>
  );
}
