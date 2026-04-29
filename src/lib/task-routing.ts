/**
 * Task routing metadata helpers (Franck 2026-04-29, ADR-0002).
 *
 * Centralises the parsing/validation of the four routing-metadata
 * columns added to Task (description, tags, inputsSchema,
 * sideEffects). Used by:
 *   - src/app/api/task/route.ts          (POST validation)
 *   - src/app/api/task/[id]/route.ts     (PATCH validation)
 *   - src/lib/mcp/task-runner-server.ts  (list_tasks / describe_task)
 *
 * Rationale: tags + inputsSchema are stored as JSON-encoded
 * strings in SQLite (same convention as Message.toolNames). The
 * MCP layer needs typed, parsed values for the agent — keeping
 * the parse here avoids ad-hoc try/catch sprinkled across call
 * sites and centralises the failure mode (silent fallback to []
 * / null on malformed JSON; a malformed payload would only
 * happen if someone hand-edited the DB).
 */

export type SideEffects = 'readonly' | 'writes' | 'pushes';

export function isSideEffects(v: unknown): v is SideEffects {
  return v === 'readonly' || v === 'writes' || v === 'pushes';
}

/**
 * Parse the JSON-encoded tags column. Returns [] on null /
 * malformed JSON / non-array — never throws. Empty / whitespace
 * tags are dropped.
 */
export function parseTags(stored: string | null | undefined): string[] {
  if (!stored) return [];
  try {
    const v = JSON.parse(stored);
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Parse the JSON-encoded inputsSchema column. Returns null on
 * null / malformed JSON. Caller is responsible for further JSON
 * Schema validation if it wants to use the result as a contract.
 */
export function parseInputsSchema(stored: string | null | undefined): unknown {
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export interface RoutingValidationIssue {
  path: string;
  message: string;
}

/**
 * Last-mile sanity for write paths: rejects an inputsSchema string
 * that doesn't parse as JSON, or non-string tag entries that
 * survived the zod transform. Tags array shape is already
 * enforced by zod; this is the belt-and-braces pass.
 */
export function validateRoutingMetadata(payload: {
  tags?: string | null;
  inputsSchema?: string | null;
}): RoutingValidationIssue[] {
  const issues: RoutingValidationIssue[] = [];
  if (payload.tags) {
    try {
      const v: unknown = JSON.parse(payload.tags);
      if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
        issues.push({ path: 'tags', message: 'tags must serialise to a JSON array of strings' });
      }
    } catch {
      issues.push({ path: 'tags', message: 'tags must be valid JSON' });
    }
  }
  if (payload.inputsSchema) {
    try {
      JSON.parse(payload.inputsSchema);
    } catch {
      issues.push({ path: 'inputsSchema', message: 'inputsSchema must be valid JSON' });
    }
  }
  return issues;
}
