import type { ReactNode } from 'react';
export const Card = ({ children, className = '', ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) => <div className={`rounded-card border border-line bg-surface p-3 ${className}`} {...rest}>{children}</div>;
export const Section = ({ title, action, children, id }: { title: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) => (
  <section id={id} className="mt-5"><h2 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-dim">{title}<span className="flex-1" />{action}</h2>{children}</section>
);
export const Badge = ({ tone = 'dim', children, ...rest }: { tone?: 'ok' | 'bad' | 'warn' | 'dim'; children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) => {
  const cls = { ok: 'bg-ok/15 text-ok', bad: 'bg-bad/15 text-bad', warn: 'bg-warn/15 text-warn', dim: 'bg-surface-2 text-dim' }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`} {...rest}>{children}</span>;
};
export const Skeleton = ({ className = '' }: { className?: string }) => <div aria-hidden className={`animate-pulse rounded bg-surface-2 ${className}`} />;
export const Button = ({ variant = 'default', className = '', ...rest }: { variant?: 'default' | 'primary' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  const cls = { default: 'bg-surface-2 hover:bg-line', primary: 'bg-accent/25 text-fg hover:bg-accent/40', danger: 'bg-bad/20 text-bad hover:bg-bad/30' }[variant];
  return <button type="button" className={`min-h-touch rounded-md px-3 text-sm font-medium disabled:opacity-50 ${cls} ${className}`} {...rest} />;
};
