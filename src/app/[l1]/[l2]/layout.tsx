import { notFound } from 'next/navigation';
import { resolveScopeFromSegments } from '@/lib/project-url';

export const dynamic = 'force-dynamic';

export default async function L2Layout({ params, children }: { params: Promise<{ l1: string; l2: string }>; children: React.ReactNode }) {
  const { l1, l2 } = await params;
  const scope = await resolveScopeFromSegments([l1, l2]);
  if (!scope) notFound();
  return <>{children}</>;
}
