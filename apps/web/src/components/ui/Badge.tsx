import type { ReactNode } from 'react';
export const Badge = ({
  tone = 'dim',
  children,
  ...rest
}: { tone?: 'ok' | 'bad' | 'warn' | 'dim'; children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) => {
  const cls = {
    ok: 'bg-ok/15 text-ok',
    bad: 'bg-bad/15 text-bad',
    warn: 'bg-warn/15 text-warn',
    dim: 'bg-surface-2 text-dim',
  }[tone];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`} {...rest}>
      {children}
    </span>
  );
};
