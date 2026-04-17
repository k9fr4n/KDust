/**
 * Extract the strict JSON block from the agent's raw output and
 * normalise it to the shape the UI expects. Lenient on the envelope
 * (accepts both fenced ```json ... ``` and naked {...}) but strict on
 * the shape: we discard anything that doesn't match.
 */

export type AdvicePoint = {
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  refs?: string[];
};

/**
 * Parsed advice payload. `score` is in [0..100], or null if the agent
 * omitted it / the value was out of range. Legacy agent output that
 * predates the score contract still parses successfully with score=null.
 */
export type AdvicePayload = {
  points: AdvicePoint[];
  score: number | null;
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
      for (const p of arr) {
        if (!p || typeof p !== 'object') continue;
        const title = typeof p.title === 'string' ? p.title.trim() : '';
        const description =
          typeof p.description === 'string' ? p.description.trim() : '';
        const severity =
          typeof p.severity === 'string' && VALID_SEVERITIES.has(p.severity)
            ? (p.severity as AdvicePoint['severity'])
            : 'medium';
        const refs =
          Array.isArray(p.refs)
            ? p.refs.filter((r: unknown) => typeof r === 'string')
            : undefined;
        if (!title || !description) continue;
        normalised.push({ title, description, severity, refs });
      }
      if (normalised.length > 0) {
        return {
          points: normalised.slice(0, 3),
          score: coerceScore(obj.score),
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
