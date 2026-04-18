/**
 * Extract the strict JSON block from the agent's raw output (v5
 * contract) and normalise it to the shape the UI expects.
 *
 * v5 format (one task per category):
 *   {
 *     "version": 5,
 *     "category": "security",
 *     "score": 0..100,
 *     "notes": "...",
 *     "points": [ { rank, title, description, severity, refs? } ]  // max 5
 *   }
 *
 * Older v3 / v4 payloads are NOT handled: the seeder wipes legacy
 * rows, and any freshly-run task uses the v5 contract.
 */

export type AuditPoint = {
  /** 1-based rank within the category (max 5). */
  rank: number;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  refs?: string[];
};

export type AuditPayload = {
  /** Echo of the category slug from the agent response. */
  category: string | null;
  /** Single category score [0..100]. */
  score: number | null;
  /** Short rationale, <=400 chars. */
  notes: string;
  /** Up to 5 points. */
  points: AuditPoint[];
};

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const MAX_POINTS = 5;

function coerceScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(n)));
  if (clamped !== n) {
    console.warn(`[audit/parser] score ${n} clamped to ${clamped}`);
  }
  return clamped;
}

export function parseAuditOutput(raw: string): AuditPayload | null {
  if (!raw) return null;

  // Try fenced block first (the contract asks for it). Fall back to
  // the outermost balanced {...} so we're tolerant to stray prose.
  const fenced = /```json\s*([\s\S]*?)```/i.exec(raw);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = raw.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    for (let i = firstBrace; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(raw.slice(firstBrace, i + 1));
          break;
        }
      }
    }
  }

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      // points[] must be an array (possibly empty: excellent project).
      const arr = Array.isArray(obj?.points) ? obj.points : null;
      if (!arr) continue;

      const points: AuditPoint[] = [];
      arr.forEach((p: unknown, idx: number) => {
        if (!p || typeof p !== 'object') return;
        const pp = p as Record<string, unknown>;
        const title = typeof pp.title === 'string' ? pp.title.trim() : '';
        const description =
          typeof pp.description === 'string' ? pp.description.trim() : '';
        const severity =
          typeof pp.severity === 'string' && VALID_SEVERITIES.has(pp.severity)
            ? (pp.severity as AuditPoint['severity'])
            : 'medium';
        const refs = Array.isArray(pp.refs)
          ? (pp.refs as unknown[]).filter(
              (r: unknown): r is string => typeof r === 'string',
            )
          : undefined;
        const rawRank = typeof pp.rank === 'number' ? pp.rank : Number(pp.rank);
        const rank =
          Number.isFinite(rawRank) && rawRank >= 1
            ? Math.round(rawRank)
            : idx + 1;
        if (!title || !description) return;
        points.push({ rank, title, description, severity, refs });
      });

      // Score is mandatory semantically but we still tolerate null to
      // surface a failed run with a clear error downstream.
      const score = coerceScore(obj.score);
      const category =
        typeof obj.category === 'string' && obj.category.trim()
          ? obj.category.trim()
          : null;
      const notes =
        typeof obj.notes === 'string' ? obj.notes.trim().slice(0, 400) : '';

      // Require at least the score to consider the parse successful
      // (a truly excellent project can legitimately return 0 points).
      if (score === null) continue;

      return {
        category,
        score,
        notes,
        points: points.slice(0, MAX_POINTS).sort((a, b) => a.rank - b.rank),
      };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Legacy alias kept for callers that still import parseAdviceOutput.
 * Returns a shape-compatible-enough object so the runner keeps
 * compiling until it's migrated alongside. New code should use
 * parseAuditOutput directly.
 * @deprecated
 */
export function parseAdviceOutput(raw: string): AuditPayload | null {
  return parseAuditOutput(raw);
}
