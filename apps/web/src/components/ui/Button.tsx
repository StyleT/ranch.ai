export const Button = ({
  variant = 'default',
  className = '',
  ...rest
}: { variant?: 'default' | 'primary' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  const cls = {
    default: 'bg-surface-2 hover:bg-line',
    primary: 'bg-accent/25 text-fg hover:bg-accent/40',
    danger: 'bg-bad/20 text-bad hover:bg-bad/30',
  }[variant];
  return (
    <button
      type="button"
      className={`min-h-touch rounded-md px-3 text-sm font-medium disabled:opacity-50 ${cls} ${className}`}
      {...rest}
    />
  );
};
