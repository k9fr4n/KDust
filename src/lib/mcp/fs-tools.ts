import { promises as fsp, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { glob } from 'glob';
import { errMessage } from '../errors';

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

      let results = files.map((f) => ({
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
      }).catch((err) => {
        return {
          stdout: err.stdout ?? '',
          stderr:
            (err.stderr ?? '') +
            `\n\nError: Command failed with exit code ${err.code ?? 'unknown'}`,
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

export const allFsTools = [readFile, editFile, searchFiles, searchContent, runCommand];
