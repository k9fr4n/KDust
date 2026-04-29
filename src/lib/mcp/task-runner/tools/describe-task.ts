import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../../db';
import { parseTags, parseInputsSchema } from '../../../task-routing';
import { resolveTaskForProject } from '../resolve-task';
import type { OrchestratorContext } from '../context';

/**
 * register the `describe_task` MCP tool (ADR-0002 + ADR-0004).
 * Pure read-only — ctx is unused but accepted for signature uniformity.
 */
export function registerDescribeTaskTool(
  server: McpServer,
  ctx: OrchestratorContext,
): void {
    // ---------------------------------------------------------------
    // describe_task (Franck 2026-04-29, ADR-0002)
    //
    // Companion to list_tasks. Returns the FULL detail of a single
    // task — most importantly the full prompt and the parsed
    // inputsSchema (JSON Schema). Resolution rules mirror run_task:
    //   1. exact id
    //   2. exact (case-insensitive) name in project + generics, with
    //      project-bound winning over generic on collision.
    //
    // Self-describe is allowed (orchestrator can read its own task
    // row). The tool is read-only, no write, no dispatch.
    // ---------------------------------------------------------------
    server.registerTool(
      'describe_task',
      {
        description:
          `Return the full detail of a single KDust task — including ` +
          `the full prompt, the JSON Schema for its expected input ` +
          `(if any), tags, description, schedule, and the side-effects ` +
          `class. Use after list_tasks when you need more than the ` +
          `inline summary to decide whether to dispatch a task or ` +
          `which 'input' override to pass. Resolves task ids and ` +
          `case-insensitive names against project "${ctx.projectName}" ` +
          `tasks first, then generic (projectPath=null) tasks.`,
        inputSchema: {
          task: z
            .string()
            .min(1)
            .describe('Task ID or exact (case-insensitive) name.'),
        },
      },
      async (args) => {
        const taskRef = String(args.task ?? '').trim();
        if (!taskRef) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'task argument is required' }),
              },
            ],
          };
        }
        // Cross-project lookup by ID is allowed for describe_task
        // (Franck 2026-04-29). Rationale: it's read-only metadata,
        // not execution, so the project guard that protects run_task
        // doesn't apply. Falls back to project-scoped resolution
        // (project + generics, project-bound wins on name collision)
        // when no exact-id match — keeps name-based discovery
        // unambiguous within the orchestrator's scope.
        const byIdAny = await db.task.findUnique({
          where: { id: taskRef },
          select: { id: true },
        });
        const resolvedId = byIdAny
          ? byIdAny.id
          : (await resolveTaskForProject(ctx.projectName, taskRef))?.id;
        if (!resolvedId) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `task "${taskRef}" not found (id, or name in project="${ctx.projectName}" + generics)`,
                }),
              },
            ],
          };
        }
        const row = await db.task.findUnique({
          where: { id: resolvedId },
          select: {
            id: true,
            name: true,
            projectPath: true,
            agentName: true,
            agentSId: true,
            enabled: true,
            schedule: true,
            timezone: true,
            taskRunnerEnabled: true,
            commandRunnerEnabled: true,
            pushEnabled: true,
            dryRun: true,
            maxRuntimeMs: true,
            prompt: true,
            description: true,
            tags: true,
            inputsSchema: true,
            sideEffects: true,
          },
        });
        if (!row) {
          // Race: row deleted between resolve and findUnique. Treat
          // as not-found rather than 500 — the agent should re-list.
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: `task "${taskRef}" disappeared` }),
              },
            ],
          };
        }
        const detail = {
          id: row.id,
          name: row.name,
          scope: row.projectPath ? 'bound' : 'generic',
          project_path: row.projectPath,
          agent_name: row.agentName ?? row.agentSId,
          enabled: row.enabled,
          schedule: row.schedule,
          timezone: row.timezone,
          is_orchestrator: !!row.taskRunnerEnabled,
          command_runner_enabled: !!row.commandRunnerEnabled,
          push_enabled: !!row.pushEnabled,
          dry_run: !!row.dryRun,
          max_runtime_ms: row.maxRuntimeMs,
          prompt: row.prompt,
          description: row.description,
          tags: parseTags(row.tags),
          // Parsed JSON Schema object (or null when unset / malformed).
          // The agent receives a typed object, not a JSON string, so
          // it can be fed directly to a schema-aware validator on the
          // call site without re-parsing.
          inputs_schema: parseInputsSchema(row.inputsSchema),
          side_effects: row.sideEffects,
        };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(detail, null, 2) },
          ],
        };
      },
    );
}
