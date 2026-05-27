// src/lib/mcp/gateway-path-match.ts
//
// Glob-pattern matching for ProjectMcpToolFilter.projectFsPath
// (Franck 2026-05-27). Lets a single filter row cover many
// projects, e.g. "Client/*" → every project whose fsPath sits
// directly under "Client/".
//
// Semantics (POSIX-ish):
//   ?   → exactly one char, not '/'
//   *   → any chars, not '/' (single path segment)
//   **  → any chars including '/' (recursive)
//
// Anything else is matched literally. Literal patterns (no `*`
// or `?`) fall back to strict string equality — the historical
// behaviour, preserved for full backward compatibility.

export function isPatternFsPath(p: string): boolean {
  return p.includes('*') || p.includes('?');
}

/**
 * Strip a leading `/` so a user-typed "/Client/*" aligns with
 * the canonical slash-free `Project.fsPath`. Idempotent.
 */
export function normalizeProjectFsPath(p: string): string {
  return p.replace(/^\/+/, '');
}

function compileGlob(pattern: string): RegExp {
  const parts: string[] = ['^'];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        parts.push('.*');
        i++;
      } else {
        parts.push('[^/]*');
      }
    } else if (c === '?') {
      parts.push('[^/]');
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      parts.push('\\' + c);
    } else {
      parts.push(c);
    }
  }
  parts.push('$');
  return new RegExp(parts.join(''));
}

export function pathMatchesPattern(pattern: string, fsPath: string): boolean {
  if (!isPatternFsPath(pattern)) return pattern === fsPath;
  return compileGlob(pattern).test(fsPath);
}
