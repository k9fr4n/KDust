import { promises as fsp, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { glob } from 'glob';

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

const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
];

// ---------------- read_file ----------------
export const readFile = {
  name: 'read_file',
  description:
    "Reads a file from the project workspace and returns its contents. Supports text files. " +
    "Optionally reads only a range of lines via offset and limit.",
  schema: z.object({
    path: z.string().describe('Absolute path to the file (must be under the project root).'),
    offset: z.number().int().min(0).optional().describe('0-indexed line number to start from.'),
    limit: z.number().int().positive().optional().describe('Max number of lines to read.'),
  }),
  async execute(root: string, args: any) {
    try {
      const abs = chroot(root, args.path);
      const buf = await fsp.readFile(abs, 'utf-8');
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = buf.split('\n');
        const start = args.offset ?? 0;
        const end = args.limit ? Math.min(lines.length, start + args.limit) : lines.length;
        return toText(lines.slice(start, end).join('\n'));
      }
      return toText(buf);
    } catch (e: any) {
      return toText(`Error: ${e.message}`, true);
    }
  },
};

// ---------------- edit_file ----------------
export const editFile = {
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
  async execute(root: string, args: any) {
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
    } catch (e: any) {
      return toText(`Error: ${e.message}`, true);
    }
  },
};

// ---------------- search_files ----------------
export const searchFiles = {
  name: 'search_files',
  description: 'List files matching a glob pattern under the project root.',
  schema: z.object({
    pattern: z.string().describe("Glob pattern, e.g. '**/*.ts'."),
    directory: z.string().optional().describe('Absolute subdirectory to search in.'),
    case_sensitive: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    sort_by_modified: z.boolean().optional(),
  }),
  async execute(root: string, args: any) {
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
    } catch (e: any) {
      return toText(`Error: ${e.message}`, true);
    }
  },
};

// ---------------- search_content ----------------
export const searchContent = {
  name: 'search_content',
  description: 'Search for a string inside files using grep (fixed-string mode).',
  schema: z.object({
    pattern: z.string().describe('The text to search for.'),
    path: z.string().optional().describe('Absolute directory to search in.'),
    file_pattern: z.string().optional().describe("glob file pattern, e.g. '*.ts'"),
  }),
  async execute(root: string, args: any) {
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
      return toText(
        `Found ${lines.length} matches for "${pattern}" in the following files:\n\n${lines.join('\n')}`,
      );
    } catch (e: any) {
      return toText(`Error: ${e.message}`, true);
    }
  },
};

// ---------------- run_command ----------------
export const runCommand = {
  name: 'run_command',
  description:
    'Execute a shell command inside the project workspace. Returns exit code, stdout and stderr.',
  schema: z.object({
    command: z.string().describe('Base command, e.g. git, npm, node, ls.'),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional().describe('Working dir (must be under project root).'),
    timeout: z.number().int().positive().optional(),
  }),
  async execute(root: string, args: any) {
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
      return toText(
        `Command: ${args.command} ${(args.args ?? []).join(' ')}\nCwd: ${cwd}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
      );
    } catch (e: any) {
      return toText(`Error: ${e.message}`, true);
    }
  },
};

export const allFsTools = [readFile, editFile, searchFiles, searchContent, runCommand];
