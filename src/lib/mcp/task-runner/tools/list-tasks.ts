import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../../db';
import { parseTags } from '../../../task-routing';
import type { OrchestratorContext } from '../context';

/**
 * register the `list_tasks` MCP tool. See ADR-0004 for the
 * one-file-per-tool layout. The OrchestratorContext is accepted
 * for signature uniformity even though list_tasks doesn't use it
 * (the tool is purely read-only over the Task table).
 */
export function registerListTasksTool(
  server: McpServer,
  _ctx: OrchestratorContext,
): void {
    // ---------------------------------------------------------------
    // list_tasks (Franck 2026-04-25 11:22)
    //
    // Without this tool, an orchestrator agent had to know its
    // child task names a priori (typically hard-coded in the
    // prompt). For exploratory orchestrations or for the chat-mode
    // assistant, that's not workable \u2014 the agent needs a way to
    // discover what's dispatchable in the current context.
    //
    // Output is a flat array of task summaries, restricted to
    // `enabled=true` tasks (disabled ones can't be dispatched
    // anyway, exposing them would just confuse the agent). Each
    // entry includes:
    //   - id + name        : either accepted by run_task / dispatch_task
    //   - scope            : 'bound' (carries projectPath) or 'generic'
    //   - projectPath      : null for generic, set for bound
    //   - agentName        : human-readable agent label
    //   - is_orchestrator  : taskRunnerEnabled=true (can dispatch others)
    //   - push_enabled     : whether the run touches git
    //   - prompt_preview   : first ~200 chars of the stored prompt so
    //                        the agent has a hint of what the task does
    //                        without needing to fetch the full prompt
    //   - description      : ADR-0002 routing metadata. 1-3 sentences
    //                        written for the routing layer (not the
    //                        executing agent). Null when unset.
    //   - tags             : string[] for keyword matching ([] when unset).
    //   - side_effects     : 'readonly' | 'writes' | 'pushes'. Drives
    //                        the orchestrator's confirmation gate.
    //   - has_inputs_schema: boolean. The full schema is exposed by
    //                        describe_task to keep list_tasks payload
    //                        small.
    //
    // Self-listing is allowed (the calling orchestrator appears in
    // its own list_tasks output). Filtering it out would be a footgun:
    // agents can legitimately re-dispatch themselves with a different
    // input. The runner already guards against runaway recursion via
    // runDepth checks.
    // ---------------------------------------------------------------
    server.registerTool(
      'list_tasks',
      {
        description:
          `List KDust tasks that can be dispatched via run_task or ` +
          `dispatch_task. Returns enabled tasks only. Use this to ` +
          `discover available delegation targets when your prompt ` +
          `doesn't hard-code them, or to verify a task's scope ` +
          `('bound' to a project vs 'generic' template needing a ` +
          `\`project\` arg). Output: { tasks: [{id, name, scope, ` +
          `project_path, agent_name, is_orchestrator, push_enabled, ` +
          `prompt_preview, description, tags, side_effects, ` +
          `has_inputs_schema}] }. Use describe_task(id_or_name) for ` +
          `the full prompt + JSON Schema of any task.`,
        inputSchema: {
          scope: z
            .enum(['all', 'bound', 'generic'])
            .optional()
            .describe(
              'Filter by scope. "bound" = tasks tied to a specific ' +
                'project (no `project` arg needed when dispatching). ' +
                '"generic" = template tasks requiring a `project` arg. ' +
                'Defaults to "all".',
            ),
          project: z
            .string()
            .optional()
            .describe(
              'Optional project name filter. When set, returns only ' +
                'bound tasks for this project + ALL generic tasks ' +
                '(generics are project-agnostic). Useful to narrow the ' +
                'list to what is actually runnable in the current ' +
                'orchestrator context.',
            ),
        },
      },
      async (args) => {
        const scope = (args.scope as 'all' | 'bound' | 'generic' | undefined) ?? 'all';
        const projectFilter = (args.project as string | undefined)?.trim() || undefined;
  
        const tasks = await db.task.findMany({
          where: {
            enabled: true,
            ...(scope === 'bound' ? { projectPath: { not: null } } : {}),
            ...(scope === 'generic' ? { projectPath: null } : {}),
            // When a project filter is set, return bound tasks for THIS
            // project + all generics (which can run on any project). The
            // OR is built only for scope='all' to keep the query simple.
            ...(projectFilter && scope === 'all'
              ? { OR: [{ projectPath: projectFilter }, { projectPath: null }] }
              : {}),
            ...(projectFilter && scope === 'bound' ? { projectPath: projectFilter } : {}),
          },
          select: {
            id: true,
            name: true,
            projectPath: true,
            agentName: true,
            agentSId: true,
            taskRunnerEnabled: true,
            pushEnabled: true,
            prompt: true,
            description: true,
            tags: true,
            inputsSchema: true,
            sideEffects: true,
          },
          orderBy: [{ projectPath: 'asc' }, { name: 'asc' }],
        });
  
        const summaries = tasks.map((t) => ({
          id: t.id,
          name: t.name,
          scope: t.projectPath ? 'bound' : 'generic',
          project_path: t.projectPath,
          agent_name: t.agentName ?? t.agentSId,
          is_orchestrator: !!t.taskRunnerEnabled,
          push_enabled: !!t.pushEnabled,
          prompt_preview:
            t.prompt.length > 200 ? `${t.prompt.slice(0, 200).trim()}\u2026` : t.prompt.trim(),
          // ADR-0002 routing metadata. description/tags/side_effects
          // are surfaced inline because they're cheap and central to
          // the picking decision; the full inputs schema is gated
          // behind describe_task to keep list_tasks bounded in size
          // when an installation has dozens of tasks.
          description: t.description,
          tags: parseTags(t.tags),
          side_effects: t.sideEffects,
          has_inputs_schema: !!t.inputsSchema,
        }));
  
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ tasks: summaries }, null, 2),
            },
          ],
        };
      },
    );
}
