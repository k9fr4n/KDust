import { notFound } from 'next/navigation';
import { resolveScopeFromSegments } from '@/lib/project-url';

/**
 * /[l1]/[l2]/[project]/* layout (ADR-0020, Franck 2026-05-26).
 *
 * Validates that the URL segments resolve to a real project.
 * 404s otherwise. The actual cookie sync (kdust_project) is
 * handled by middleware.ts — this layout is intentionally
 * cookie-free so it can stay a pure passthrough.
 *
 * Children (chat / task / run / conversation page shells) re-use
 * the same components as the legacy top-level routes; project
 * filtering keeps flowing through getCurrentProjectFsPath() which
 * reads the middleware-synced cookie.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectLeafLayout({
  params,
  children,
}: {
  params: Promise<{ l1: string; l2: string; project: string }>;
  children: React.ReactNode;
}) {
  const { l1, l2, project } = await params;
  const scope = await resolveScopeFromSegments([l1, l2, project]);
  if (!scope || scope.kind !== 'project') notFound();
  return <>{children}</>;
}
