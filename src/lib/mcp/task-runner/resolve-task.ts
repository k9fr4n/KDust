import { db } from '../../db';

/**
 * Resolve a task reference (id or name) for dispatch by an orchestrator.
 *
 * Lookup scope (in order):
 *   1. Exact id match. Accepted if the row belongs to `projectName`
 *      OR is a generic task (projectPath=null).
 *   2. Exact (case-insensitive) name match among:
 *        - tasks of `projectName`, AND
 *        - generic tasks (projectPath=null).
 *      If both a project-bound AND a generic task share the same name,
 *      the PROJECT-BOUND one wins (more specific → less surprising).
 *
 * Returns the resolved row with `isGeneric` flag so the caller can
 * enforce the `project` argument rules correctly.
 */
export async function resolveTaskForProject(
  projectName: string,
  taskRef: string,
): Promise<{
  id: string;
  name: string;
  taskRunnerEnabled: boolean;
  isGeneric: boolean;
} | null> {
  // 1) exact id lookup
  const byId = await db.task.findUnique({
    where: { id: taskRef },
    select: { id: true, name: true, projectPath: true, taskRunnerEnabled: true },
  });
  if (byId && (byId.projectPath === projectName || byId.projectPath === null)) {
    return {
      id: byId.id,
      name: byId.name,
      taskRunnerEnabled: byId.taskRunnerEnabled,
      isGeneric: byId.projectPath === null,
    };
  }

  // 2) case-insensitive name match: project-bound wins over generic.
  const bound = await db.task.findFirst({
    where: { projectPath: projectName, name: { equals: taskRef } },
    select: { id: true, name: true, taskRunnerEnabled: true },
    orderBy: { createdAt: 'desc' },
  });
  if (bound) return { ...bound, isGeneric: false };

  const generic = await db.task.findFirst({
    where: { projectPath: null, name: { equals: taskRef } },
    select: { id: true, name: true, taskRunnerEnabled: true },
    orderBy: { createdAt: 'desc' },
  });
  if (generic) return { ...generic, isGeneric: true };

  return null;
}
