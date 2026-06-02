/**
 * Curly-quote normalization for fs-cli write tools (#175 item 2, 2026-06-02).
 *
 * Ports Claude Code's `FileEditTool` quote-normalization (findActualString /
 * normalizeQuotes / preserveQuoteStyle) to KDust's `edit_file` and
 * `apply_patch`. Rationale: an LLM cannot reliably emit curly quotes
 * (‘ ’ “ ”), so when a source file contains typographic quotes the
 * model's straight-quote `old_string` / hunk context never matches and
 * the edit is rejected even though it is semantically correct.
 *
 * This module is PURE (no fs, no I/O) so it stays trivially unit-testable
 * alongside apply-patch.ts. The matching is a deliberately NARROW fuzzy
 * pass: ONLY curly⇄straight quote equivalence. It is NOT whitespace-drift
 * or offset-tolerant matching — stale context is still rejected wholesale.
 *
 * Length invariant: every curly quote is a single UTF-16 code unit mapped
 * to a single straight-quote code unit, so `normalizeQuotes` preserves both
 * `.length` and every character index. That lets us locate a match in the
 * normalized string and slice the ORIGINAL (typography-preserving) text at
 * the very same indices.
 *
 * Opt-out: KDUST_FS_QUOTE_NORMALIZE=0 (process-wide). Default on.
 */

// Claude can't output curly quotes, so we define them as constants. We
// normalize curly quotes to straight quotes when matching edits.
export const LEFT_SINGLE_CURLY_QUOTE = '\u2018'; // ‘
export const RIGHT_SINGLE_CURLY_QUOTE = '\u2019'; // ’
export const LEFT_DOUBLE_CURLY_QUOTE = '\u201C'; // “
export const RIGHT_DOUBLE_CURLY_QUOTE = '\u201D'; // ”

/** Process-wide opt-out for the quote-normalization fuzzy fallback. */
export function quoteNormalizeEnabled(): boolean {
  const v = (process.env.KDUST_FS_QUOTE_NORMALIZE ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/**
 * Replace every curly quote with its straight ASCII equivalent.
 * 1:1 char map ⇒ preserves string length and every index.
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/** True if `str` contains any curly quote. */
export function hasCurlyQuotes(str: string): boolean {
  return (
    str.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    str.includes(RIGHT_SINGLE_CURLY_QUOTE) ||
    str.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    str.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  );
}

/**
 * Find the start indices of every NON-OVERLAPPING occurrence of
 * `searchString` inside `fileContent`, comparing under quote
 * normalization. Indices are valid against the ORIGINAL `fileContent`
 * (normalization is length-preserving).
 *
 * Returns [] when `searchString` is empty or has no normalized match.
 */
export function findNormalizedMatchIndices(
  fileContent: string,
  searchString: string,
): number[] {
  if (searchString.length === 0) return [];
  const haystack = normalizeQuotes(fileContent);
  const needle = normalizeQuotes(searchString);
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length; // non-overlapping, mirrors String.replaceAll
  }
  return out;
}

/**
 * Return the actual substring of `fileContent` that matches `searchString`
 * accounting for quote normalization, or null if not found. Mirrors Claude
 * Code's `findActualString`: exact match first, then a single normalized
 * match (the first one).
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const idxs = findNormalizedMatchIndices(fileContent, searchString);
  if (idxs.length === 0) return null;
  return fileContent.substring(idxs[0], idxs[0] + searchString.length);
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' || // em dash
    prev === '\u2013' // en dash
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE,
      );
    } else {
      result.push(chars[i]);
    }
  }
  return result.join('');
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // Don't convert apostrophes in contractions (e.g. "don't", "it's"):
      // an apostrophe between two letters is a contraction, not a quote.
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(
          isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE,
        );
      }
    } else {
      result.push(chars[i]);
    }
  }
  return result.join('');
}

/**
 * When `oldString` matched via quote normalization (curly quotes in the
 * file, straight quotes from the model), re-apply the file's curly-quote
 * typography to `newString` so the edit preserves the file's style.
 *
 * Uses a simple open/close heuristic: a quote preceded by whitespace,
 * start-of-string, or opening punctuation is treated as an opening quote;
 * otherwise it is a closing quote. Apostrophes inside words (contractions)
 * become a right single curly quote.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString;

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);

  if (!hasDoubleQuotes && !hasSingleQuotes) return newString;

  let result = newString;
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result);
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result);
  return result;
}
