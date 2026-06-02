/**
 * Unit tests for the apply_patch envelope parser + applier.
 *
 * Pure module (no FS, no SDK) — exercises the parsing contract and the
 * strict contiguous-block hunk matcher that the apply_patch MCP tool
 * relies on for atomic, deterministic edits.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePatch,
  applyHunksToContent,
  PatchError,
  type PatchOp,
} from '@/lib/mcp/apply-patch';

function onlyUpdate(ops: PatchOp[]) {
  const op = ops[0];
  if (op.kind !== 'update') throw new Error('expected update op');
  return op;
}

describe('parsePatch', () => {
  it('parses an Add File op with content', () => {
    const ops = parsePatch(
      ['*** Begin Patch', '*** Add File: a/b.txt', '+hello', '+world', '*** End Patch'].join('\n'),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ kind: 'add', path: 'a/b.txt', contents: 'hello\nworld' });
  });

  it('parses a Delete File op', () => {
    const ops = parsePatch(['*** Begin Patch', '*** Delete File: gone.txt', '*** End Patch'].join('\n'));
    expect(ops[0]).toEqual({ kind: 'delete', path: 'gone.txt' });
  });

  it('parses an Update File op with a Move to and hunks', () => {
    const ops = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: old.ts',
        '*** Move to: new.ts',
        '@@ ctx',
        ' keep',
        '-drop',
        '+add',
        '*** End Patch',
      ].join('\n'),
    );
    const op = onlyUpdate(ops);
    expect(op.path).toBe('old.ts');
    expect(op.moveTo).toBe('new.ts');
    expect(op.hunks).toHaveLength(1);
    expect(op.hunks[0].lines).toEqual([
      { op: ' ', text: 'keep' },
      { op: '-', text: 'drop' },
      { op: '+', text: 'add' },
    ]);
  });

  it('tolerates CRLF and surrounding blank lines', () => {
    const ops = parsePatch('\r\n*** Begin Patch\r\n*** Delete File: x\r\n*** End Patch\r\n');
    expect(ops[0]).toEqual({ kind: 'delete', path: 'x' });
  });

  it('rejects a patch without Begin', () => {
    expect(() => parsePatch('*** Add File: x\n+y\n*** End Patch')).toThrow(PatchError);
  });

  it('rejects a patch without End', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Delete File: x')).toThrow(PatchError);
  });

  it('rejects an Add File body line not starting with +', () => {
    expect(() =>
      parsePatch(['*** Begin Patch', '*** Add File: x', 'oops', '*** End Patch'].join('\n')),
    ).toThrow(PatchError);
  });

  it('rejects an empty patch', () => {
    expect(() => parsePatch(['*** Begin Patch', '*** End Patch'].join('\n'))).toThrow(PatchError);
  });
});

describe('applyHunksToContent', () => {
  it('applies a simple replacement', () => {
    const original = 'line1\nline2\nline3';
    const op = onlyUpdate(
      parsePatch(
        ['*** Begin Patch', '*** Update File: f', '@@', ' line1', '-line2', '+LINE2', ' line3', '*** End Patch'].join('\n'),
      ),
    );
    expect(applyHunksToContent(original, op.hunks)).toBe('line1\nLINE2\nline3');
  });

  it('applies a pure insertion anchored on context', () => {
    const original = 'a\nb';
    const op = onlyUpdate(
      parsePatch(['*** Begin Patch', '*** Update File: f', '@@', ' a', '+inserted', ' b', '*** End Patch'].join('\n')),
    );
    expect(applyHunksToContent(original, op.hunks)).toBe('a\ninserted\nb');
  });

  it('applies multiple hunks left-to-right', () => {
    const original = 'one\ntwo\nthree\nfour\nfive';
    const op = onlyUpdate(
      parsePatch(
        [
          '*** Begin Patch',
          '*** Update File: f',
          '@@',
          '-one',
          '+ONE',
          '@@',
          '-five',
          '+FIVE',
          '*** End Patch',
        ].join('\n'),
      ),
    );
    expect(applyHunksToContent(original, op.hunks)).toBe('ONE\ntwo\nthree\nfour\nFIVE');
  });

  it('throws when context does not match (stale)', () => {
    const original = 'a\nb\nc';
    const op = onlyUpdate(
      parsePatch(['*** Begin Patch', '*** Update File: f', '@@', ' x', '-y', '*** End Patch'].join('\n')),
    );
    expect(() => applyHunksToContent(original, op.hunks)).toThrow(PatchError);
  });

  it('inserts into an empty file via a no-anchor hunk', () => {
    const op = onlyUpdate(
      parsePatch(['*** Begin Patch', '*** Update File: f', '@@', '+first', '+second', '*** End Patch'].join('\n')),
    );
    expect(applyHunksToContent('', op.hunks)).toBe('first\nsecond');
  });
});

describe('applyHunksToContent — curly-quote normalization (#175 item 2)', () => {
  const LDQ = '\u201C';
  const RDQ = '\u201D';

  it('matches a straight-quote hunk against a curly-quote file', () => {
    const original = `const s = ${LDQ}hi${RDQ};`;
    const op = onlyUpdate(
      parsePatch(
        [
          '*** Begin Patch',
          '*** Update File: f',
          '@@',
          '-const s = "hi";',
          '+const s = "bye";',
          '*** End Patch',
        ].join('\n'),
      ),
    );
    // '+' line typography is re-curled to match the file's style.
    expect(applyHunksToContent(original, op.hunks)).toBe(`const s = ${LDQ}bye${RDQ};`);
  });

  it('keeps untouched context lines verbatim (no typography rewrite)', () => {
    const original = `head ${LDQ}keep${RDQ}\ntarget\ntail`;
    const op = onlyUpdate(
      parsePatch(
        [
          '*** Begin Patch',
          '*** Update File: f',
          '@@',
          ' head "keep"',
          '-target',
          '+TARGET',
          ' tail',
          '*** End Patch',
        ].join('\n'),
      ),
    );
    // The context line is emitted from the file, so its curly quotes survive.
    expect(applyHunksToContent(original, op.hunks)).toBe(`head ${LDQ}keep${RDQ}\nTARGET\ntail`);
  });

  it('exact match still wins and leaves output byte-identical', () => {
    const original = `a\nb\nc`;
    const op = onlyUpdate(
      parsePatch(['*** Begin Patch', '*** Update File: f', '@@', ' a', '-b', '+B', ' c', '*** End Patch'].join('\n')),
    );
    expect(applyHunksToContent(original, op.hunks)).toBe('a\nB\nc');
  });
});
