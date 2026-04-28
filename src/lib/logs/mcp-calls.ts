/**
 * Layer-0 + Layer-1 observability for MCP traffic and Dust rejects
 * (Franck 2026-04-28).
 *
 * Goal: diagnose context-overflow incidents ("Your message or
 * retrieved data is too large") without changing runtime behaviour.
 *
 * - Layer 0: detect Dust rejects that look like a window overflow
 *   and emit a structured `[dust-overflow]` line carrying enough
 *   context (runId, conversation, message bytes, fileIds, attachment
 *   bytes) to know who/what saturated.
 *
 * - Layer 1: every MCP tool call (fs-cli, command-runner, task-runner)
 *   emits a normalized `[mcp]` line with bytes_in/bytes_out/ms so we
 *   can tail a run live in /logs and see accumulation in real time.
 *
 * No DB writes — deliberately. Layer 2 (persistence) is a follow-up.
 * Keep this module dependency-light: it must be safe to import from
 * any MCP tool callback, including hot paths.
 */

export interface McpCallLog {
  /** TaskRun.id when known. fs-cli is per-project, not per-run, so
   *  it logs `?` here. command-runner / task-runner have it. */
  runId?: string | null;
  /** MCP server name as seen by Dust: 'fs-cli' | 'command-runner' | 'task-runner'. */
  server: string;
  /** Tool name within that server, e.g. 'read_file', 'run_command'. */
  tool: string;
  /** Optional project name, useful for fs-cli where runId is unknown. */
  projectName?: string | null;
  /** UTF-8 byte length of the request payload (args). */
  requestBytes: number;
  /** UTF-8 byte length of the response payload (text returned to Dust). */
  responseBytes: number;
  /** Wall time of the tool execution. */
  durationMs: number;
  /** Did the tool report success (no isError). */
  success: boolean;
  /** Optional short error tag when !success. */
  errorCode?: string | null;
}

/**
 * Best-effort UTF-8 byte length. Accepts any value: stringifies
 * non-strings; returns 0 for null/undefined. Never throws.
 */
export function byteLen(v: unknown): number {
  if (v === null || v === undefined) return 0;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return Buffer.byteLength(s ?? '', 'utf-8');
  } catch {
    return 0;
  }
}

/**
 * Emit a single `[mcp]` log line. One-liner, machine-parsable, fits
 * in the ring buffer with low overhead. Keep the format STABLE —
 * downstream tooling (future Layer 4 dashboard) will grep on it.
 */
export function logMcpCall(c: McpCallLog): void {
  const run = c.runId ?? '?';
  const proj = c.projectName ? ` project=${c.projectName}` : '';
  const status = c.success ? 'ok' : `fail${c.errorCode ? `(${c.errorCode})` : ''}`;
  // No payload contents — only sizes — to avoid leaking secrets.
  console.log(
    `[mcp] run=${run}${proj} server=${c.server} tool=${c.tool} ` +
      `bytes_in=${c.requestBytes} bytes_out=${c.responseBytes} ` +
      `ms=${c.durationMs} ${status}`,
  );
}

/**
 * Heuristic: did Dust just refuse a turn because the context window
 * was exceeded ? The exact wording observed in the wild is:
 *   "Your message or retrieved data is too large. Break your
 *    request into smaller parts or reduce agent output."
 * Other variants ("context length", "context window", "too long")
 * are accepted defensively in case Dust changes the copy.
 */
export function looksLikeContextOverflow(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return '';
            }
          })();
  if (!msg) return false;
  return (
    /retrieved data is too large/i.test(msg) ||
    /message.*too large/i.test(msg) ||
    /context (length|window).*exceed/i.test(msg) ||
    /reduce agent output/i.test(msg) ||
    /too long for the model/i.test(msg)
  );
}

export interface DustOverflowLog {
  runId?: string | null;
  agentSId?: string | null;
  conversationSId?: string | null;
  /** UTF-8 bytes of the user message body just posted. */
  messageBytes: number;
  /** Number of pre-uploaded Dust file ids attached to the message. */
  fileCount: number;
  /** When fs-cli usage is correlated, the project at hand. */
  projectName?: string | null;
  /** Verbatim Dust error message (already public, no secret). */
  upstreamMessage: string;
}

/**
 * Layer 0: emit a one-liner the moment a context-overflow rejection
 * is detected. The log line is intentionally distinctive so /logs
 * can be filtered on `[dust-overflow]` and a future alert hooked on it.
 */
export function logDustOverflow(o: DustOverflowLog): void {
  const run = o.runId ?? '?';
  const agent = o.agentSId ?? '?';
  const conv = o.conversationSId ?? '?';
  const proj = o.projectName ? ` project=${o.projectName}` : '';
  const trimmedMsg = o.upstreamMessage.replace(/\s+/g, ' ').slice(0, 200);
  console.warn(
    `[dust-overflow] run=${run}${proj} agent=${agent} conv=${conv} ` +
      `msg_bytes=${o.messageBytes} files=${o.fileCount} ` +
      `upstream="${trimmedMsg}"`,
  );
}
