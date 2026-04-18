import { getCurrentProject } from '@/lib/current-project';
import { AdvicesClient } from './client';

export const dynamic = 'force-dynamic';

/**
 * /advices — priority-advice browser.
 *
 * Server entry point: reads the global project scope from the
 * kdust_project cookie (set by the top navbar project selector) and
 * forwards it to the client component. The cookie IS the project
 * filter for the whole app:
 *   - no cookie ("All projects") → cross-project view with averaged
 *     tiles and every project visible in the list;
 *   - cookie set                 → scoped view with the project's
 *     raw scores and only its rows visible.
 */
export default async function AdvicePage() {
  const currentProject = await getCurrentProject();
  return (
    <AdvicesClient
      scopedProjectId={currentProject?.id ?? null}
      scopedProjectName={currentProject?.name ?? null}
    />
  );
}
