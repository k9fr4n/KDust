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

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export function parseAdviceOutput(raw: string): AdvicePoint[] | null {
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
      if (normalised.length > 0) return normalised.slice(0, 3);
    } catch {
      /* try next candidate */
    }
  }
  return null;
}
