import { promises as fsp, existsSync, statSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { glob } from 'glob';
import { errMessage } from '../errors';
import { fetchFilBody, type FilFetchError } from '../dust/files';
import { getDustClient } from '../dust/client';
import {
  parsePatch,
  applyHunksToContent,
  PatchError,
  type PatchOp,
} from './apply-patch';

const pExecFile = promisify(execFile);

/**
 * Ensure `userPath` stays inside `root`.
 * Throws if the resolved path escapes the root directory.
 * If userPath is falsy, returns root.
 */
export function chroot(root: string, userPath?: string | null): string {
  const target = userPath && userPath.length > 0 ? userPath : root;
  // If user gave a relative path, resolve it from root ; if absolute, keep it.
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(
      `Path escapes project root: ${resolved} not under ${normalizedRoot}`,
    );
  }
  return resolved;
}

export function toText(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * MCP tool-output size budget (Franck 2026-04-24 09:25).
 *
 * Dust rejects agent turns whose cumulative context exceeds the
 * model's window with:
 *   "Your message or retrieved data is too large. Break your
 *    request into smaller parts or reduce agent output."
 *
 * Every tool result is injected verbatim into the next turn's
 * prompt, so an unrestricted `read_file` on a 500 KB file or a
 * `run_command` that prints 2 MB of build log is enough to push
 * the conversation past the limit after a handful of turns.
 *
 * We cap each tool's text payload at OUTPUT_MAX_BYTES (default
 * 48 KB, overridable via KDUST_MCP_TOOL_OUTPUT_MAX_BYTES). When a
 * payload exceeds the budget we keep the first half and the last
 * half separated by a machine-readable truncation marker the
 * agent can detect and act on (retry with offset/limit, grep
 * narrower, etc.).
 *
 * Floor/ceiling: 8 KB \u2192 512 KB. Going below 8 KB starves even
 * trivial reads; above 512 KB, single tool calls can still
 * saturate the context alone.
 */
const OUTPUT_MAX_BYTES = Math.min(
  512 * 1024,
  Math.max(
    8 * 1024,
    Number(process.env.KDUST_MCP_TOOL_OUTPUT_MAX_BYTES ?? 48 * 1024),
  ),
);

function truncateForMcp(text: string, kind: string): string {
  // Byte length (UTF-8), not code-point count: Dust counts bytes
  // on the wire. utf-8 byte length \u2260 text.length for non-ASCII.
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= OUTPUT_MAX_BYTES) return text;
  // Keep head + tail, drop the middle. Half budget on each side,
  // minus a small overhead for the marker line itself.
  const half = Math.floor(OUTPUT_MAX_BYTES / 2) - 128;
  const head = Buffer.from(text, 'utf-8').subarray(0, half).toString('utf-8');
  const tail = Buffer.from(text, 'utf-8').subarray(bytes - half).toString('utf-8');
  const marker =
    `\n\n[... ${kind} truncated by KDust: kept ${half}B head + ${half}B tail, ` +
    `original was ${bytes}B. Use offset/limit or narrow your search to get the full data. ...]\n\n`;
  return head + marker + tail;
}

const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
];

/**
 * Tool factory (#15, 2026-04-29). Lets each tool's `execute` arg
 * be inferred from its zod schema instead of typed as `any`. The
 * MCP SDK validates the input against `schema` before calling
 * `execute`, so by the time we get here `args` is statically
 * z.infer<schema>.
 */
function defineTool<S extends z.ZodTypeAny>(t: {
  name: string;
  description: string;
  schema: S;
  execute(
    root: string,
    args: z.infer<S>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}) {
  return t;
}

// ---------------- read_file ----------------
export const readFile = defineTool({
  name: 'read_file',
  description:
    "Reads a file from the project workspace and returns its contents. Supports text files. " +
    "Optionally reads only a range of lines via offset and limit.",
  schema: z.object({
    path: z.string().describe('Absolute path to the file (must be under the project root).'),
    offset: z.number().int().min(0).optional().describe('0-indexed line number to start from.'),
    limit: z.number().int().positive().optional().describe('Max number of lines to read.'),
  }),
  async execute(root, args) {
    try {
      const abs = chroot(root, args.path);
      const buf = await fsp.readFile(abs, 'utf-8');
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = buf.split('\n');
        const start = args.offset ?? 0;
        const end = args.limit ? Math.min(lines.length, start + args.limit) : lines.length;
        // Still truncate: a paginated read can still exceed the
        // byte budget if a single line is huge (minified js, etc).
        return toText(truncateForMcp(lines.slice(start, end).join('\n'), 'read_file'));
      }
      return toText(truncateForMcp(buf, 'read_file'));
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }
  },
});

// ---------------- edit_file ----------------
export const editFile = defineTool({
  name: 'edit_file',
  description:
    "Replace text in a file. `old_string` must uniquely identify the target (include 3+ lines of context). " +
    "Use expected_replacements to update multiple identical occurrences.",
  schema: z.object({
    path: z.string().describe('Absolute path to the file (must be under the project root).'),
    old_string: z.string().describe('Exact text to find.'),
    new_string: z.string().describe('Text to replace it with.'),
    expected_replacements: z.number().int().positive().optional(),
  }),
  async execute(root, args) {
    try {
      const abs = chroot(root, args.path);
      if (!existsSync(abs)) return toText(`Error: File not found: ${abs}`, true);
      const original = await fsp.readFile(abs, 'utf-8');
      const escaped = args.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      const count = (original.match(re) ?? []).length;
      const expected = args.expected_replacements ?? 1;
      if (count === 0) return toText(`Error: old_string not found`, true);
      if (count !== expected)
        return toText(`Error: expected ${expected} replacements, found ${count}`, true);
      const updated = original.replace(re, args.new_string);
      await fsp.writeFile(abs, updated, 'utf-8');
      return toText(`Replaced ${count} occurrence(s) in ${abs}`);
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }
  },
});

// ---------------- search_files ----------------
export const searchFiles = defineTool({
  name: 'search_files',
  description: 'List files matching a glob pattern under the project root.',
  schema: z.object({
    pattern: z.string().describe("Glob pattern, e.g. '**/*.ts'."),
    directory: z.string().optional().describe('Absolute subdirectory to search in.'),
    case_sensitive: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    sort_by_modified: z.boolean().optional(),
  }),
  async execute(root, args) {
    try {
      const cwd = chroot(root, args.directory);
      const files = await glob(args.pattern, {
        cwd,
        nocase: !args.case_sensitive,
        ignore: IGNORE,
        nodir: true,
      });
      if (files.length === 0) return toText(`No files found for: ${args.pattern}`);

      const results = files.map((f) => ({
        rel: f,
        abs: path.resolve(cwd, f),
        mtime: 0,
      }));
      if (args.sort_by_modified) {
        for (const r of results) {
          try { r.mtime = statSync(r.abs).mtimeMs; } catch { /* ignore */ }
        }
        results.sort((a, b) => b.mtime - a.mtime);
      }
      const limit = args.limit ?? 100;
      const shown = results.slice(0, limit).map((r) => r.rel).join('\n');
      return toText(
        `Found ${results.length} file(s) matching ${args.pattern}${
          results.length > limit ? ` (showing first ${limit})` : ''
        }:\n${shown}`,
      );
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }
  },
});

// ---------------- search_content ----------------
export const searchContent = defineTool({
  name: 'search_content',
  description: 'Search for a string inside files using grep (fixed-string mode).',
  schema: z.object({
    pattern: z.string().describe('The text to search for.'),
    path: z.string().optional().describe('Absolute directory to search in.'),
    file_pattern: z.string().optional().describe("glob file pattern, e.g. '*.ts'"),
  }),
  async execute(root, args) {
    try {
      const cwd = chroot(root, args.path);
      const pattern = args.pattern;
      const filePattern = args.file_pattern ?? '*';
      const { stdout } = await pExecFile(
        'grep',
        [
          '-rni',
          '--binary-files=without-match',
          '--exclude-dir=node_modules',
          '--exclude-dir=.git',
          '--exclude-dir=dist',
          '--exclude-dir=.next',
          '--include=' + filePattern,
          '-F',
          pattern,
          cwd,
        ],
        { maxBuffer: 5 * 1024 * 1024 },
      ).catch((err) => ({ stdout: err.stdout ?? '' }));
      const out = (stdout as string).trim();
      if (!out) return toText(`No matches found for: ${pattern}`);
      const lines = out.split('\n').slice(0, 500);
      // Extra byte-cap on top of the 500-line cap: long matched
      // lines (e.g. minified assets) can still blow the budget.
      return toText(
        truncateForMcp(
          `Found ${lines.length} matches for "${pattern}" in the following files:\n\n${lines.join('\n')}`,
          'search_content',
        ),
      );
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }
  },
});

// ---------------- run_command ----------------
export const runCommand = defineTool({
  name: 'run_command',
  description:
    'Execute a shell command inside the project workspace. Returns exit code, stdout and stderr.',
  schema: z.object({
    command: z.string().describe('Base command, e.g. git, npm, node, ls.'),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional().describe('Working dir (must be under project root).'),
    timeout: z.number().int().positive().optional(),
  }),
  async execute(root, args) {
    try {
      const cwd = chroot(root, args.cwd);
      const timeout = args.timeout ?? 30000;
      const { stdout, stderr } = await pExecFile(args.command, args.args ?? [], {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      }).catch((err: NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: NodeJS.Signals;
        killed?: boolean;
      }) => {
        // Build a structured failure tail so the agent can tell
        // apart:
        //   - normal non-zero exit:    "code=2 signal=none"
        //   - SIGTERM from `timeout`:  "code=null signal=SIGTERM
        //                              killed=true (timeout=30000ms)"
        //     This is the case that historically rendered as the
        //     opaque "exit code unknown" and burned step budgets
        //     on phantom "binary is broken" hypotheses (cf.
        //     ADR-0019 / TaskRun cmpbmnidi0012gsyoxwtv0l4d).
        //   - spawn failure (ENOENT): err.code is a string like
        //     'ENOENT'; we surface it verbatim instead of casting
        //     it through `?? 'unknown'`.
        // Franck 2026-05-18.
        const isTimeoutKill = err.killed === true && err.signal === 'SIGTERM';
        const parts: string[] = [];
        parts.push(`code=${err.code === undefined ? 'null' : String(err.code)}`);
        parts.push(`signal=${err.signal ?? 'none'}`);
        if (err.killed) parts.push(`killed=true`);
        if (isTimeoutKill) parts.push(`(timeout=${timeout}ms)`);
        return {
          stdout: err.stdout ?? '',
          stderr:
            (err.stderr ?? '') +
            `\n\nError: Command failed (${parts.join(' ')})`,
        };
      });
      // Truncate stdout/stderr INDEPENDENTLY so a 2 MB stdout
      // doesn't wipe out the stderr tail the agent needs to see
      // the actual error message. Each stream gets its own head/
      // tail split.
      return toText(
        `Command: ${args.command} ${(args.args ?? []).join(' ')}\nCwd: ${cwd}\n\n` +
          `STDOUT:\n${truncateForMcp(String(stdout ?? ''), 'stdout')}\n\n` +
          `STDERR:\n${truncateForMcp(String(stderr ?? ''), 'stderr')}`,
      );
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }
  },
});

// ---------------- export_fil_to_workdir ----------------
/**
 * Bridge a Dust conversation file (`fil_*`) onto the local FS the
 * skill runner can read (Franck 2026-05-19).
 *
 * Background: when an MCP tool result exceeds Dust's inline cap,
 * Dust's built-in `files` MCP server spills the payload into a
 * conversation file (`fil_*`). The `files__cat` / `files__resolve`
 * tools surface a scoped path (e.g. `conversation/foo.json`) that
 * lives in Dust's own storage backend — NOT on the kdust container
 * FS — so `run_skill_script` cannot `open()` it. Without this
 * bridge, agents either had to chunk-read through `files__cat`
 * (slow, lossy, forbidden by the prompt) or give up.
 *
 * This tool downloads the file via the same authenticated SDK path
 * used by `/api/files/[sId]` and writes it to an allow-listed
 * location on disk. The skill scripts (`save.sh --from-file …`)
 * then consume the path as if it had been produced locally.
 *
 * Allow-list (mirrors `_save_helper.py`'s allow-list):
 *   - `/tmp/thruk-report/**`     (kdust/thruk-monitoring-report skill workdir)
 *   - `/tmp/kdust-fil-cache/**`  (generic per-run scratch space)
 *   - Anywhere under the project root (the fs-cli server is
 *     project-scoped; staying inside that root keeps writes
 *     auditable per project).
 *
 * Path-traversal guard: `..` segments are resolved before the
 * allow-list check; symlinks are NOT followed for the destination
 * directory check (we only `mkdir -p` the parent).
 */
const FIL_CACHE_ROOTS = [
  '/tmp/thruk-report',
  '/tmp/kdust-fil-cache',
];

function isUnderAllowedRoot(absDest: string, projectRoot: string): boolean {
  const normRoots = [
    ...FIL_CACHE_ROOTS.map((r) => path.resolve(r)),
    path.resolve(projectRoot),
  ];
  return normRoots.some(
    (r) => absDest === r || absDest.startsWith(r + path.sep),
  );
}

export const exportFilToWorkdir = defineTool({
  name: 'export_fil_to_workdir',
  description:
    'Download a Dust conversation file (fil_*) and write its bytes ' +
    'to a path the skill runner can read. Use this when an MCP tool ' +
    'result was spilled to a `fil_*` reference and the next step ' +
    'needs to feed it to a script (e.g. `save.sh --from-file`). ' +
    'Destination must be under /tmp/thruk-report/, /tmp/kdust-fil-cache/, ' +
    'or the project root.',
  schema: z.object({
    file_id: z
      .string()
      .regex(/^fil_[A-Za-z0-9_-]+$/, 'must match /^fil_[A-Za-z0-9_-]+$/')
      .describe('Dust file id, e.g. fil_abc123def.'),
    dest_path: z
      .string()
      .describe(
        'Absolute destination path on the kdust container FS. ' +
          'Allowed roots: /tmp/thruk-report/, /tmp/kdust-fil-cache/, project root.',
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe('If true, replace any existing file at dest_path. Default false.'),
  }),
  async execute(root, args) {
    try {
      // 1. Resolve + allow-list the destination.
      if (!path.isAbsolute(args.dest_path)) {
        return toText(
          `Error: dest_path must be absolute (got ${args.dest_path})`,
          true,
        );
      }
      const absDest = path.resolve(args.dest_path);
      if (!isUnderAllowedRoot(absDest, root)) {
        return toText(
          `Error: dest_path ${absDest} is outside allowed roots ` +
            `(${FIL_CACHE_ROOTS.join(', ')}, ${path.resolve(root)})`,
          true,
        );
      }
      if (existsSync(absDest) && !args.overwrite) {
        return toText(
          `Error: ${absDest} already exists (pass overwrite=true to replace)`,
          true,
        );
      }
      await fsp.mkdir(path.dirname(absDest), { recursive: true });

      // 2. Resolve the active Dust client (token-rotation handled by
      //    the async apiKey callable; getDustClient() is cheap to
      //    re-call per request).
      const dust = await getDustClient();
      if (!dust) {
        return toText('Error: Dust client not available (login required)', true);
      }

      // 3. Fetch + stream-to-disk while computing the sha256.
      let body: Awaited<ReturnType<typeof fetchFilBody>>;
      try {
        body = await fetchFilBody(dust.client, args.file_id);
      } catch (e: unknown) {
        const fe = e as FilFetchError;
        return toText(
          `Error: failed to fetch ${args.file_id}: ` +
            `${fe.kind === 'http' ? `HTTP ${fe.status ?? '?'} ` : ''}${fe.message}`,
          true,
        );
      }

      const hash = createHash('sha256');
      let bytes = 0;
      if (typeof body.body === 'string') {
        // Dust occasionally hands us an already-buffered string
        // (small files, non-streamable endpoints). Write directly.
        const buf = Buffer.from(body.body, 'utf-8');
        hash.update(buf);
        bytes = buf.byteLength;
        await fsp.writeFile(absDest, buf);
      } else {
        // True stream: pipe to disk while teeing through the hash.
        const nodeStream = Readable.fromWeb(
          body.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
        );
        nodeStream.on('data', (chunk: Buffer | string) => {
          const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          hash.update(b);
          bytes += b.byteLength;
        });
        await pipeline(nodeStream, createWriteStream(absDest));
      }

      // 4. Structured success line — keep it short, the agent
      //    typically just needs `path` to feed the next step.
      const sha256 = hash.digest('hex');
      return toText(
        `OK: wrote ${bytes} bytes to ${absDest}\n` +
          `content_type=${body.contentType}\n` +
          `sha256=${sha256}\n` +
          `file_id=${args.file_id}`,
      );
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }
  },
});

// ---------------- create_file ----------------
export const createFile = defineTool({
  name: 'create_file',
  description:
    'Create a NEW file under the project root with the given content. ' +
    'Parent directories are created as needed. Refuses to clobber an ' +
    'existing file unless overwrite=true. Use edit_file/apply_patch to ' +
    'modify an existing file.',
  schema: z.object({
    path: z.string().describe('Absolute path to the new file (must be under the project root).'),
    content: z.string().describe('Full UTF-8 content to write.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('If true, replace an existing file. Default false (fail if it exists).'),
  }),
  async execute(root, args) {
    try {
      const abs = chroot(root, args.path);
      if (existsSync(abs)) {
        if (statSync(abs).isDirectory()) {
          return toText(`Error: path is a directory: ${abs}`, true);
        }
        if (!args.overwrite) {
          return toText(
            `Error: file already exists: ${abs} (pass overwrite=true to replace)`,
            true,
          );
        }
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, args.content, 'utf-8');
      return toText(
        `${existsSync(abs) ? 'Wrote' : 'Created'} ${abs} (${Buffer.byteLength(args.content, 'utf-8')} bytes)`,
      );
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }
  },
});

// ---------------- apply_patch ----------------
/**
 * Atomic, multi-file structured edit (Franck 2026-06-02). Accepts a
 * Claude-Code / Codex-style `*** Begin Patch` envelope (see
 * apply-patch.ts for the grammar). The whole patch is validated and
 * applied IN MEMORY first; only when every op succeeds do we touch
 * the disk. If a write fails mid-batch we restore everything already
 * written so the tree never lands in a half-applied state.
 */
interface PlannedWrite {
  abs: string;
  /** null => delete the file. */
  next: string | null;
  /** Previous on-disk content for rollback (undefined => did not exist). */
  prev: string | undefined;
  label: string;
}

export const applyPatch = defineTool({
  name: 'apply_patch',
  description:
    'Apply a multi-file, multi-hunk patch atomically (all-or-nothing). ' +
    'Input is a "*** Begin Patch / *** End Patch" envelope supporting ' +
    '"*** Add File:", "*** Update File:" (with @@ hunks of " " context, ' +
    '"-" removed, "+" added lines), "*** Delete File:" and an optional ' +
    '"*** Move to:". Prefer this over many edit_file calls for coherent ' +
    'changes. The patch is validated in memory and only written if every ' +
    'hunk applies cleanly.',
  schema: z.object({
    patch: z.string().describe('The full apply_patch envelope.'),
  }),
  async execute(root, args) {
    let ops: PatchOp[];
    try {
      ops = parsePatch(args.patch);
    } catch (e: unknown) {
      const msg = e instanceof PatchError ? e.message : errMessage(e);
      return toText(`Error: malformed patch: ${msg}`, true);
    }

    // Phase 1 — plan every write in memory; never touch disk yet.
    const plan: PlannedWrite[] = [];
    try {
      for (const op of ops) {
        if (op.kind === 'add') {
          const abs = chroot(root, op.path);
          if (existsSync(abs)) {
            return toText(
              `Error: Add File "${op.path}": already exists. Use Update File or create_file(overwrite=true).`,
              true,
            );
          }
          plan.push({ abs, next: op.contents, prev: undefined, label: `add ${op.path}` });
        } else if (op.kind === 'delete') {
          const abs = chroot(root, op.path);
          if (!existsSync(abs)) {
            return toText(`Error: Delete File "${op.path}": not found.`, true);
          }
          const prev = await fsp.readFile(abs, 'utf-8');
          plan.push({ abs, next: null, prev, label: `delete ${op.path}` });
        } else {
          // update
          const abs = chroot(root, op.path);
          if (!existsSync(abs)) {
            return toText(`Error: Update File "${op.path}": not found.`, true);
          }
          const prev = await fsp.readFile(abs, 'utf-8');
          let updated: string;
          try {
            updated = applyHunksToContent(prev, op.hunks);
          } catch (e: unknown) {
            const msg = e instanceof PatchError ? e.message : errMessage(e);
            return toText(`Error: Update File "${op.path}": ${msg}`, true);
          }
          if (op.moveTo) {
            const dest = chroot(root, op.moveTo);
            if (existsSync(dest)) {
              return toText(
                `Error: Update File "${op.path}": Move to "${op.moveTo}" already exists.`,
                true,
              );
            }
            // Delete the source, write the moved+updated content at dest.
            plan.push({ abs, next: null, prev, label: `move-from ${op.path}` });
            plan.push({ abs: dest, next: updated, prev: undefined, label: `move-to ${op.moveTo}` });
          } else {
            plan.push({ abs, next: updated, prev, label: `update ${op.path}` });
          }
        }
      }
    } catch (e: unknown) {
      return toText(`Error: ${errMessage(e)}`, true);
    }

    // Phase 2 — commit. Track what we changed for rollback on failure.
    const done: PlannedWrite[] = [];
    try {
      for (const w of plan) {
        if (w.next === null) {
          await fsp.rm(w.abs, { force: true });
        } else {
          await fsp.mkdir(path.dirname(w.abs), { recursive: true });
          await fsp.writeFile(w.abs, w.next, 'utf-8');
        }
        done.push(w);
      }
    } catch (e: unknown) {
      // Roll back in reverse order.
      for (const w of done.reverse()) {
        try {
          if (w.prev === undefined) {
            await fsp.rm(w.abs, { force: true });
          } else {
            await fsp.mkdir(path.dirname(w.abs), { recursive: true });
            await fsp.writeFile(w.abs, w.prev, 'utf-8');
          }
        } catch {
          /* best-effort rollback */
        }
      }
      return toText(
        `Error: write failed, patch rolled back: ${errMessage(e)}`,
        true,
      );
    }

    return toText(
      `Applied patch: ${plan.length} file operation(s)\n` +
        plan.map((w) => `  - ${w.label}`).join('\n'),
    );
  },
});

export const allFsTools = [
  readFile,
  editFile,
  createFile,
  applyPatch,
  searchFiles,
  searchContent,
  runCommand,
  exportFilToWorkdir,
];
