export const Skeleton = ({ className = '' }: { className?: string }) => (
  <div aria-hidden className={`bg-surface-2 animate-pulse rounded ${className}`} />
);
