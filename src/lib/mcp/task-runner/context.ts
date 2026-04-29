/**
 * Shared context plumbed into every tool registration of the
 * task-runner MCP server. Replaces the closure-capture pattern
 * (orchestratorRunId + projectName captured by 6 inner closures of
 * startTaskRunnerServer) with an explicit object passed to each
 * registerXxxTool() factory — see ADR-0004 (2026-04-29).
 *
 * orchestratorRunId is nullable: chat-mode dispatch (Franck
 * 2026-04-25 11:31) starts the server without a parent TaskRun so
 * children dispatch as top-level (parentRunId=null, runDepth=1).
 */
export interface OrchestratorContext {
  /** Parent run id, or null in chat mode. */
  orchestratorRunId: string | null;
  /** Project fsPath this server runs under ("L1/L2/leaf" or legacy bare leaf). */
  projectName: string;
}
