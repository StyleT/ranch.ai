'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV } from './nav';
import { ConnectionBadge } from './ConnectionBadge';
import { ThemeToggle } from './ThemeToggle';
import { tid } from '@/lib/testids';

const isActive = (path: string, href: string) =>
  href === '/' ? path === '/' || path.startsWith('/cameras') : path.startsWith(href);

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[72px_1fr] lg:grid-cols-[240px_1fr]">
      <nav
        aria-label="Primary"
        className="md:border-line md:bg-surface hidden md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:border-r md:px-2 md:py-3"
      >
        <Link href="/" className="mb-4 px-2 text-lg font-semibold">
          ranch-ai
        </Link>
        {NAV.map((n) => (
          <Link
            key={n.page}
            href={n.href}
            data-testid={tid.nav(n.page)}
            aria-current={isActive(path, n.href) ? 'page' : undefined}
            className={`min-h-touch hover:bg-surface-2 flex items-center gap-3 rounded-md px-2 text-sm ${isActive(path, n.href) ? 'bg-surface-2 text-fg' : 'text-dim'}`}
          >
            <span aria-hidden className="w-6 text-center text-base">
              {n.icon}
            </span>
            <span className="hidden lg:inline">{n.label}</span>
            <span className="sr-only lg:hidden">{n.label}</span>
          </Link>
        ))}
      </nav>
      <div className="min-w-0">
        <header className="min-h-touch border-line bg-bg/90 sticky top-0 z-20 flex items-center gap-2 border-b px-4 backdrop-blur">
          <Link href="/" className="font-semibold md:hidden">
            ranch-ai
          </Link>
          <span className="flex-1" />
          <ConnectionBadge />
          <ThemeToggle />
        </header>
        <main
          id="main"
          className="px-4 pt-3 pb-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom)+16px)] md:pb-6 lg:mx-auto lg:max-w-[1280px]"
        >
          {children}
        </main>
      </div>
      <nav
        aria-label="Primary"
        className="border-line bg-surface fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV.map((n) => (
          <Link
            key={n.page}
            href={n.href}
            data-testid={tid.nav(n.page) + '-mobile'}
            aria-current={isActive(path, n.href) ? 'page' : undefined}
            className={`flex h-[var(--spacing-tabbar)] flex-col items-center justify-center text-xs ${isActive(path, n.href) ? 'text-fg' : 'text-dim'}`}
          >
            <span aria-hidden className="text-lg leading-none">
              {n.icon}
            </span>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
