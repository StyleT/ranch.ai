import type { ReactNode } from 'react';
export const Section = ({
  title,
  action,
  children,
  id,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) => (
  <section id={id} className="mt-5">
    <h2 className="text-dim mb-2 flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
      {title}
      <span className="flex-1" />
      {action}
    </h2>
    {children}
  </section>
);
