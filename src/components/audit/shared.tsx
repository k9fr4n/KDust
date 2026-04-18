'use client';

/**
 * Shared types + helpers used by both the per-project AuditSection
 * and the cross-project /audits page. Kept together so score styling,
 * severity palette and chat-deep-link encoding stay consistent.
 */

export type AuditPoint = {
  /**
   * 1-based rank in the project's priority list (v4). Optional for
   * legacy v3 payloads where position in the array was the de-facto
   * rank; the UI should fall back to (index+1) when absent.
   */
  rank?: number;
  /**
   * Axis the point belongs to (security, performance, code_quality,
   * improvement, documentation, test_coverage). null on legacy v3
   * payloads that predated per-point categorisation.
   */
  category?: string | null;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  refs?: string[];
};

export type AuditSlot = {
  category: string;
  label: string;
  emoji: string;
  points: AuditPoint[] | null;
  score: number | null;
  generatedAt: string | null;
  task: {
    id: string;
    schedule: string;
    enabled: boolean;
    lastRunAt: string | null;
    lastStatus: string | null;
  } | null;
};

export const SEVERITY_STYLE: Record<AuditPoint['severity'], string> = {
  low: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300',
  critical: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
};

/**
 * Numeric ordering for severities, used on the cross-project page to
 * surface critical items first. Higher number = worse.
 */
export const SEVERITY_WEIGHT: Record<AuditPoint['severity'], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Pick a tailwind color class family based on a 0..100 score, using
 * the same thresholds as the JSON contract prompt:
 *   90–100 excellent, 70–89 good, 50–69 fair, 30–49 poor, <30 critical.
 */
export function scoreColor(score: number | null): {
  bg: string;
  text: string;
  ring: string;
  grade: string;
} {
  if (score === null || score === undefined)
    return {
      bg: 'bg-slate-100 dark:bg-slate-800',
      text: 'text-slate-500 dark:text-slate-400',
      ring: 'ring-slate-300 dark:ring-slate-700',
      grade: '?',
    };
  if (score >= 90)
    return {
      bg: 'bg-green-100 dark:bg-green-950/40',
      text: 'text-green-700 dark:text-green-300',
      ring: 'ring-green-300 dark:ring-green-800',
      grade: 'A',
    };
  if (score >= 70)
    return {
      bg: 'bg-lime-100 dark:bg-lime-950/40',
      text: 'text-lime-700 dark:text-lime-300',
      ring: 'ring-lime-300 dark:ring-lime-800',
      grade: 'B',
    };
  if (score >= 50)
    return {
      bg: 'bg-amber-100 dark:bg-amber-950/40',
      text: 'text-amber-700 dark:text-amber-300',
      ring: 'ring-amber-300 dark:ring-amber-800',
      grade: 'C',
    };
  if (score >= 30)
    return {
      bg: 'bg-orange-100 dark:bg-orange-950/40',
      text: 'text-orange-700 dark:text-orange-300',
      ring: 'ring-orange-300 dark:ring-orange-800',
      grade: 'D',
    };
  return {
    bg: 'bg-red-100 dark:bg-red-950/40',
    text: 'text-red-700 dark:text-red-300',
    ring: 'ring-red-300 dark:ring-red-800',
    grade: 'F',
  };
}

/**
 * Compact score pill. Renders nothing when score is null so slots
 * without a graded analysis stay visually clean.
 */
export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) {
    return (
      <span
        title="No score yet"
        className="text-[9px] font-mono text-slate-400 border border-dashed border-slate-300 dark:border-slate-700 rounded px-1.5 py-0.5"
      >
        —
      </span>
    );
  }
  const c = scoreColor(score);
  return (
    <span
      title={`Category score: ${score}/100 (grade ${c.grade})`}
      className={
        'inline-flex items-center gap-1 text-[10px] font-bold rounded-full px-2 py-0.5 ring-1 ' +
        c.bg + ' ' + c.text + ' ' + c.ring
      }
    >
      <span className="text-[9px] uppercase tracking-wide">{c.grade}</span>
      <span className="font-mono">{score}</span>
    </span>
  );
}

/**
 * Build a /chat deep-link that opens a fresh conversation with the
 * audit point pre-filled as the initial user message. The prompt is
 * base64(UTF-8)-encoded to survive multi-line content + special chars
 * through the query string.
 */
export function buildChatHrefFromAudit(opts: {
  label: string;
  emoji: string;
  point: AuditPoint;
  projectName?: string;
}) {
  const { label, emoji, point, projectName } = opts;
  const refs =
    point.refs && point.refs.length > 0
      ? `\n\nReferences: ${point.refs.join(', ')}`
      : '';
  const projectLine = projectName ? `\nProject: \`${projectName}\`\n` : '';
  const prompt =
    `Audit (${emoji} ${label} — severity ${point.severity}):${projectLine}\n` +
    `**${point.title}**\n\n${point.description}${refs}\n\n` +
    `Can you help me address this point? Review the relevant code, propose ` +
    `a concrete action plan, then apply the changes if it makes sense.`;
  const b64 =
    typeof window !== 'undefined'
      ? btoa(unescape(encodeURIComponent(prompt)))
      : '';
  return `/chat?prompt=${encodeURIComponent(b64)}`;
}

/**
 * Build a /chat deep-link that opens a fresh conversation whose
 * initial message bundles MULTIPLE audit points as context — used by
 * the cross-project /auditss page when the user checks several items
 * and clicks the bulk "Chat" action.
 *
 * The prompt lists each point with its project, axis, severity, rank,
 * title, description and refs in a compact markdown format the agent
 * can digest in one shot. Points are grouped by project to minimise
 * context-switching in the agent's response.
 */
export type BulkAuditItem = {
  projectName: string;
  categoryLabel: string;
  categoryEmoji: string;
  rank: number | null;
  point: AuditPoint;
};

export function buildBulkAuditPrompt(items: BulkAuditItem[]): string {
  if (items.length === 0) return '';

  // Group by project so the agent sees all points for a given project
  // together (helps it batch file reads and avoid redundant tool use).
  const byProject = new Map<string, BulkAuditItem[]>();
  for (const it of items) {
    const arr = byProject.get(it.projectName) ?? [];
    arr.push(it);
    byProject.set(it.projectName, arr);
  }

  const sections: string[] = [];
  for (const [projectName, group] of byProject) {
    const lines: string[] = [`### Project: \`${projectName}\``];
    for (const it of group) {
      const refs =
        it.point.refs && it.point.refs.length > 0
          ? `\n  Refs: ${it.point.refs.join(', ')}`
          : '';
      const rankStr = it.rank ? `#${it.rank} ` : '';
      lines.push(
        `- ${rankStr}**${it.point.title}** — ${it.categoryEmoji} ${it.categoryLabel} · severity **${it.point.severity}**\n` +
          `  ${it.point.description}${refs}`,
      );
    }
    sections.push(lines.join('\n'));
  }

  const header =
    items.length === 1
      ? `I want to discuss the following audit point:`
      : `I want to discuss the following ${items.length} audit points together:`;
  const footer =
    `\n\nFor each point, help me:\n` +
    `1. Confirm the finding by inspecting the referenced files\n` +
    `2. Propose a concrete remediation plan (smallest safe change first)\n` +
    `3. Apply the change when it's low-risk and uncontroversial, or ` +
    `flag it for review when the trade-offs are non-trivial.\n` +
    `Batch work by project when possible.`;

  return `${header}\n\n${sections.join('\n\n')}${footer}`;
}

/**
 * SessionStorage key used to hand off the bulk-audit prompt between
 * /advices (or AuditSection) and the /chat page. Using sessionStorage
 * rather than a `?prompt=<base64>` query string avoids browser URL
 * length limits (some browsers choke past ~8 KB; a 15-points prompt
 * can be 20+ KB) and survives any router soft-navigation quirks.
 *
 * The /chat page reads this key on mount AND whenever the pathname
 * changes back to /chat, then deletes it — so it's single-shot.
 */
export const PENDING_CHAT_PROMPT_KEY = 'kdust.chat.pendingPrompt';

/**
 * Drop a bulk-audit prompt in sessionStorage and navigate to /chat.
 * Must be called from a click handler (NOT during render) so the
 * sessionStorage write is synchronous and ordered before navigation.
 */
export function stashPromptAndGoToChat(prompt: string): void {
  try {
    sessionStorage.setItem(PENDING_CHAT_PROMPT_KEY, prompt);
  } catch {
    // Storage quota or private mode: fall back to the legacy query
    // string with a hard-truncated prompt. Better than dropping the
    // navigation entirely.
    const shortPrompt = prompt.slice(0, 4000);
    const b64 = btoa(unescape(encodeURIComponent(shortPrompt)));
    window.location.href = `/chat?prompt=${encodeURIComponent(b64)}`;
    return;
  }
  window.location.href = '/chat';
}
