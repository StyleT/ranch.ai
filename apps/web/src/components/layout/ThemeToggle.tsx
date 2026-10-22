'use client';
import { useState } from 'react';
import { tid } from '@/lib/testids';
type Theme = 'system' | 'dark' | 'light';
const resolve = (t: Theme) => (t === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t);
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => { if (typeof window === 'undefined') return 'system'; try { return (localStorage.getItem('ranch.theme') as Theme) || 'system'; } catch { return 'system'; } });
  const next = () => { const order: Theme[] = ['system', 'dark', 'light']; const t = order[(order.indexOf(theme) + 1) % 3]!; setTheme(t); try { localStorage.setItem('ranch.theme', t); } catch { /* ignore */ } document.documentElement.setAttribute('data-theme', resolve(t)); };
  return <button type="button" onClick={next} data-testid={tid.themeToggle} suppressHydrationWarning aria-label={`Theme: ${theme}. Change theme`} className="min-h-touch min-w-touch rounded-md text-base hover:bg-surface-2">{theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐'}</button>;
}
