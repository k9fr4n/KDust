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

/**
 * Read-before-write freshness guard (#175 item 3, ADR-0024, 2026-06-02).
 *
 * Mirrors Claude Code's `readFileState`: read_file records each file's
 * (mtime, size); the write tools refuse to overwrite a file that changed
 * on disk since that recorded read — typically because a linter,
 * formatter or codegen invoked via `run_command` rewrote it between the
 * agent's read and its edit, so the agent's `old_string` / patch context
 * is stale and a write would clobber newer content.
 *
 * KDust-specific scoping (the issue's open question): the fs-cli server
 * is registered PER PROJECT, not per run, and tool callbacks receive only
 * `(root, args)` — there is no runId to key per-run state on. We therefore
 * keep a single process-wide map keyed by ABSOLUTE path (which embeds the
 * project root, so cross-project collisions are impossible). The mtime/size
 * check is content-truthful regardless of which run populated the entry,
 * and per-project automation is already serialised by the project lock, so
 * cross-run interference is limited to interleaved /chat sessions on the
 * same project — an acceptable, documented edge.
 *
 * Deliberate divergence from Claude Code: we enforce ONLY the
 * "modified since read" check, NOT the stricter "refuse if never read"
 * rule. Many existing KDust automations legitimately `apply_patch` or
 * `edit_file` a file they never `read_file` (generated content, blind
 * patches); blocking those would be a breaking behavioural change.
 *
 * Opt-out: KDUST_FS_FRESHNESS_GUARD=0 (process-wide). Default on.
 */
const readFileState = new Map<string, { mtimeMs: number; size: number }>();

function freshnessGuardEnabled(): boolean {
  const v = (process.env.KDUST_FS_FRESHNESS_GUARD ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** Record (or refresh) the on-disk identity of `abs` after a read/write. */
function recordRead(abs: string): void {
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return;
    readFileState.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
  } catch {
    /* file vanished between op and stat — nothing to record */
  }
}

/**
 * Return a structured error string if `abs` changed since its recorded
 * read, else null. No recorded entry => allowed (we don't enforce the
 * never-read rule). Guard disabled via env => always allowed.
 */
function freshnessError(abs: string): string | null {
  if (!freshnessGuardEnabled()) return null;
  const recorded = readFileState.get(abs);
  if (!recorded) return null;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    return null; // file gone; let the tool's own existence check handle it
  }
  if (st.mtimeMs !== recorded.mtimeMs || st.size !== recorded.size) {
    return (
      `File modified since last read: ${abs} ` +
      `(recorded mtime=${Math.round(recorded.mtimeMs)}ms size=${recorded.size}, ` +
      `now mtime=${Math.round(st.mtimeMs)}ms size=${st.size}). ` +
      `Re-read it before writing so your edit is based on the current content. ` +
      `(set KDUST_FS_FRESHNESS_GUARD=0 to disable this guard)`
    );
  }
  return null;
}

// ---------------- read_file ----------------
/**
 * Multimodal read_file (#175 item 4, ADR-0025, 2026-06-02).
 *
 * The fs-cli result wire shape is text-only, so we can't return image
 * vision blocks here (that would need an fs-server content-shape change
 * + a `sharp`-class dependency, deliberately out of scope). What we CAN
 * do cheaply and with real value is:
 *   - extract PDF text via `pdftotext` (poppler-utils, a system binary
 *     like rg — no npm dependency), with optional page ranges;
 *   - detect other binary files (images, archives) and return a short,
 *     honest note instead of dumping raw bytes that pollute the context.
 * Plain-text reads are unchanged.
 */
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico', '.avif', '.heic',
]);

/** Parse a poppler page spec: "3" or "1-5". Returns null if malformed. */
function parsePageRange(spec: string): { first: number; last: number } | null {
  const s = spec.trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 0 ? { first: n, last: n } : null;
  }
  const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    const first = parseInt(m[1], 10);
    const last = parseInt(m[2], 10);
    if (first > 0 && last >= first) return { first, last };
  }
  return null;
}

/** Read up to `n` leading bytes for magic/binary sniffing. */
async function readHead(abs: string, n: number): Promise<Buffer> {
  const fd = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fd.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

export const readFile = defineTool({
  name: 'read_file',
  description:
    "Reads a file from the project workspace. Returns text for text files, " +
    "and extracted text for PDFs (optionally a `pages` range, e.g. '1-5'). " +
    "Optionally reads only a range of lines via offset and limit (text only). " +
    "Binary files (images, archives) return a short descriptor, not raw bytes.",
  schema: z.object({
    path: z.string().describe('Absolute path to the file (must be under the project root).'),
    offset: z.number().int().min(0).optional().describe('0-indexed line number to start from (text only).'),
    limit: z.number().int().positive().optional().describe('Max number of lines to read (text only).'),
    pages: z
      .string()
      .optional()
      .describe("PDF page range, e.g. '3' or '1-5'. Ignored for non-PDF files."),
  }),
  async execute(root, args) {
    try {
      const abs = chroot(root, args.path);
      if (!existsSync(abs)) return toText(`Error: File not found: ${abs}`, true);
      if (statSync(abs).isDirectory()) return toText(`Error: path is a directory: ${abs}`, true);

      const ext = path.extname(abs).toLowerCase();
      const head = await readHead(abs, 8192);
      const isPdf = ext === '.pdf' || head.subarray(0, 5).toString('latin1') === '%PDF-';

      // --- PDF: extract text via poppler `pdftotext` ---
      if (isPdf) {
        const pdfArgs = ['-q', '-enc', 'UTF-8'];
        if (args.pages !== undefined) {
          const range = parsePageRange(args.pages);
          if (!range) {
            return toText(`Error: invalid pages "${args.pages}" (use "3" or "1-5")`, true);
          }
          pdfArgs.push('-f', String(range.first), '-l', String(range.last));
        }
        // `pdftotext [opts] <file> -` writes the extracted text to stdout.
        pdfArgs.push(abs, '-');
        const { stdout, ok, errMsg } = await pExecFile('pdftotext', pdfArgs, {
          maxBuffer: 10 * 1024 * 1024,
        })
          .then((r) => ({ stdout: r.stdout as string, ok: true, errMsg: '' }))
          .catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({
            stdout: err.stdout ?? '',
            ok: false,
            errMsg:
              err.code === 'ENOENT'
                ? 'pdftotext not installed (poppler-utils missing from the image)'
                : (err.stderr ?? errMessage(err)),
          }));
        if (!ok && !stdout) {
          return toText(`Error: PDF text extraction failed: ${errMsg}`, true);
        }
        const text = String(stdout);
        const label = `[PDF text${args.pages ? ` pages ${args.pages}` : ''}: ${abs}]\n\n`;
        const body = text.trim() || '(no extractable text — likely a scanned/image-only PDF)';
        return toText(truncateForMcp(label + body, 'read_file'));
      }

      // --- Other binary (images, archives, ...): don't dump raw bytes ---
      if (head.includes(0)) {
        const size = statSync(abs).size;
        const kind = IMAGE_EXTS.has(ext) ? `image (${ext.slice(1)})` : 'binary';
        return toText(
          `[${kind} file, ${size} bytes: ${abs}] — not text. fs-cli read_file returns ` +
            `text and PDF only; for images, attach the file to the conversation to view it.`,
        );
      }

      // --- Text path (unchanged behaviour) ---
      const buf = await fsp.readFile(abs, 'utf-8');
      // Record on-disk identity for the read-before-write freshness guard.
      recordRead(abs);
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
      const stale = freshnessError(abs);
      if (stale) return toText(`Error: ${stale}`, true);
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
      recordRead(abs); // refresh so our own write doesn't trip the next edit
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
/**
 * ripgrep-backed content search (#175 item 1, 2026-06-02).
 *
 * Re-implemented on top of `rg` (v13, /usr/bin/rg) to reach
 * Claude-Code `GrepTool` parity: regex, context lines, output
 * modes, glob file filter and a total match cap. Backward
 * compatible: the default call is still a case-insensitive,
 * fixed-string substring search (`rg -F -i`) returning
 * `file:line:match` lines, just like the old `grep -rni -F`.
 *
 * Read-only \u2192 AUTO-EXECUTE class. chroot + OUTPUT_MAX_BYTES
 * byte cap are preserved; `head_limit` caps the number of result
 * lines/files BEFORE the byte cap.
 *
 * rg exit codes: 0 = matches, 1 = no match (NOT an error here),
 * 2 = real error (bad regex, unreadable path). We map 1 to the
 * friendly "no matches" message and surface 2's stderr.
 */
export const searchContent = defineTool({
  name: 'search_content',
  description:
    'Search file contents with ripgrep. Default is a case-insensitive fixed-string ' +
    '(substring) search. Set regex=true for a regular-expression pattern, output_mode ' +
    "to switch between matching lines / file names / per-file counts, and context/glob " +
    'to widen or narrow the search.',
  schema: z.object({
    pattern: z.string().describe('The text or regular expression to search for.'),
    path: z.string().optional().describe('Absolute directory (or file) to search in.'),
    // Kept for backward compatibility; `glob` is the preferred name.
    file_pattern: z
      .string()
      .optional()
      .describe("Deprecated alias for `glob`, e.g. '*.ts'. Use `glob`."),
    glob: z
      .string()
      .optional()
      .describe("ripgrep --glob to include/exclude files, e.g. '*.ts' or '!*.test.ts'."),
    regex: z
      .boolean()
      .optional()
      .describe('Treat pattern as a regular expression (default false \u2192 fixed string).'),
    case_insensitive: z
      .boolean()
      .optional()
      .describe('Case-insensitive match (default true, matching the legacy behaviour).'),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe(
        "content (default): matching lines; files_with_matches: file names only; count: per-file match counts.",
      ),
    context: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Lines of context before AND after each match (rg -C). content mode only.'),
    before_context: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Lines of context before each match (rg -B). content mode only.'),
    after_context: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Lines of context after each match (rg -A). content mode only.'),
    type: z
      .string()
      .optional()
      .describe("ripgrep --type filter for standard file types, e.g. 'ts', 'py', 'go'."),
    multiline: z
      .boolean()
      .optional()
      .describe('Enable multiline mode (rg -U --multiline-dotall): . matches newlines, patterns span lines. Implies regex.'),
    head_limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Cap the number of output lines (matches/files/counts) returned.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Skip the first N output lines before applying head_limit (paging).'),
  }),
  async execute(root, args) {
    try {
      const cwd = chroot(root, args.path);
      const pattern = args.pattern;
      const mode = args.output_mode ?? 'content';
      // Legacy behaviour was always case-insensitive (`grep -i`).
      const caseInsensitive = args.case_insensitive ?? true;

      // --max-columns bounds pathological lines (minified/base64) so a
      // single match can't blow the byte budget on its own; the preview
      // flag keeps a usable head of the line instead of dropping it.
      const rgArgs: string[] = ['--color=never', '--max-columns', '500', '--max-columns-preview'];

      // Pattern interpretation. multiline implies regex (no -F).
      if (!args.regex && !args.multiline) rgArgs.push('-F');
      if (caseInsensitive) rgArgs.push('-i');
      if (args.multiline) rgArgs.push('-U', '--multiline-dotall');

      // Exclude the same noise directories the rest of fs-tools ignores.
      // rg honours .gitignore by default, but projects without one would
      // otherwise descend into node_modules/dist/.next.
      for (const dir of ['node_modules', '.git', 'dist', 'build', '.next', 'coverage']) {
        rgArgs.push('--glob', `!**/${dir}/**`);
      }
      // User glob comes AFTER the excludes so an explicit include wins.
      const userGlob = args.glob ?? args.file_pattern;
      if (userGlob) rgArgs.push('--glob', userGlob);
      if (args.type) rgArgs.push('--type', args.type);

      // Output mode.
      if (mode === 'files_with_matches') {
        rgArgs.push('--files-with-matches');
      } else if (mode === 'count') {
        rgArgs.push('--count');
      } else {
        // content: file:line:match, like the old grep -n output.
        rgArgs.push('--no-heading', '--with-filename', '--line-number');
        if (args.context !== undefined) rgArgs.push('-C', String(args.context));
        if (args.before_context !== undefined) rgArgs.push('-B', String(args.before_context));
        if (args.after_context !== undefined) rgArgs.push('-A', String(args.after_context));
      }

      // Pattern terminator so a leading-dash pattern isn't parsed as a flag.
      rgArgs.push('-e', pattern, '--', cwd);

      const { stdout, code, stderr } = await pExecFile('rg', rgArgs, {
        maxBuffer: 10 * 1024 * 1024,
      })
        .then((r) => ({ stdout: r.stdout as string, code: 0, stderr: '' }))
        .catch(
          (err: NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: number | string;
          }) => ({
            stdout: err.stdout ?? '',
            // rg uses exit code 1 for "no match"; anything else is a real error.
            code: typeof err.code === 'number' ? err.code : 2,
            stderr: err.stderr ?? errMessage(err),
          }),
        );

      if (code === 2) {
        return toText(`Error: ripgrep failed: ${stderr.trim() || 'unknown error'}`, true);
      }

      const out = stdout.trim();
      if (!out) return toText(`No matches found for: ${pattern}`);

      const allLines = out.split('\n');
      const total = allLines.length;
      const offset = args.offset ?? 0;
      // head_limit caps the window; default to the legacy 500-line ceiling.
      const limit = args.head_limit ?? 500;
      const lines = allLines.slice(offset, offset + limit);
      const shown = lines.length;
      const capped =
        shown < total ? ` (showing ${shown} of ${total}, offset ${offset})` : '';

      const label =
        mode === 'files_with_matches'
          ? `Files matching "${pattern}"${capped}:`
          : mode === 'count'
          ? `Match counts for "${pattern}"${capped}:`
          : `Found ${lines.length} matching line(s) for "${pattern}"${capped}:`;

      // Extra byte-cap on top of the line cap: long matched lines
      // (e.g. minified assets) can still blow the budget.
      return toText(
        truncateForMcp(`${label}\n\n${lines.join('\n')}`, 'search_content'),
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
      const existed = existsSync(abs);
      if (existed) {
        if (statSync(abs).isDirectory()) {
          return toText(`Error: path is a directory: ${abs}`, true);
        }
        if (!args.overwrite) {
          return toText(
            `Error: file already exists: ${abs} (pass overwrite=true to replace)`,
            true,
          );
        }
        // Overwriting an existing file is a clobber risk → apply the guard.
        const stale = freshnessError(abs);
        if (stale) return toText(`Error: ${stale}`, true);
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, args.content, 'utf-8');
      recordRead(abs); // refresh so the new content is the baseline for later edits
      return toText(
        `${existed ? 'Wrote' : 'Created'} ${abs} (${Buffer.byteLength(args.content, 'utf-8')} bytes)`,
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
          const stale = freshnessError(abs);
          if (stale) return toText(`Error: Delete File "${op.path}": ${stale}`, true);
          const prev = await fsp.readFile(abs, 'utf-8');
          plan.push({ abs, next: null, prev, label: `delete ${op.path}` });
        } else {
          // update
          const abs = chroot(root, op.path);
          if (!existsSync(abs)) {
            return toText(`Error: Update File "${op.path}": not found.`, true);
          }
          const stale = freshnessError(abs);
          if (stale) return toText(`Error: Update File "${op.path}": ${stale}`, true);
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
          readFileState.delete(w.abs); // gone — drop any stale freshness entry
        } else {
          await fsp.mkdir(path.dirname(w.abs), { recursive: true });
          await fsp.writeFile(w.abs, w.next, 'utf-8');
          recordRead(w.abs); // refresh baseline to the just-written content
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
