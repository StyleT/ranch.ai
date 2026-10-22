import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(here, '../../'), // monorepo root -> .next/standalone/apps/web/server.js
  transpilePackages: ['@ranch/contracts', '@ranch/taxonomy'], // workspace packages export .ts source
  images: { unoptimized: true }, // the daemon resizes frames; no sharp in this process
  cacheMaxMemorySize: 0, // no in-memory fetch/ISR cache; the BFF has its own short TTL cache
  poweredByHeader: false,
  compress: false, // LAN only; CPU over bytes
  reactStrictMode: true,
};

export default config;
