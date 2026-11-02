export const Chip = ({
  children,
  onRemove,
  label,
}: {
  children: React.ReactNode;
  onRemove: () => void;
  label: string;
}) => (
  <span className="bg-surface-2 m-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm">
    {children}
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      className="min-h-touch text-dim hover:text-bad min-w-6"
    >
      ×
    </button>
  </span>
);
