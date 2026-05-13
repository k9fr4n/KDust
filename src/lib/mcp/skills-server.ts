/**
 * skills MCP server (Franck 2026-05-12, ADR-0016).
 *
 * Purpose
 * -------
 * Exposes the KDust skills library (filesystem-first markdown
 * capabilities described in docs/skills.md) to Dust agents.
 * Four tools:
 *   - list_skills            (readonly) catalogue
 *   - read_skill             (readonly) SKILL.md body
 *   - read_skill_resource    (readonly) any file under the skill dir
 *   - run_skill_script       (shell exec) sandboxed to skill dir
 *
 * Dual mode
 * ---------
 *   - task mode  (runId !== null): the server is started with an
 *     allowedSkills array computed from TaskSkill bindings. ALL
 *     four tools reject any skill outside the allow-list. Secrets
 *     resolved via resolveForRun and overlaid on the spawned
 *     child env, exactly like command-runner. Output passed
 *     through the same redactor.
 *   - chat mode  (runId === null): allowedSkills is null, every
 *     on-disk skill is visible. No task-scoped secrets (none
 *     exist for /chat) -- only process.env is inherited.
 *
 * Design choices mirror command-runner-server.ts: transport
 * wiring, heartbeat, auth-failure release path, logMcpCall on
 * every invocation. No DB persistence: skills calls are not
 * audited at row level (unlike command-runner.Command); the
 * logMcpCall entry is the trail.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { getDustClient } from '../dust/client';
import { errMessage } from '../errors';
import { resolveForRun, type ResolvedSecrets } from '../secrets/repo';
import { buildRedactor, noopRedactor } from '../secrets/redact';
import { byteLen, logMcpCall } from '../logs/mcp-calls';
import { MCP_REGISTRATION_TIMEOUT_MS } from '../constants';
import {
  listSkills,
  readSkill,
  readSkillResource,
  getSkillCwd,
  isValidSkillName,
  type SkillSummary,
} from '../skills/repo';

const pExecFile = promisify(execFile);

type ServerWithTransport = McpServer & { __transport?: DustMcpServerTransport };

export interface SkillsServerHandle {
  runId: string | null;
  projectName: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

export interface StartSkillsServerInput {
  /** null in chat mode, set in task mode (for secret resolution). */
  runId: string | null;
  /** Used for logs only. Skills are global, not project-scoped. */
  projectName: string;
}

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.KDUST_SKILL_DEFAULT_TIMEOUT_MS ?? 30_000),
);
const MAX_TIMEOUT_MS = Math.max(
  DEFAULT_TIMEOUT_MS,
  Number(process.env.KDUST_SKILL_MAX_TIMEOUT_MS ?? 5 * 60_000),
);
// 1 MB stdout/stderr cap (skill scripts are expected to be small
// helpers, not full builds). Override via env if a heavy skill
// genuinely needs more.
const OUTPUT_MAX_BYTES = Math.max(
  4_096,
  Number(process.env.KDUST_SKILL_OUTPUT_MAX_BYTES ?? 1024 * 1024),
);

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function truncateOutput(s: string): { text: string; bytes: number; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8');
  const bytes = buf.byteLength;
  if (bytes <= OUTPUT_MAX_BYTES) return { text: s, bytes, truncated: false };
  const half = Math.floor(OUTPUT_MAX_BYTES / 2) - 64;
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(bytes - half).toString('utf8');
  const marker =
    `\n\n... [TRUNCATED by KDust: full size ${bytes} bytes, ` +
    `kept ${half * 2} at head/tail] ...\n\n`;
  return { text: head + marker + tail, bytes, truncated: true };
}

function asJson(payload: unknown, isError = false) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Validate a skill name (filesystem-safe, kebab-case). Returns a
 * tool-result error object when invalid, or null on success.
 *
 * ADR-0016 option 3: there is no per-task allow-list. The skills
 * catalogue is global (under git review on disk), the agent picks
 * what it needs via list_skills + read_skill. This function only
 * rejects malformed names.
 */
function checkSkillName(
  skill: string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  if (!isValidSkillName(skill)) {
    return asJson(
      { status: 'error', error: `invalid skill name: ${JSON.stringify(skill)}` },
      true,
    ) as { content: Array<{ type: 'text'; text: string }>; isError: true };
  }
  return null;
}

// ---------------------------------------------------------------
// Catalogue-in-description (2026-05-13, dust-cli pattern)
// ---------------------------------------------------------------
//
// The Dust agent does not see KDust's filesystem skill catalogue
// unless something surfaces it to the model. ADR-0016 originally
// planned a system-prompt injection hook in /api/chat + the cron
// run-agent phase; that hook was never wired (see commit history).
// Instead we embed a compact catalogue snapshot directly inside
// the `description` of the `list_skills` and `read_skill` MCP
// tools — same approach as dust-tt/dust-cli's `list_agent_skills`.
//
// The model sees, at every tool-listing, "here is the tool AND
// here is what's available", which makes proactive skill loading
// based on the user's intent / `when_to_use` actually work. The
// snapshot is taken once at server start and frozen for the life
// of the handle; new skills appear after the handle is evicted
// (POST /api/mcp/skills-ensure?force=true) or the container is
// restarted. Acceptable tradeoff: the catalogue is git-versioned
// and changes are operator-driven.
//
// A disambiguation disclaimer is repeated in each description to
// prevent confusion with Dust's native `skill_management__enable_skill`
// tool, which is an unrelated platform feature.

const SKILLS_DISCLAIMER =
  "These are KDust-local Agent Skills (filesystem-backed SKILL.md " +
  "procedures under /app/skills/). They are DIFFERENT from Dust's " +
  'native `skill_management__enable_skill` tool — do not confuse the ' +
  'two. Call this tool whenever the user asks about your skills, ' +
  'capabilities, or available procedures, OR when their request ' +
  'matches one of the catalogued `when_to_use` hints below.';

function formatCatalogueBlock(entries: SkillSummary[]): string {
  if (entries.length === 0) {
    return '\n\nNo local skills are currently installed under /app/skills/.';
  }
  const lines = entries.map((s) => {
    const when = s.whenToUse
      ? `\n    when_to_use: ${s.whenToUse.replace(/\s+/g, ' ').trim()}`
      : '';
    return `- ${s.name}: ${s.description}${when}`;
  });
  return (
    `\n\nCurrently available KDust skills (pass the exact \`name\` to ` +
    `\`read_skill\` to load the full SKILL.md body):\n${lines.join('\n')}`
  );
}

function buildListSkillsDescription(entries: SkillSummary[]): string {
  const base =
    'Return the catalogue of skills available to this agent. Skills ' +
    'are reusable, pre-built procedures (encryption helpers, audits, ' +
    'release-note drafters, ...) that can replace dozens of low-level ' +
    'steps. ALWAYS call list_skills near the start of a task or a new ' +
    'conversation when you are not already certain which skills apply: ' +
    'a 1-line catalogue lookup is much cheaper than reinventing a ' +
    'procedure. Then call read_skill(name) to load the full SKILL.md ' +
    'body before invoking any script.';
  return `${base} ${SKILLS_DISCLAIMER}${formatCatalogueBlock(entries)}`;
}

function buildReadSkillDescription(entries: SkillSummary[]): string {
  const base =
    'Return the full body of a skill (SKILL.md with frontmatter ' +
    'stripped). Load this BEFORE calling read_skill_resource or ' +
    'run_skill_script for the skill.';
  return `${base} ${SKILLS_DISCLAIMER}${formatCatalogueBlock(entries)}`;
}

// ---------------------------------------------------------------
// Server
// ---------------------------------------------------------------

export async function startSkillsServer(
  input: StartSkillsServerInput,
): Promise<SkillsServerHandle> {
  const { runId, projectName } = input;

  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  // Task-scoped secret resolution. Only meaningful when we have a
  // runId (task mode). Chat mode runs with the bare container env.
  let resolved: ResolvedSecrets | null = null;
  let redact = noopRedactor;
  if (runId) {
    try {
      resolved = await resolveForRun(runId);
    } catch (e: unknown) {
      throw new Error(`skills: secret resolution failed: ${errMessage(e)}`);
    }
    redact =
      resolved.redactList.length > 0
        ? buildRedactor(resolved.redactList, resolved.bindings)
        : noopRedactor;
    if (resolved.bindings.length > 0) {
      const names = resolved.bindings
        .map((b) => `${b.envName}<-${b.secretName}`)
        .join(', ');
      console.log(
        `[mcp/skills] run=${runId} secrets injected: ${names}`,
      );
    }
  }

  const server = new McpServer({ name: 'skills', version: '0.1.0' });

  // Snapshot the catalogue ONCE at server start so the two
  // discovery tools can embed it in their descriptions. A failure
  // here is non-fatal (empty catalogue, the tools still work and
  // will report errors when called). Freezing the snapshot for
  // the handle's lifetime keeps the tool description stable for
  // the duration of a chat / task run; operators evict via
  // POST /api/mcp/skills-ensure?force=true to pick up new skills.
  let catalogueSnapshot: SkillSummary[] = [];
  try {
    catalogueSnapshot = await listSkills();
  } catch (e: unknown) {
    console.warn(
      `[mcp/skills] catalogue snapshot failed at server start: ${errMessage(e)}`,
    );
  }

  // -------------------------------------------------------------
  // list_skills
  // -------------------------------------------------------------
  server.registerTool(
    'list_skills',
    {
      description: buildListSkillsDescription(catalogueSnapshot),
      inputSchema: {},
    },
    async () => {
      const toolStart = Date.now();
      let entries: SkillSummary[] = [];
      try {
        entries = await listSkills();
      } catch (e: unknown) {
        const text = JSON.stringify({ status: 'error', error: errMessage(e) });
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'list_skills',
          projectName,
          requestBytes: 0,
          responseBytes: byteLen(text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'list_failed',
        });
        return asJson({ status: 'error', error: errMessage(e) }, true);
      }
      const payload = { skills: entries };
      const text = JSON.stringify(payload, null, 2);
      logMcpCall({
        runId: runId ?? null,
        server: 'skills',
        tool: 'list_skills',
        projectName,
        requestBytes: 0,
        responseBytes: byteLen(text),
        durationMs: Date.now() - toolStart,
        success: true,
        errorCode: null,
      });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // -------------------------------------------------------------
  // read_skill
  // -------------------------------------------------------------
  server.registerTool(
    'read_skill',
    {
      description: buildReadSkillDescription(catalogueSnapshot),
      inputSchema: {
        name: z.string().describe('Skill name (kebab-case, matches the directory under /app/skills/).'),
      },
    },
    async (args) => {
      const toolStart = Date.now();
      const requestBytes = byteLen(args);
      const denied = checkSkillName(args.name);
      if (denied) {
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'read_skill',
          projectName,
          requestBytes,
          responseBytes: byteLen(denied.content[0].text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'invalid_name',
        });
        return denied;
      }
      try {
        const body = await readSkill(args.name);
        const trimmed = truncateOutput(body);
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'read_skill',
          projectName,
          requestBytes,
          responseBytes: byteLen(trimmed.text),
          durationMs: Date.now() - toolStart,
          success: true,
          errorCode: null,
        });
        return { content: [{ type: 'text' as const, text: trimmed.text }] };
      } catch (e: unknown) {
        const text = JSON.stringify({ status: 'error', error: errMessage(e) });
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'read_skill',
          projectName,
          requestBytes,
          responseBytes: byteLen(text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'not_found',
        });
        return asJson({ status: 'error', error: errMessage(e) }, true);
      }
    },
  );

  // -------------------------------------------------------------
  // read_skill_resource
  // -------------------------------------------------------------
  server.registerTool(
    'read_skill_resource',
    {
      description:
        'Return the UTF-8 contents of a file under the skill ' +
        'directory (e.g. "references/alphabet.md"). Path is ' +
        'resolved relative to the skill dir; absolute paths and ' +
        'parent traversal are rejected.',
      inputSchema: {
        name: z.string().describe('Skill name.'),
        path: z.string().describe('Path relative to the skill directory.'),
      },
    },
    async (args) => {
      const toolStart = Date.now();
      const requestBytes = byteLen(args);
      const denied = checkSkillName(args.name);
      if (denied) {
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'read_skill_resource',
          projectName,
          requestBytes,
          responseBytes: byteLen(denied.content[0].text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'invalid_name',
        });
        return denied;
      }
      try {
        const text = await readSkillResource(args.name, args.path);
        const trimmed = truncateOutput(text);
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'read_skill_resource',
          projectName,
          requestBytes,
          responseBytes: byteLen(trimmed.text),
          durationMs: Date.now() - toolStart,
          success: true,
          errorCode: null,
        });
        return { content: [{ type: 'text' as const, text: trimmed.text }] };
      } catch (e: unknown) {
        const t = JSON.stringify({ status: 'error', error: errMessage(e) });
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'read_skill_resource',
          projectName,
          requestBytes,
          responseBytes: byteLen(t),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'not_found',
        });
        return asJson({ status: 'error', error: errMessage(e) }, true);
      }
    },
  );

  // -------------------------------------------------------------
  // run_skill_script
  // -------------------------------------------------------------
  server.registerTool(
    'run_skill_script',
    {
      description:
        'Execute a script (or any binary on PATH) with the skill ' +
        'directory as cwd. Pass the command as an argv array: ' +
        '["bash", "scripts/encrypt.sh", "3", "hello"]. shell:false ' +
        '(no bash -c). Non-zero exit codes are returned, not ' +
        'thrown -- inspect exit_code in the JSON response.' +
        (runId && resolved && resolved.bindings.length > 0
          ? ` Pre-set env vars for this task: ${resolved.bindings
              .map((b) => b.envName)
              .join(', ')}. Values are injected server-side; do not echo them.`
          : ''),
      inputSchema: {
        skill: z.string().describe('Skill name (kebab-case).'),
        command: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Argv: command[0] is the binary, command[1..] are the args. ' +
              'Resolved relative to the skill dir for non-absolute paths.',
          ),
        stdin: z.string().optional().describe('Optional UTF-8 stdin.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Hard timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
      },
    },
    async (args) => {
      const toolStart = Date.now();
      const requestBytes = byteLen(args);
      const denied = checkSkillName(args.skill);
      if (denied) {
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'run_skill_script',
          projectName,
          requestBytes,
          responseBytes: byteLen(denied.content[0].text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'invalid_name',
        });
        return denied;
      }

      let cwd: string;
      try {
        cwd = await getSkillCwd(args.skill);
      } catch (e: unknown) {
        const t = JSON.stringify({ status: 'error', error: errMessage(e) });
        logMcpCall({
          runId: runId ?? null,
          server: 'skills',
          tool: 'run_skill_script',
          projectName,
          requestBytes,
          responseBytes: byteLen(t),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'not_found',
        });
        return asJson({ status: 'error', error: errMessage(e) }, true);
      }

      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const [cmd, ...argv] = args.command;
      const stdin = args.stdin;

      // Resolve relative cmd paths against the skill dir. This
      // lets the agent write ["scripts/encrypt.sh", "3", "hi"]
      // without prefixing every call with "./". Absolute paths
      // and PATH lookups (cmd has no slash) are passed through.
      const resolvedCmd =
        cmd.includes('/') && !path.isAbsolute(cmd)
          ? path.resolve(cwd, cmd)
          : cmd;

      // Env: inherit container env, then overlay task secrets.
      // In chat mode resolved is null, so we just pass through
      // process.env.
      const childEnv =
        resolved && Object.keys(resolved.env).length > 0
          ? { ...process.env, ...resolved.env }
          : undefined;

      let stdoutStr = '';
      let stderrStr = '';
      let exitCode: number | null = null;
      let status: 'success' | 'failed' | 'timeout' | 'killed' = 'success';
      let errorMessageStr: string | null = null;
      const start = Date.now();

      try {
        const child = pExecFile(resolvedCmd, argv, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
          encoding: 'utf8',
          env: childEnv,
          // shell:false is the execFile default; reaffirm by
          // omission. No bash -c, no glob expansion.
        });
        if (stdin !== undefined && child.child.stdin) {
          child.child.stdin.end(stdin);
        }
        const result = await child;
        stdoutStr = result.stdout?.toString() ?? '';
        stderrStr = result.stderr?.toString() ?? '';
        exitCode = 0;
      } catch (err: unknown) {
        const ee = err as {
          stdout?: { toString(): string };
          stderr?: { toString(): string };
          killed?: boolean;
          signal?: string;
          code?: number | string;
          message?: string;
        };
        stdoutStr = ee.stdout?.toString() ?? '';
        stderrStr = ee.stderr?.toString() ?? '';
        if (ee.killed) {
          status =
            ee.signal === 'SIGTERM' || ee.code === 'ETIMEDOUT'
              ? 'timeout'
              : 'killed';
          errorMessageStr = `process ${status} (signal=${ee.signal ?? '?'} code=${ee.code ?? '?'})`;
          exitCode = typeof ee.code === 'number' ? ee.code : null;
        } else {
          status = 'failed';
          exitCode = typeof ee.code === 'number' ? ee.code : null;
          errorMessageStr = errMessage(err);
        }
      }

      // Redact BEFORE truncate so secrets straddling the boundary
      // are still scrubbed. No-op when no secrets.
      const redactedStdout = redact(stdoutStr);
      const redactedStderr = redact(stderrStr);
      if (errorMessageStr) errorMessageStr = redact(errorMessageStr);
      const trimmedStdout = truncateOutput(redactedStdout);
      const trimmedStderr = truncateOutput(redactedStderr);
      const durationMs = Date.now() - start;

      const payload = {
        status,
        ok: status === 'success',
        exit_code: exitCode,
        duration_ms: durationMs,
        cwd,
        stdout: trimmedStdout.text,
        stderr: trimmedStderr.text,
        stdout_bytes: trimmedStdout.bytes,
        stderr_bytes: trimmedStderr.bytes,
        truncated_stdout: trimmedStdout.truncated,
        truncated_stderr: trimmedStderr.truncated,
        error: errorMessageStr ?? undefined,
      };
      const responseText = JSON.stringify(payload, null, 2);
      logMcpCall({
        runId: runId ?? null,
        server: 'skills',
        tool: 'run_skill_script',
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

  // -------------------------------------------------------------
  // Transport wiring (symmetric to command-runner-server.ts).
  // -------------------------------------------------------------
  const HEARTBEAT_MS = Math.max(
    60_000,
    Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000),
  );
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        console.log(
          `[mcp/skills] registered for ${runId ? `runId=${runId}` : `chat project=\"${projectName}\"`} serverId=${id}`,
        );
        resolve(id);
      },
      'skills',
      VERBOSE,
      HEARTBEAT_MS,
    );
    transport.onerror = (err: unknown) => {
      let msg = '';
      let status: number | undefined;
      let dustErrType: string | undefined;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else if (err && typeof err === 'object') {
        const eo = err as {
          status?: number;
          message?: string;
          type?: string;
          dustError?: { type?: string; message?: string };
          cause?: { dustError?: { type?: string } };
        };
        status = typeof eo.status === 'number' ? eo.status : undefined;
        dustErrType = eo.dustError?.type ?? eo.cause?.dustError?.type;
        msg = eo.message ?? eo.dustError?.message ?? eo.type ?? '';
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
          `[mcp/skills] auth failure (status=${status ?? '?'} dustErrType=${dustErrType ?? '?'}): releasing handle`,
        );
        void (async () => {
          try {
            const reg = await import('./registry');
            if (runId) await reg.releaseSkillsServer(runId);
            else await reg.releaseChatSkillsServer(projectName);
          } catch { /* ignore */ }
        })();
        return;
      }
      if (
        !msg ||
        /No activity within \d+ milliseconds/i.test(msg) ||
        /SSE connection error/i.test(msg)
      ) {
        return;
      }
      console.warn(`[mcp/skills] transport error: ${msg}`);
    };
    (server as ServerWithTransport).__transport = transport;
    server.connect(transport).catch((err) => {
      reject(err);
    });
    setTimeout(
      () =>
        reject(
          new Error(
            `skills registration timed out after ${MCP_REGISTRATION_TIMEOUT_MS}ms`,
          ),
        ),
      MCP_REGISTRATION_TIMEOUT_MS,
    );
  });

  const serverId = await ready;
  const transport = (server as ServerWithTransport).__transport as DustMcpServerTransport;
  return {
    runId,
    projectName,
    serverId,
    server,
    transport,
  };
}
