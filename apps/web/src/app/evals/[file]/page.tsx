import { notFound } from 'next/navigation';
import { ResultView } from '@/features/evals/ResultView';
export const dynamic = 'force-dynamic';
export default async function ResultPage({ params }: { params: Promise<{ file: string }> }) {
  const { file } = await params; if (!/^[\w.-]+\.json$/.test(file)) notFound();
  return <ResultView file={file} />;
}
