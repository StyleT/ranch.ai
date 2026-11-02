export const Delta = ({ d }: { d: { text: string; good: boolean } | null }) =>
  d ? <span className={`ml-1 text-xs ${d.good ? 'text-ok' : 'text-bad'}`}>({d.text})</span> : null;
