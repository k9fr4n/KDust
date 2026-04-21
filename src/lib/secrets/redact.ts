// src/lib/secrets/redact.ts
//
// Plaintext scrubber for command-runner outputs (Franck 2026-04-21).
//
// Goal
// ----
// Even if we never pass a secret in argv and only put it in `env`,
// the child process can still print it (curl -v, gh --debug, a misused
// echo). We don\u2019t want those prints reaching:
//   * the Command.stdout / Command.stderr DB columns (forensic risk)
//   * the JSON payload returned to the LLM (prompt-injection exfil)
//
// So before we persist or return any output, we run each active
// plaintext through this redactor. Byte-for-byte replacement only:
//   * no regex magic — we don\u0027t want false-positive-redacting normal
//     text that happens to look similar
//   * replacement token identifies which secret matched so operators
//     can tell that a leak attempt happened
//
// The redactor is intentionally conservative:
//   * shorter-than-8-chars values are NOT redacted — high false-positive
//     risk (a secret like "abc" would black-out unrelated prose).
//   * very long values are redacted whole; we don\u0027t attempt partial.

const MIN_REDACT_LEN = 8;

export interface RedactRef {
  envName: string;
  secretName: string;
}

/**
 * Build a redactor bound to a specific run. Each item in `redactList`
 * is paired with its `hints` entry (same order as produced by
 * resolveForRun) so the replacement token can name which secret it
 * caught.
 */
export function buildRedactor(
  redactList: string[],
  hints: RedactRef[],
): (s: string) => string {
  // Filter out values too short to redact safely and pre-sort by
  // descending length: replace longer needles first so a long secret
  // that contains a shorter one as substring doesn\u0027t get half-replaced.
  const entries = redactList
    .map((v, i) => ({ value: v, ref: hints[i] }))
    .filter((e) => e.value.length >= MIN_REDACT_LEN)
    .sort((a, b) => b.value.length - a.value.length);

  if (entries.length === 0) return (s) => s;

  return (s: string) => {
    let out = s;
    for (const { value, ref } of entries) {
      // split/join is faster and safer than regex for literal replace.
      if (out.includes(value)) {
        out = out.split(value).join(`[REDACTED:${ref.secretName}]`);
      }
    }
    return out;
  };
}

export const noopRedactor = (s: string) => s;
