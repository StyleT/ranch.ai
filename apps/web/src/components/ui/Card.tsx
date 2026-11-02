import type { ReactNode } from 'react';
export const Card = ({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) => (
  <div className={`rounded-card border-line bg-surface border p-3 ${className}`} {...rest}>
    {children}
  </div>
);
