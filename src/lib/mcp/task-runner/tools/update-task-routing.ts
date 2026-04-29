import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../../db';
import { parseTags, parseInputsSchema } from '../../../task-routing';
import { resolveTaskForProject } from '../resolve-task';
import type { OrchestratorContext } from '../context';

/**
 * register the `update_task_routing` MCP tool (ADR-0002 + ADR-0004).
 * Pure write — ctx is unused but accepted for signature uniformity.
 */
export function registerUpdateTaskRoutingTool(
  server: McpServer,
  ctx: OrchestratorContext,
): void {
    // ---------------------------------------------------------------
    // update_task_routing (Franck 2026-04-29, ADR-0002)
    //
    // Targeted write tool: edits ONLY the four routing-metadata
    // columns of a Task row. Intended for the "task-routing-backfill"
    // assistant — an agent that walks the catalogue and fills
    // description/tags/inputsSchema/sideEffects on legacy rows.
    //
    // Why a dedicated tool instead of a generic "patch_task":
    //   - the surface area is bounded (4 fields, all sanitised by
    //     task-routing.ts) — no risk of an agent flipping pushEnabled
    //     or projectPath by accident
    //   - cross-project by ID (same rationale as describe_task: it's
    //     metadata, not execution)
    //   - no generic-task invariant interaction (none of the 4
    //     fields participate in those invariants)
    //
    // The HTTP API (/api/task/[id]) accepts the same payload but is
    // gated by APP_PASSWORD; an agent running inside a TaskRun has
    // no easy way to authenticate against it. This MCP tool short-
    // circuits that constraint safely.
    // ---------------------------------------------------------------
    server.registerTool(
      'update_task_routing',
      {
        description:
          `Update the routing metadata (description, tags, inputs ` +
          `schema, side-effects) of a single task. Cross-project by ` +
          `id. Other Task columns are left untouched. Pass only the ` +
          `fields you want to change; omitted fields are not modified ` +
          `(use null explicitly to clear a field). Returns the post- ` +
          `update routing view of the task.`,
        inputSchema: {
          task: z
            .string()
            .min(1)
            .describe('Task ID or exact (case-insensitive) name. ID lookup is cross-project.'),
          description: z
            .string()
            .nullable()
            .optional()
            .describe('1-3 sentences for the routing layer. null clears.'),
          tags: z
            .array(z.string())
            .nullable()
            .optional()
            .describe('Array of keyword strings. null or [] clears.'),
          inputs_schema: z
            .record(z.unknown())
            .nullable()
            .optional()
            .describe('JSON Schema object describing the expected `input` override. null clears.'),
          side_effects: z
            .enum(['readonly', 'writes', 'pushes'])
            .optional()
            .describe('readonly | writes | pushes. Drives the orchestrator confirmation gate.'),
        },
      },
      async (args) => {
        const taskRef = String(args.task ?? '').trim();
        if (!taskRef) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'task argument is required' }) }],
          };
        }
        // Same cross-project-by-id resolution as describe_task.
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
                text: JSON.stringify({ error: `task "${taskRef}" not found` }),
              },
            ],
          };
        }
        // Build a partial update payload. Each field is processed
        // independently so a caller can clear one and set another in
        // the same call. Tags and inputs_schema are serialised here
        // (DB stores them as JSON-encoded strings).
        const data: {
          description?: string | null;
          tags?: string | null;
          inputsSchema?: string | null;
          sideEffects?: string;
        } = {};
        if ('description' in args) {
          const d = args.description;
          data.description = typeof d === 'string' && d.trim() ? d.trim() : null;
        }
        if ('tags' in args) {
          const t = args.tags;
          if (t == null) data.tags = null;
          else {
            const cleaned = (t as string[]).map((s) => String(s).trim()).filter(Boolean);
            data.tags = cleaned.length ? JSON.stringify(cleaned) : null;
          }
        }
        if ('inputs_schema' in args) {
          const s = args.inputs_schema;
          data.inputsSchema = s == null ? null : JSON.stringify(s);
        }
        if ('side_effects' in args && typeof args.side_effects === 'string') {
          data.sideEffects = args.side_effects;
        }
        if (Object.keys(data).length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'no field to update (pass description, tags, inputs_schema, or side_effects)',
                }),
              },
            ],
          };
        }
        const updated = await db.task.update({
          where: { id: resolvedId },
          data,
          select: {
            id: true,
            name: true,
            projectPath: true,
            description: true,
            tags: true,
            inputsSchema: true,
            sideEffects: true,
          },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ok: true,
                  task: {
                    id: updated.id,
                    name: updated.name,
                    scope: updated.projectPath ? 'bound' : 'generic',
                    project_path: updated.projectPath,
                    description: updated.description,
                    tags: parseTags(updated.tags),
                    inputs_schema: parseInputsSchema(updated.inputsSchema),
                    side_effects: updated.sideEffects,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
}
