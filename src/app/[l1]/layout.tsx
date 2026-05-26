import { notFound } from 'next/navigation';
import { resolveScopeFromSegments } from '@/lib/project-url';

export const dynamic = 'force-dynamic';

export default async function L1Layout({ params, children }: { params: Promise<{ l1: string }>; children: React.ReactNode }) {
  const { l1 } = await params;
  const scope = await resolveScopeFromSegments([l1]);
  if (!scope || scope.kind !== 'folder') notFound();
  return <>{children}</>;
}
