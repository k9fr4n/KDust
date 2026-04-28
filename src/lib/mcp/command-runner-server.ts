/**
 * command-runner MCP server (Franck 2026-04-21 13:39).
 *
 * Purpose
 * -------
 * Exposes a single tool `run_command` to Dust agents running inside
 * a KDust task. Same intent as the fs-cli's `run_command` but:
 *   - hosted server-side (transport owned by KDust, not Dust)
 *   - every invocation is persisted in the `Command` table so the
 *     UI and audit trail can show exactly what was executed
 *   - enforces a denylist of dangerous args (configurable by env)
 *   - chroot'd to the project working tree, same discipline as fs-cli
 *
 * Design choices mirror task-runner-server.ts:
 *   1. One server handle per run (cached by runId in registry.ts).
 *   2. Same token refresh watchdog + onerror auth-failure handling.
 *   3. Opt-in per task via Task.commandRunnerEnabled.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { z } from 'zod';
import { getDustClient } from '../dust/client';
import { db } from '../db';
import { resolveForRun, type ResolvedSecrets } from '../secrets/repo';
import { buildRedactor, noopRedactor } from '../secrets/redact';
import { byteLen, logMcpCall } from '../logs/mcp-calls';

const pExecFile = promisify(execFile);

export interface CommandRunnerHandle {
  runId: string;
  projectName: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECTS_ROOT = process.env.KDUST_PROJECTS_ROOT ?? '/projects';
const DEFAULT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.KDUST_CMD_DEFAULT_TIMEOUT_MS ?? 120_000),
);
const MAX_TIMEOUT_MS = Math.max(
  DEFAULT_TIMEOUT_MS,
  Number(process.env.KDUST_CMD_MAX_TIMEOUT_MS ?? 15 * 60_000),
);
// stdout/stderr soft cap before truncation. Full size is recorded in
// stdoutBytes/stderrBytes; the stored text keeps a head+tail around the
// cap to stay useful in the UI without bloating the SQLite DB.
//
// Default lowered from 32KB to 8KB on 2026-04-28 (Franck) after a
// provider-coder run blew the model's context window: 48 cumulated
// run_command outputs at 32KB each saturated the conversation
// history. 8KB is enough to surface compile errors / test
// failures (which are tail-heavy) while keeping room for a long
// agent loop. Override via KDUST_CMD_OUTPUT_MAX_BYTES if needed
// (e.g. for an interactive session that genuinely needs more).
const OUTPUT_MAX_BYTES = Math.max(
  4_096,
  Number(process.env.KDUST_CMD_OUTPUT_MAX_BYTES ?? 8 * 1024),
);

// Denylist of argv fragments. Matched case-insensitively against the
// joined argv string. Keep tight: we don't want to ban legitimate
// docker usage, just the foot-guns.
//
// Defaults reject:
//   --privileged        (container escape)
//   -v /:               (mount host root)
//   --pid=host          (host pid namespace)
//   --net=host / --network=host (host networking)
//   --cap-add=SYS_ADMIN (kernel caps escalation)
//   --device /dev/      (raw host device)
//
// Override with env KDUST_CMD_DENYLIST (comma-separated patterns,
// regex syntax). Set to empty string to disable.
const DEFAULT_DENYLIST = [
  '--privileged',
  '-v\\s+/:', '-v=/:',
  '--mount[^\\s]*src=/[\\s,]', '--mount[^\\s]*source=/[\\s,]',
  '--pid=host',
  '--net=host', '--network=host',
  '--cap-add=SYS_ADMIN', '--cap-add=ALL',
  '--device\\s+/dev/',
];
const DENYLIST: RegExp[] = (
  process.env.KDUST_CMD_DENYLIST !== undefined
    ? process.env.KDUST_CMD_DENYLIST.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_DENYLIST
).map((p) => new RegExp(p, 'i'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chroot(root: string, requested?: string): string {
  // Reuse the same discipline as fs-tools.ts: resolve requested cwd
  // relative to root, refuse anything that escapes root.
  const base = path.resolve(root);
  const target = requested ? path.resolve(base, requested) : base;
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`cwd escapes project root: ${requested}`);
  }
  return target;
}

function truncateOutput(s: string): { text: string; bytes: number } {
  const buf = Buffer.from(s, 'utf8');
  const bytes = buf.byteLength;
  if (bytes <= OUTPUT_MAX_BYTES) return { text: s, bytes };
  const half = Math.floor(OUTPUT_MAX_BYTES / 2) - 64;
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(bytes - half).toString('utf8');
  const marker = `\n\n\u2026 [TRUNCATED by KDust: full size ${bytes} bytes, kept ${half * 2} at head/tail] \u2026\n\n`;
  return { text: head + marker + tail, bytes };
}

function matchedDenylist(argv: string[]): RegExp | null {
  if (DENYLIST.length === 0) return null;
  const joined = argv.join(' ');
  for (const rx of DENYLIST) {
    if (rx.test(joined)) return rx;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startCommandRunnerServer(
  runId: string,
  projectName: string,
): Promise<CommandRunnerHandle> {
  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  const projectRoot = path.join(PROJECTS_ROOT, projectName);

  // Resolve secret bindings for the owning task ONCE per server
  // lifetime (Franck 2026-04-21 21:30). Keeps the spawn hot-path
  // DB-free and ensures every run_command in this session gets the
  // same env contract \u2014 no mid-run rotation surprise. If resolution
  // fails (e.g. secret was deleted between task config and run), we
  // throw so the task fails loudly rather than executing without
  // credentials it was configured to receive.
  let resolved: ResolvedSecrets;
  try {
    resolved = await resolveForRun(runId);
  } catch (e: any) {
    throw new Error(`command-runner: secret resolution failed: ${e?.message ?? e}`);
  }
  const redact =
    resolved.redactList.length > 0
      ? buildRedactor(resolved.redactList, resolved.bindings)
      : noopRedactor;
  if (resolved.bindings.length > 0) {
    // Log NAMES only. Under no circumstances should values be logged
    // here \u2014 the redactor only protects subprocess stdout/stderr.
    const names = resolved.bindings
      .map((b) => `${b.envName}\u2190${b.secretName}`)
      .join(', ');
    console.log(
      `[mcp/command-runner] run=${runId} secrets injected: ${names}`,
    );
  }

  const server = new McpServer({ name: 'command-runner', version: '0.1.0' });

  server.registerTool(
    'run_command',
    {
      description:
        `Execute a shell command inside the "${projectName}" project workspace. ` +
        `Every invocation is logged by KDust (visible on /run/<id>). ` +
        `Chrooted to the project working tree. Dangerous argv patterns ` +
        `(--privileged, -v /:, --pid=host, \u2026) are rejected before spawning. ` +
        `Prefer this tool over fs-cli's run_command when you need reliable, ` +
        `observable execution.` +
        (resolved.bindings.length > 0
          ? ` Pre-set env vars for this task: ${resolved.bindings
              .map((b) => b.envName)
              .join(', ')}. Values are injected server-side; don't echo them and don't pass them via argv.`
          : ''),
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe('Binary to run (e.g. git, npm, docker, pwsh). PATH is inherited from the KDust container.'),
        args: z
          .array(z.string())
          .optional()
          .describe('Argv for the command. Pass as discrete strings, not a single shell-like string.'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory. Relative to the project root. Must stay under it.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Hard timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
        stdin: z
          .string()
          .optional()
          .describe('Optional stdin piped to the process (UTF-8).'),
      },
    },
    async (input) => {
      // Layer-1 observability (Franck 2026-04-28): start time is
      // captured BEFORE chroot/denylist so even denied calls are
      // measured.
      const toolStart = Date.now();
      const requestBytes = byteLen(input);
      const cmd = input.command as string;
      const argv = (input.args as string[] | undefined) ?? [];
      const requestedCwd = input.cwd as string | undefined;
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        (input.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS,
      );
      const stdin = input.stdin as string | undefined;

      // Resolve cwd (may throw if escaping root). We create the row
      // AFTER chroot validation so denied cwd attempts don't pollute
      // the table — but DO log denylist hits (they're interesting).
      let cwd: string;
      try {
        cwd = chroot(projectRoot, requestedCwd);
      } catch (e: any) {
        const text = JSON.stringify({
          status: 'denied',
          error: e?.message ?? 'cwd escapes project root',
        });
        logMcpCall({
          runId,
          server: 'command-runner',
          tool: 'run_command',
          projectName,
          requestBytes,
          responseBytes: byteLen(text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'chroot',
        });
        return {
          content: [{ type: 'text' as const, text }],
          isError: true,
        };
      }

      // Denylist check
      const hit = matchedDenylist([cmd, ...argv]);
      if (hit) {
        const row = await db.command.create({
          data: {
            runId,
            command: cmd,
            args: JSON.stringify(argv),
            cwd,
            status: 'denied',
            errorMessage: `denylist pattern matched: ${hit.source}`,
            finishedAt: new Date(),
            durationMs: 0,
          },
        });
        const text = JSON.stringify({
          command_id: row.id,
          status: 'denied',
          error: `KDust denylist blocked this command (pattern: ${hit.source}). Revise args or adjust KDUST_CMD_DENYLIST if this was a false positive.`,
        });
        logMcpCall({
          runId,
          server: 'command-runner',
          tool: 'run_command',
          projectName,
          requestBytes,
          responseBytes: byteLen(text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'denylist',
        });
        return {
          content: [{ type: 'text' as const, text }],
          isError: true,
        };
      }

      const row = await db.command.create({
        data: {
          runId,
          command: cmd,
          args: JSON.stringify(argv),
          cwd,
          status: 'running',
        },
      });
      const start = Date.now();

      let stdoutStr = '';
      let stderrStr = '';
      let exitCode: number | null = null;
      let status: 'success' | 'failed' | 'timeout' | 'killed' = 'success';
      let errorMessage: string | null = null;

      try {
        // Build the child-process env: start from the KDust container
        // env so binaries find their PATH, HOME, etc., then overlay
        // the task-bound secrets. Overlay (not prepend) because if a
        // user deliberately pins GITHUB_TOKEN in a TaskSecret they
        // mean to override whatever was inherited from the KDust
        // container \u2014 we trust the user\u0027s explicit config over the
        // ambient env.
        const childEnv =
          Object.keys(resolved.env).length > 0
            ? { ...process.env, ...resolved.env }
            : undefined; // keep default inheritance when no secrets
        const child = pExecFile(cmd, argv, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024, // 50MB upper bound before libuv kills the process
          encoding: 'utf8',
          env: childEnv,
        });
        if (stdin !== undefined && child.child.stdin) {
          child.child.stdin.end(stdin);
        }
        const result = await child;
        stdoutStr = result.stdout?.toString() ?? '';
        stderrStr = result.stderr?.toString() ?? '';
        exitCode = 0;
      } catch (err: any) {
        stdoutStr = err?.stdout?.toString() ?? '';
        stderrStr = err?.stderr?.toString() ?? '';
        if (err?.killed) {
          status = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT' ? 'timeout' : 'killed';
          errorMessage = `process ${status} (signal=${err?.signal ?? '?'} code=${err?.code ?? '?'})`;
          exitCode = typeof err?.code === 'number' ? err.code : null;
        } else {
          status = 'failed';
          exitCode = typeof err?.code === 'number' ? err.code : null;
          errorMessage = err?.message ?? String(err);
        }
      }

      // Redact BEFORE truncation so a secret that straddles the
      // truncation boundary still gets scrubbed (truncateOutput
      // could split it into head/tail halves that individually
      // don\u0027t match as literal). Redactor is a no-op when no
      // secrets are bound, so the overhead is zero in that case.
      const redactedStdout = redact(stdoutStr);
      const redactedStderr = redact(stderrStr);
      // errorMessage can legitimately carry the command\u0027s own error
      // text (Node\u0027s execFile rejection includes the tail of stderr),
      // so scrub it too before persistence / LLM return.
      if (errorMessage) errorMessage = redact(errorMessage);
      const trimmedStdout = truncateOutput(redactedStdout);
      const trimmedStderr = truncateOutput(redactedStderr);
      const durationMs = Date.now() - start;

      await db.command.update({
        where: { id: row.id },
        data: {
          exitCode,
          stdout: trimmedStdout.text,
          stderr: trimmedStderr.text,
          stdoutBytes: trimmedStdout.bytes,
          stderrBytes: trimmedStderr.bytes,
          durationMs,
          finishedAt: new Date(),
          status,
          errorMessage,
        },
      });

      const payload = {
        command_id: row.id,
        status,
        exit_code: exitCode,
        duration_ms: durationMs,
        stdout: trimmedStdout.text,
        stderr: trimmedStderr.text,
        stdout_bytes: trimmedStdout.bytes,
        stderr_bytes: trimmedStderr.bytes,
        truncated_stdout: trimmedStdout.bytes > OUTPUT_MAX_BYTES,
        truncated_stderr: trimmedStderr.bytes > OUTPUT_MAX_BYTES,
        error: errorMessage ?? undefined,
      };
      const responseText = JSON.stringify(payload, null, 2);
      logMcpCall({
        runId,
        server: 'command-runner',
        tool: 'run_command',
        projectName,
        requestBytes,
        responseBytes: byteLen(responseText),
        durationMs: Date.now() - toolStart,
        success: status === 'success',
        errorCode: status === 'success' ? null : status,
      });
      return {
        content: [{ type: 'text' as const, text: responseText }],
        isError: status !== 'success',
      };
    },
  );

  // Transport wiring — symmetric with task-runner-server.
  const HEARTBEAT_MS = Math.max(
    60_000,
    Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000),
  );
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';

  // apiKey rotation handled transparently by the SDK via the async
  // callable passed in getDustClient() \u2014 no watchdog needed.

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        console.log(
          `[mcp/command-runner] registered for runId=${runId} project="${projectName}" serverId=${id}`,
        );
        resolve(id);
      },
      'command-runner',
      VERBOSE,
      HEARTBEAT_MS,
    );
    transport.onerror = (err: any) => {
      let msg = '';
      let status: number | undefined;
      let dustErrType: string | undefined;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else if (err && typeof err === 'object') {
        status = typeof err.status === 'number' ? err.status : undefined;
        dustErrType = err.dustError?.type ?? err.cause?.dustError?.type;
        msg = err.message ?? err.dustError?.message ?? err.type ?? '';
        try { msg = msg || JSON.stringify(err); } catch { /* circular */ }
      }
      const isAuthFailure =
        status === 401 ||
        dustErrType === 'expired_oauth_token_error' ||
        /401\s+Unauthorized/i.test(msg) ||
        /expired_oauth_token_error/i.test(msg) ||
        /access token (has )?expired/i.test(msg);
      if (isAuthFailure) {
        console.warn(
          `[mcp/command-runner] auth failure for run=${runId} (status=${status ?? '?'} dustErrType=${dustErrType ?? '?'}): releasing handle`,
        );
        void (async () => {
          try {
            const { releaseCommandRunnerServer } = await import('./registry');
            await releaseCommandRunnerServer(runId);
          } catch { /* ignore */ }
        })();
        return;
      }
      if (!msg || /No activity within \d+ milliseconds/i.test(msg) || /SSE connection error/i.test(msg)) {
        return;
      }
      console.warn(`[mcp/command-runner] transport error: ${msg}`);
    };
    (server as any).__transport = transport;
    server.connect(transport).catch((err) => {
      reject(err);
    });
    setTimeout(() => reject(new Error('command-runner registration timed out after 15s')), 15000);
  });

  const serverId = await ready;
  const transport = (server as any).__transport as DustMcpServerTransport;
  return {
    runId,
    projectName,
    serverId,
    server,
    transport,
  };
}
