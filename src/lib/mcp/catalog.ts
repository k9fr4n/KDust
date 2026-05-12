// src/lib/mcp/catalog.ts
//
// Single source of truth for the MCP servers KDust knows about
// (Franck 2026-05-09). Used by:
//   - GET /api/mcp/catalog  -> the chat header bubble
//   - any future /settings/mcp dashboard
//
// Each entry describes a server "kind" (one server type, possibly
// instantiated per project / per run) with:
//   - id          stable slug
//   - name        display label
//   - description one-liner
//   - scope       'chat' = bound to /chat sessions, status reflects
//                          the current chat
//                 'task' = only attached to TaskRuns (orchestrators
//                          and command-runners). Always shown as
//                          'task-only' in the chat UI.
//   - tools       static list of the tools this server exposes
//
// When a tool is added or removed, update this file so the chat
// bubble (and any future docs page) stay accurate. A runtime
// listTools() against a live handle would be more dynamic but adds
// latency to every chat header render -- this is the practical
// trade-off.

export type McpScope = 'chat' | 'task';

export interface McpToolDescriptor {
  name: string;
  description?: string;
}

export interface McpKindDescriptor {
  id: string;
  name: string;
  description: string;
  scope: McpScope;
  tools: McpToolDescriptor[];
}

export const MCP_CATALOG: McpKindDescriptor[] = [
  {
    id: 'fs',
    name: 'fs',
    description: 'Per-project file-system access chrooted to /projects/<project>.',
    scope: 'chat',
    tools: [
      { name: 'read_file',      description: 'Read a file under the project root.' },
      { name: 'edit_file',      description: 'Replace an exact text snippet in a file.' },
      { name: 'search_files',   description: 'Glob over the project tree.' },
      { name: 'search_content', description: 'Grep (fixed-string) inside files.' },
      { name: 'run_command',    description: 'Spawn a shell command in the project root.' },
    ],
  },
  {
    id: 'task-runner',
    name: 'task-runner',
    description: 'Discover and dispatch KDust tasks; orchestrators get this attached automatically.',
    scope: 'chat',
    tools: [
      // ADR-0008 (2026-05-03): the legacy synchronous-orchestration
      // trio (run_task / dispatch_task / wait_for_run) was removed in
      // favour of the decoupled chain model. Only these four tools
      // remain on the live server (see src/lib/mcp/task-runner/tools/).
      { name: 'list_tasks',          description: 'List dispatchable tasks.' },
      { name: 'describe_task',       description: 'Full prompt + JSON Schema of a task.' },
      { name: 'update_task_routing', description: 'Edit a task\'s routing metadata.' },
      { name: 'enqueue_followup',    description: 'Chain the next task as a fresh top-level run (decoupled chain).' },
    ],
  },
  {
    // ADR-0012 (2026-05-10): Docker MCP gateway integration. The
    // tool list is dynamic (driven by --servers=... in compose +
    // ProjectMcpToolFilter rows in DB), so this entry is mostly
    // a placeholder for the chat header bubble. The status dot
    // reflects whether the per-project proxy is bound; the actual
    // tool inventory can be inspected via /api/mcp/gateway-tools.
    id: 'mcp-gateway',
    name: 'mcp-gateway',
    description:
      'Docker MCP catalog tools (github-official, etc.) multiplexed via the sibling mcp-gateway service. Tools are whitelisted per project.',
    scope: 'chat',
    tools: [
      // Dynamic — see GET /api/mcp/gateway-tools for the live list.
    ],
  },
  {
    id: 'command-runner',
    name: 'command-runner',
    description: 'Spawn shell commands in a task-run sandbox. Attached only to TaskRuns whose Task has commandRunnerEnabled=true.',
    scope: 'task',
    tools: [
      { name: 'run_command', description: 'Spawn a shell command in the run cwd, with run-scoped env injection.' },
    ],
  },
  {
    // ADR-0016 (2026-05-12): KDust skills library. Filesystem-first
    // capabilities under /app/skills/<name>/SKILL.md, exposed via
    // four tools. In /chat the server is always attached with no
    // filter. In TaskRuns it is attached only when the Task has at
    // least one TaskSkill binding, and tools enforce that allow-list.
    id: 'skills',
    name: 'skills',
    description:
      'Reusable agent skills (SKILL.md + scripts + references) discovered, read and executed via four tools. Filtered by TaskSkill bindings in task mode; unfiltered in chat mode.',
    scope: 'chat',
    tools: [
      { name: 'list_skills',         description: 'List the catalogue of available skills (name + description).' },
      { name: 'read_skill',          description: 'Return the body of SKILL.md (frontmatter stripped).' },
      { name: 'read_skill_resource', description: 'Read a file under the skill directory; sandboxed.' },
      { name: 'run_skill_script',    description: 'Execute a script with cwd=skill dir; shell:false, 30s default timeout, secrets+redact.' },
    ],
  },
];
