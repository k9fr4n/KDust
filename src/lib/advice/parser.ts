/**
 * Extract the strict JSON block from the agent's raw output and
 * normalise it to the shape the UI expects. Lenient on the envelope
 * (accepts both fenced ```json ... ``` and naked {...}) but strict on
 * the shape: we discard anything that doesn't match.
 */

export type AdvicePoint = {
  /** 1-based rank inferred from array order (or explicit `rank` field). */
  rank: number;
  /**
   * Category tag on the point itself. Starting with the v4 contract
   * every point carries its category (security, performance, …) so
   * the UI can group / filter without the parent row's category.
   * null for legacy payloads parsed from v3 rows.
   */
  category: string | null;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  refs?: string[];
};

export type CategoryScore = {
  score: number | null;
  notes: string;
};

/**
 * Parsed advice payload — v4 contract (2026-04-18).
 *
 * Shape:
 *   - `score`          : overall project health [0..100] (was v3 `score`,
 *                        v4 `global_score`; unified here).
 *   - `categoryScores` : per-category `{score, notes}`, keyed by the
 *                        canonical slugs in POINT_CATEGORIES. Empty
 *                        object for legacy v3 rows that didn't emit it.
 *   - `points`         : ordered list of advice points, each with its
 *                        own category tag (v4) or null (v3).
 *
 * Backwards compat:
 *   - v3 agent output (`{score, points:[{title, description, severity, refs}]}`)
 *     parses successfully with categoryScores={} and point.category=null.
 *   - Legacy rows already stored in DB (same v3 shape) are re-read
 *     with the same helper and get the same default fields.
 */
export type AdvicePayload = {
  points: AdvicePoint[];
  score: number | null;
  categoryScores: Record<string, CategoryScore>;
};

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Coerce arbitrary JSON input to a [0..100] integer score, or null.
 * Accepts numbers, numeric strings, and clamps out-of-range values
 * with a console.warn so we don't silently drop a bad agent response.
 */
function coerceScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(n)));
  if (clamped !== n) {
    console.warn(`[advice/parser] score ${n} clamped to ${clamped}`);
  }
  return clamped;
}

export function parseAdviceOutput(raw: string): AdvicePayload | null {
  if (!raw) return null;

  // Try fenced block first — the prompt asks for it. Fall back to the
  // first balanced { ... } we can find. Greedy-match .* with `s` flag
  // so newlines are included.
  const fenced = /```json\s*([\s\S]*?)```/i.exec(raw);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  // Fallback: try to locate the outermost {...} by scanning brackets.
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
      const arr = Array.isArray(obj?.points) ? obj.points : null;
      if (!arr) continue;
      const normalised: AdvicePoint[] = [];
      arr.forEach((p: unknown, idx: number) => {
        if (!p || typeof p !== 'object') return;
        const pp = p as Record<string, unknown>;
        const title = typeof pp.title === 'string' ? pp.title.trim() : '';
        const description =
          typeof pp.description === 'string' ? pp.description.trim() : '';
        const severity =
          typeof pp.severity === 'string' && VALID_SEVERITIES.has(pp.severity)
            ? (pp.severity as AdvicePoint['severity'])
            : 'medium';
        const refs = Array.isArray(pp.refs)
          ? (pp.refs as unknown[]).filter(
              (r: unknown): r is string => typeof r === 'string',
            )
          : undefined;
        // v4: each point carries its own category tag. v3 points have
        // none — we keep null and let the UI fall back to the parent
        // row's category.
        const category =
          typeof pp.category === 'string' && pp.category.trim()
            ? pp.category.trim()
            : null;
        // Prefer the explicit rank if the agent respected the contract;
        // otherwise infer from array position (idx+1). Clamp to [1..].
        const rawRank = typeof pp.rank === 'number' ? pp.rank : Number(pp.rank);
        const rank =
          Number.isFinite(rawRank) && rawRank >= 1
            ? Math.round(rawRank)
            : idx + 1;
        if (!title || !description) return;
        normalised.push({ rank, category, title, description, severity, refs });
      });
      if (normalised.length === 0) continue;

      // v4 category_scores block — {key: {score, notes}}. Tolerate a
      // missing block (v3 rows) and malformed sub-entries (skip them).
      const categoryScores: Record<string, CategoryScore> = {};
      const csRaw = obj.category_scores;
      if (csRaw && typeof csRaw === 'object') {
        for (const [k, v] of Object.entries(csRaw)) {
          if (!v || typeof v !== 'object') continue;
          const vv = v as Record<string, unknown>;
          categoryScores[k] = {
            score: coerceScore(vv.score),
            notes: typeof vv.notes === 'string' ? vv.notes.trim() : '',
          };
        }
      }

      // Global score — v4 `global_score` supersedes v3 `score`. Prefer
      // the new field, fall back to the old one for legacy compat.
      const globalScore =
        coerceScore(obj.global_score) ?? coerceScore(obj.score);

      return {
        // Cap at 15 to bound the payload regardless of agent verbosity.
        points: normalised.slice(0, 15),
        score: globalScore,
        categoryScores,
      };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
