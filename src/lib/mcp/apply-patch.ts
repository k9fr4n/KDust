/**
 * apply_patch envelope parser + in-memory applier (Franck 2026-06-02).
 *
 * Implements the Claude-Code / Codex-style `*** Begin Patch` envelope
 * so a Dust agent can express a multi-file, multi-hunk edit as ONE
 * structured payload instead of N sequential `edit_file` calls.
 *
 * This module is PURE: it never touches the filesystem. `parsePatch`
 * turns the envelope text into typed ops; `applyHunksToContent` and
 * `applyOpsToFiles` operate on in-memory strings. The FS orchestration
 * (chroot, read, atomic write + rollback) lives in fs-tools.ts so the
 * parsing/matching logic stays trivially unit-testable under Vitest.
 *
 * Envelope grammar (line-oriented, LF-normalised):
 *
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +<line>            (every body line of an Add MUST start with '+')
 *   *** Delete File: <path>
 *   *** Update File: <path>
 *   *** Move to: <path> (optional, must immediately follow Update File)
 *   @@ <optional context hint>
 *    <context line>     (leading space)
 *   -<removed line>
 *   +<added line>
 *   *** End Patch
 *
 * Hunk matching for Update File is intentionally STRICT and
 * deterministic: each hunk's (context + removed) lines must appear as
 * a contiguous block in the current file, searched forward from the
 * previous hunk's end. The ONLY tolerated fuzziness is curly⇄straight
 * quote equivalence (#175 item 2): an exact line-equality scan runs
 * first, and only if it fails does a quote-normalized scan run as a
 * fallback (opt-out via KDUST_FS_QUOTE_NORMALIZE=0). There is NO
 * whitespace-drift or offset matching — if the agent's context is
 * otherwise stale, the patch is rejected wholesale rather than
 * applied to the wrong location.
 */

import { normalizeQuotes, preserveQuoteStyle, quoteNormalizeEnabled } from './quote-normalize';

export type PatchLineOp = ' ' | '-' | '+';

export interface PatchLine {
  op: PatchLineOp;
  text: string;
}

export interface Hunk {
  lines: PatchLine[];
}

export type PatchOp =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] };

/** Thrown for any malformed envelope or unappliable hunk. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';

function isMarker(line: string): boolean {
  return line.startsWith('*** ');
}

/**
 * Parse an apply_patch envelope into typed ops. Throws PatchError on
 * any structural problem. Accepts CRLF and a trailing newline.
 */
export function parsePatch(patch: string): PatchOp[] {
  const raw = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');

  // Locate Begin/End, tolerating leading/trailing blank lines.
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (lines[start] !== BEGIN) {
    throw new PatchError(`patch must start with "${BEGIN}"`);
  }
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (lines[end] !== END) {
    throw new PatchError(`patch must end with "${END}"`);
  }

  const body = lines.slice(start + 1, end);
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < body.length) {
    const line = body[i];
    if (line.startsWith(ADD)) {
      const filePath = line.slice(ADD.length).trim();
      if (!filePath) throw new PatchError('Add File: empty path');
      i++;
      const contentLines: string[] = [];
      while (i < body.length && !isMarker(body[i])) {
        const l = body[i];
        if (l.length > 0 && l[0] !== '+') {
          throw new PatchError(
            `Add File "${filePath}": every content line must start with '+' (got: ${JSON.stringify(l.slice(0, 40))})`,
          );
        }
        contentLines.push(l.length > 0 ? l.slice(1) : '');
        i++;
      }
      ops.push({ kind: 'add', path: filePath, contents: contentLines.join('\n') });
      continue;
    }

    if (line.startsWith(DELETE)) {
      const filePath = line.slice(DELETE.length).trim();
      if (!filePath) throw new PatchError('Delete File: empty path');
      i++;
      ops.push({ kind: 'delete', path: filePath });
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const filePath = line.slice(UPDATE.length).trim();
      if (!filePath) throw new PatchError('Update File: empty path');
      i++;
      let moveTo: string | undefined;
      if (i < body.length && body[i].startsWith(MOVE)) {
        moveTo = body[i].slice(MOVE.length).trim();
        if (!moveTo) throw new PatchError(`Update File "${filePath}": Move to: empty path`);
        i++;
      }
      const hunks: Hunk[] = [];
      let current: PatchLine[] | null = null;
      const flush = () => {
        if (current && current.length > 0) hunks.push({ lines: current });
        current = null;
      };
      while (i < body.length && !isMarker(body[i])) {
        const l = body[i];
        if (l.startsWith('@@')) {
          flush();
          current = [];
          i++;
          continue;
        }
        if (current === null) current = [];
        if (l.length === 0) {
          // Blank line == empty context line.
          current.push({ op: ' ', text: '' });
        } else {
          const c = l[0];
          if (c === ' ' || c === '-' || c === '+') {
            current.push({ op: c as PatchLineOp, text: l.slice(1) });
          } else {
            throw new PatchError(
              `Update File "${filePath}": hunk line must start with ' ', '-' or '+' (got: ${JSON.stringify(l.slice(0, 40))})`,
            );
          }
        }
        i++;
      }
      flush();
      if (hunks.length === 0) {
        throw new PatchError(`Update File "${filePath}": no hunks`);
      }
      ops.push({ kind: 'update', path: filePath, moveTo, hunks });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }
    throw new PatchError(`unexpected line outside a section: ${JSON.stringify(line.slice(0, 60))}`);
  }

  if (ops.length === 0) throw new PatchError('patch contains no operations');
  return ops;
}

/**
 * Apply a list of hunks to `original`, returning the new content.
 * Throws PatchError if any hunk's context+removed block is not found
 * contiguously, searching forward from the previous hunk's position.
 */
export function applyHunksToContent(original: string, hunks: Hunk[]): string {
  const origLines = original.split('\n');
  let cursor = 0;
  const out: string[] = [];

  for (let h = 0; h < hunks.length; h++) {
    const lines = hunks[h].lines;
    const search = lines.filter((l) => l.op === ' ' || l.op === '-').map((l) => l.text);

    if (search.length === 0) {
      // Pure insertion with no anchor: only valid for an empty file.
      const replace = lines.filter((l) => l.op === ' ' || l.op === '+').map((l) => l.text);
      if (origLines.length === 1 && origLines[0] === '' && cursor === 0) {
        out.push(...replace);
        cursor = origLines.length;
        continue;
      }
      throw new PatchError(
        `hunk #${h + 1} has no context or removed lines to anchor on (need at least one ' ' or '-' line)`,
      );
    }

    const at = findBlock(origLines, search, cursor);
    if (at === -1) {
      throw new PatchError(
        `hunk #${h + 1} did not match the file content (stale context?). Expected to find:\n${search.join('\n')}`,
      );
    }
    // Carry over untouched lines between the cursor and the match.
    out.push(...origLines.slice(cursor, at));

    // The matched file region carries the file's REAL typography (which may
    // differ from the patch's straight quotes when the block matched via
    // quote normalization). Emit context lines from the file itself, and
    // re-apply the file's curly-quote style to '+' added lines so the edit
    // doesn't silently rewrite typography it never meant to touch.
    const matched = origLines.slice(at, at + search.length);
    const searchText = search.join('\n');
    const actualText = matched.join('\n');
    const normalized = searchText !== actualText;
    let m = 0; // pointer into the matched file region (consumed by ' ' and '-')
    for (const l of lines) {
      if (l.op === ' ') {
        out.push(matched[m]);
        m++;
      } else if (l.op === '-') {
        m++;
      } else {
        out.push(normalized ? preserveQuoteStyle(searchText, actualText, l.text) : l.text);
      }
    }
    cursor = at + search.length;
  }
  // Tail after the last hunk.
  out.push(...origLines.slice(cursor));
  return out.join('\n');
}

/**
 * Find `needle` as a contiguous block in `hay` starting at >= from.
 * Runs an EXACT line-equality scan first; only if that finds nothing
 * does it fall back to a curly⇄straight quote-normalized scan
 * (#175 item 2, opt-out via KDUST_FS_QUOTE_NORMALIZE=0). Exact matches
 * therefore always win over normalized ones across the whole array.
 */
function findBlock(hay: string[], needle: string[], from: number): number {
  if (needle.length === 0) return -1;
  const last = hay.length - needle.length;
  const start = Math.max(0, from);

  // Pass 1 — exact equality (unchanged behaviour).
  for (let i = start; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }

  // Pass 2 — curly-quote normalized fallback.
  if (!quoteNormalizeEnabled()) return -1;
  const nNeedle = needle.map(normalizeQuotes);
  for (let i = start; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < nNeedle.length; j++) {
      if (normalizeQuotes(hay[i + j]) !== nNeedle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
