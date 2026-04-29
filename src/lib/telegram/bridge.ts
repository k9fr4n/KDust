/**
 * Telegram ↔ KDust chat bridge (Franck 2026-04-25 22:00).
 *
 * For each incoming Telegram message we:
 *   1. Whitelist-check the chat_id against AppConfig.
 *   2. Resolve (or create) a TelegramBinding => Conversation row.
 *      The bound Conversation is a regular KDust conversation
 *      (visible in /conversation in the web UI) so the operator
 *      can reopen the same thread from a desktop browser.
 *   3. Forward the message to Dust via createDustConversation /
 *      postUserMessage (origin='cli', NON-billed bucket).
 *   4. Stream the agent reply through streamAgentReply, throttling
 *      Telegram editMessageText to ~once/second (Bot API rate-
 *      limit). The placeholder message is sent BEFORE the stream
 *      so users see immediate feedback.
 *
 * Slash commands intercepted before the LLM:
 *   /start   — welcome + status
 *   /help    — list commands
 *   /new     — fresh conv; preserves the active project and
 *               rebases the agent on the project's defaultAgentSId
 *               (or AppConfig.telegramDefaultAgentSId when none /
 *               in global mode)
 *   /agent <sId> — sticky agent override (also resets binding)
 *   /whoami  — show chat_id, bound conv, current agent
 *   /stop    — cancel an in-flight stream for this chat
 *
 * Concurrency: a per-chat Map of AbortController guarantees that
 * a second user message while the first is streaming aborts the
 * old stream cleanly before posting the new one. Telegram users
 * naturally retry by re-sending; we honour that.
 */

import { db } from '@/lib/db';
import { getAppConfig } from '@/lib/config';
import {
  createDustConversation,
  postUserMessage,
  streamAgentReply,
} from '@/lib/dust/chat';
import { getDustClient } from '@/lib/dust/client';
import { listProjects } from '@/lib/projects';
import { resolveProjectByPathOrName } from '@/lib/folder-path';
import {
  getFsServerId,
  getChatTaskRunnerServerId,
} from '@/lib/mcp/registry';
import {
  sendMessage,
  editMessageText,
  sendChatAction,
  answerCallbackQuery,
  isInCooldown,
  cooldownRemainingMs,
  type TgMessage,
  type TgCallbackQuery,
} from './api';
import { markdownToTelegramHtml } from './markdown';

// ---- per-chat in-flight stream registry ----
const inFlight = new Map<string, AbortController>();

// ---- per-chat pending project choice ----
// Set when the user runs `/project <name>` BEFORE a binding
// exists (no conversation has been created yet on this chat).
// Consumed once on the next createBinding() call. Process-local
// only \u2014 a restart resets pending choices, the user just re-runs
// /project. Acceptable because the moment they send a real
// message the choice is persisted onto TelegramBinding.
const pendingProject = new Map<string, string>();

// Per-chat agent override pending for the next createBinding().
// Populated by applyProjectChoice() when the picked Project has a
// `defaultAgentSId` set: switching projects on Telegram should
// also rebase the conversation onto the project's preferred agent
// (Franck request 2026-04-27 18:01). Falls back to the global
// telegramDefaultAgentSId when the project has no preference.
// Process-local, consumed and cleared on the same createBinding()
// call as pendingProject.
const pendingAgent = new Map<string, string>();

/**
 * Resolve the active project for a Telegram chat, mirroring the
 * priority order used by the message handler:
 *   1. live binding row     (TelegramBinding.projectName)
 *   2. pending choice       (set by /project before any message)
 *   3. null                 (global mode — no filtering applied)
 *
 * Used by /new, /chats and /runs so they all observe the same
 * project context.
 */
async function getActiveProject(chatId: string): Promise<string | null> {
  const binding = await resolveBinding(chatId);
  return binding?.projectName ?? pendingProject.get(chatId) ?? null;
}

// ---- throttle config ----
// Telegram per-chat rate limit is ~1 msg/s; we edit at 900ms so
// the *last* edit (final answer) lands just under the budget and
// we still get ~1 visible "typing" update per second.
const EDIT_INTERVAL_MS = 900;

function isAllowed(chatId: string, csv: string | null): boolean {
  if (!csv) return false;
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(chatId);
}

async function resolveBinding(chatId: string) {
  return db.telegramBinding.findUnique({
    where: { chatId },
    include: { conversation: true },
  });
}

async function dropBinding(chatId: string): Promise<void> {
  // We only delete the binding row, NOT the underlying
  // Conversation — the user may want to reopen its history in
  // the web UI later. Re-binding the same conv via a future
  // command would require an explicit feature; not in v1.
  await db.telegramBinding.deleteMany({ where: { chatId } });
}

/**
 * Resolve the MCP serverIds to wire on a turn for this project.
 * Mirrors the chat client's behaviour (/api/mcp/ensure +
 * /api/mcp/task-runner-ensure): one fs-cli handle chrooted to
 * /projects/<name>, plus a task-runner-chat handle so the agent
 * can list_tasks / run_task / dispatch_task. Returns null when
 * no project is selected (agent uses its own configured tools
 * only \u2014 same as a chat with no project picker on the web UI).
 *
 * Failures are non-fatal: if either ensure throws (Dust offline,
 * registry hiccup), we still send the user message; the agent
 * will simply not have those tools on this turn. Logged as a
 * warning so the operator can investigate via /logs.
 */
async function resolveMcpServerIds(
  projectName: string | null,
): Promise<string[] | null> {
  if (!projectName) return null;
  const ids: string[] = [];
  try {
    ids.push(await getFsServerId(projectName));
  } catch (e) {
    console.warn(
      `[telegram] fs-cli ensure failed for project=${projectName}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  try {
    ids.push(await getChatTaskRunnerServerId(projectName));
  } catch (e) {
    console.warn(
      `[telegram] task-runner ensure failed for project=${projectName}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Picker helpers (#13, 2026-04-29). Pre-refactor the three sibling
 * pickers (sendAgentPicker / sendChatsPicker / sendRunsPicker) all
 * spelled out:
 *   1. empty-state guard
 *   2. 1-column inline_keyboard build with subtly different label
 *      caps (50 then 64 in agents, 64 only in chats, none explicit
 *      in runs)
 *   3. sendMessage(header, { inline_keyboard })
 * Centralised below so adding a 4th picker is data-only.
 *
 * truncateLabel enforces Telegram's 64-byte button label budget
 * uniformly across all pickers (was best-effort and inconsistent
 * pre-refactor). The 64-char count is a proxy for the underlying
 * UTF-8 byte count \u2014 cap is conservative for ASCII-heavy labels
 * which is the common case here (project names, run statuses,
 * agent names).
 */
function truncateLabel(s: string, max = 64): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

interface PickerItem {
  label: string;
  callbackData: string;
}

/**
 * Render a list of items as a Telegram inline keyboard with an
 * empty-state fallback. Defaults to 1 column to match the existing
 * picker UX; pass `columns: 2+` for denser grids.
 *
 * Each item.label is truncated to 64 chars, and callbackData is
 * sliced to 64 bytes to match Telegram's hard limits. Callers are
 * still responsible for formatting the label (emoji, check mark,
 * relative time, etc.) and the callbackData prefix (`agent:`,
 * `chat:`, `run:` ...).
 */
async function sendInlineKeyboard(
  chatId: string,
  opts: {
    header: string;
    items: PickerItem[];
    emptyMessage: string;
    columns?: number;
  },
): Promise<void> {
  if (opts.items.length === 0) {
    await sendMessage(chatId, opts.emptyMessage);
    return;
  }
  const cols = Math.max(1, opts.columns ?? 1);
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < opts.items.length; i += cols) {
    rows.push(
      opts.items.slice(i, i + cols).map((it) => ({
        text: truncateLabel(it.label),
        callback_data: it.callbackData.slice(0, 64),
      })),
    );
  }
  await sendMessage(chatId, opts.header, { inline_keyboard: rows });
}

/**
 * Fetch the visible agents from Dust and render them as an
 * inline keyboard so the user can switch with one tap. Mirrors
 * the /projects picker UX. Bound by Telegram's 64-byte
 * callback_data cap, but agent sIds are well under that.
 *
 * Best-effort: if Dust is unreachable we surface a plain text
 * error instead of leaving the user with no feedback.
 */
async function sendAgentPicker(chatId: string): Promise<void> {
  let agents: Array<{ sId: string; name: string }> = [];
  try {
    const ctx = await getDustClient();
    if (!ctx) throw new Error('Dust not connected');
    const r = await ctx.client.getAgentConfigurations({});
    if (r.isErr()) throw new Error(r.error.message);
    agents = r.value as Array<{ sId: string; name: string }>;
  } catch (e) {
    await sendMessage(
      chatId,
      `\u274c Could not list agents: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return;
  }
  // Sort alphabetically for stable, predictable order.
  agents.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  const cfg = await getAppConfig();
  const binding = await resolveBinding(chatId);
  // Mirrors the resolution order used by the message handler so
  // the ✅ in the picker matches what the next turn will actually
  // call: binding > pendingAgent (set by /project) > global default.
  const currentSId =
    binding?.agentSId ??
    pendingAgent.get(chatId) ??
    cfg.telegramDefaultAgentSId ??
    null;
  // Telegram caps inline_keyboard payloads at ~10kB; well under
  // for typical workspaces. If a workspace has >100 agents we
  // would need pagination — out of scope for v1.
  await sendInlineKeyboard(chatId, {
    header: 'Pick an agent:',
    emptyMessage: 'No agents visible to this user.',
    items: agents.map((a) => ({
      label: (currentSId === a.sId ? '✅ ' : '') + a.name,
      callbackData: `agent:${a.sId}`,
    })),
  });
}

// ---- Conversations browser (Franck 2026-04-26 19:55) -----
//
// /chats        \u2192 inline keyboard of the 12 most recent
//                  conversations (across both web UI and
//                  Telegram origin), with a check on the one
//                  this chat is currently bound to.
// /chat <id>    \u2192 rebind the current Telegram chat to that
//                  conversation. Future user messages are
//                  posted into that conversation's Dust thread,
//                  so the agent has the full prior history as
//                  context.
//
// Trade-off acknowledged: TelegramBinding has unique(chatId)
// AND unique(conversationId), so binding to a conv that some
// OTHER chat is currently using would 409. We resolve by
// detaching the prior binding silently \u2014 in a single-user
// KDust deployment that's the right call. In a future
// multi-user setup we would gate this behind ownership.

async function sendChatsPicker(chatId: string): Promise<void> {
  // Only show conversations that have at least one user
  // message: empty placeholders that were created by /agent or
  // /project but never used would be noise here.
  //
  // Project scoping: when the chat is bound to a project, only
  // surface conversations belonging to that project. In global
  // mode (no project), we keep the legacy "show everything"
  // behaviour — operators occasionally want a cross-project
  // overview from a fresh chat.
  const project = await getActiveProject(chatId);
  const convs = await db.conversation.findMany({
    take: 12,
    orderBy: { updatedAt: 'desc' },
    where: {
      messages: { some: { role: 'user' } },
      ...(project ? { projectName: project } : {}),
    },
    select: {
      id: true,
      title: true,
      agentName: true,
      projectName: true,
      updatedAt: true,
      pinned: true,
    },
  });
  // Surface the currently-bound conversation so the operator
  // sees "you're already in here" without re-tapping.
  const currentBinding = await resolveBinding(chatId);
  const currentConvId = currentBinding?.conversationId ?? null;
  await sendInlineKeyboard(chatId, {
    header: `Recent conversations${project ? ` in [${project}]` : ''}:`,
    emptyMessage: project
      ? `No conversations in [${project}]. Use /project to switch or /projects for the list.`
      : 'No conversations yet.',
    items: convs.map((c) => {
      const isCurrent = currentConvId === c.id;
      const pin = c.pinned ? '📌 ' : '';
      // Compose: "<check> <pin> <title> · <agent> · <time>"
      const title = c.title.length > 32 ? c.title.slice(0, 29) + '…' : c.title;
      const agentTag = c.agentName ? ` · ${c.agentName}` : '';
      const projectTag = c.projectName ? ` [${c.projectName}]` : '';
      return {
        label:
          (isCurrent ? '✅ ' : '') +
          pin +
          title +
          agentTag +
          projectTag +
          ` · ${fmtRelative(c.updatedAt)}`,
        callbackData: `chat:${c.id}`,
      };
    }),
  });
}

async function applyChatChoice(
  chatId: string,
  conversationId: string,
): Promise<{ ok: boolean; message: string; title?: string }> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      title: true,
      agentSId: true,
      agentName: true,
      projectName: true,
      dustConversationSId: true,
    },
  });
  if (!conv) {
    return {
      ok: false,
      message: `\u274c Conversation ${conversationId} not found.`,
    };
  }
  // Detach any existing binding for this chat AND any other
  // binding that may already point at this conversation. The
  // unique(conversationId) constraint would otherwise reject
  // the create. In a single-user deployment this is the
  // expected behaviour; the prior chat just lands back on
  // "fresh conv on next message" which is the same as /new.
  await db.telegramBinding.deleteMany({
    where: { OR: [{ chatId }, { conversationId }] },
  });
  await db.telegramBinding.create({
    data: {
      chatId,
      conversationId: conv.id,
      agentSId: conv.agentSId,
      projectName: conv.projectName,
    },
  });
  // Drop any pending project / agent choice \u2014 we just rebound
  // to a concrete conv, that conv's own projectName + agentSId
  // win.
  pendingProject.delete(chatId);
  pendingAgent.delete(chatId);
  return {
    ok: true,
    title: conv.title,
    message:
      `\u2705 Entered conversation "${conv.title}"${
        conv.agentName ? ` (agent: ${conv.agentName})` : ''
      }${conv.projectName ? ` [project: ${conv.projectName}]` : ''}.\n` +
      `Your next message continues this thread.`,
  };
}

// ---- Task runs viewer (Franck 2026-04-26) ----------------
//
// Read-only window into TaskRun for Telegram. Two entry points:
//   /runs        \u2192 inline keyboard of the latest 12 runs (running
//                  ones first, then recent finished). Tap to drill
//                  in.
//   /run <id>    \u2192 plain-text dump of one run (status, branch,
//                  phase, durations, PR url, output tail).
//
// We deliberately keep the projection narrow (no thinkingOutput,
// no full output) so the message stays under Telegram's 4096-byte
// cap and we don't ship the agent's chain-of-thought to a chat
// that may be archived externally.

const RUN_STATUS_EMOJI: Record<string, string> = {
  running: '\u25b6\ufe0f',
  success: '\u2705',
  failed: '\u274c',
  aborted: '\ud83d\uded1',
  skipped: '\u23ed\ufe0f',
  'no-op': '\u26aa',
};

function fmtRelative(d: Date | null | undefined): string {
  if (!d) return '\u2014';
  const ms = Date.now() - d.getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

function fmtDuration(startedAt: Date, finishedAt: Date | null): string {
  const end = finishedAt ?? new Date();
  const ms = end.getTime() - startedAt.getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs ? ` ${rs}s` : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm ? ` ${rm}m` : ''}`;
}

async function sendRunsPicker(chatId: string): Promise<void> {
  // Fetch latest 12, but lift any currently-running entries to
  // the top regardless of startedAt (they're the most useful
  // signal for a "what is happening right now" query).
  //
  // Project scoping: same rule as /chats — restrict to the active
  // project when one is set; show everything in global mode.
  const project = await getActiveProject(chatId);
  const recent = await db.taskRun.findMany({
    take: 12,
    orderBy: { startedAt: 'desc' },
    where: project ? { task: { projectPath: project } } : undefined,
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      task: { select: { name: true } },
    },
  });
  recent.sort((a, b) => {
    const aRunning = a.status === 'running' ? 0 : 1;
    const bRunning = b.status === 'running' ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    return b.startedAt.getTime() - a.startedAt.getTime();
  });
  await sendInlineKeyboard(chatId, {
    header: `Recent runs${project ? ` in [${project}]` : ''}:`,
    emptyMessage: project ? `No runs in [${project}].` : 'No task runs yet.',
    items: recent.map((r) => {
      const emoji = RUN_STATUS_EMOJI[r.status] ?? '❓';
      const when =
        r.status === 'running'
          ? `running ${fmtDuration(r.startedAt, null)}`
          : fmtRelative(r.finishedAt ?? r.startedAt);
      // Cap task name aggressively so the row stays readable on
      // mobile; sendInlineKeyboard re-caps the full label at 64.
      const taskName =
        r.task.name.length > 36 ? r.task.name.slice(0, 33) + '…' : r.task.name;
      return {
        label: `${emoji} ${taskName} · ${when}`,
        callbackData: `run:${r.id}`,
      };
    }),
  });
}

async function sendRunDetail(chatId: string, runId: string): Promise<void> {
  const run = await db.taskRun.findUnique({
    where: { id: runId },
    include: {
      task: { select: { name: true, projectPath: true, agentName: true } },
    },
  });
  if (!run) {
    await sendMessage(chatId, `\u274c Run ${runId} not found.`);
    return;
  }
  const emoji = RUN_STATUS_EMOJI[run.status] ?? '\u2753';
  const lines: string[] = [];
  lines.push(`${emoji} ${run.task.name}  \u2014 ${run.status}`);
  lines.push('');
  lines.push(`run id   : ${run.id}`);
  if (run.task.projectPath) lines.push(`project  : ${run.task.projectPath}`);
  if (run.task.agentName) lines.push(`agent    : ${run.task.agentName}`);
  lines.push(
    `started  : ${run.startedAt.toISOString()} (${fmtRelative(run.startedAt)})`,
  );
  if (run.finishedAt) {
    lines.push(`finished : ${run.finishedAt.toISOString()}`);
  }
  lines.push(`duration : ${fmtDuration(run.startedAt, run.finishedAt)}`);
  if (run.status === 'running' && run.phase) {
    lines.push(
      `phase    : ${run.phase}${run.phaseMessage ? ` \u2014 ${run.phaseMessage}` : ''}`,
    );
  }
  if (run.branch) {
    lines.push(
      `branch   : ${run.branch}${run.baseBranch ? ` (from ${run.baseBranch})` : ''}`,
    );
  }
  if (run.commitSha) lines.push(`commit   : ${run.commitSha.slice(0, 12)}`);
  if (
    run.filesChanged !== null ||
    run.linesAdded !== null ||
    run.linesRemoved !== null
  ) {
    lines.push(
      `diff     : ${run.filesChanged ?? '?'} files, ` +
        `+${run.linesAdded ?? 0} \u2212${run.linesRemoved ?? 0}`,
    );
  }
  if (run.dryRun) lines.push('mode     : dry-run');
  if (run.prUrl) lines.push(`PR       : ${run.prUrl}`);
  if (run.mergeBackStatus) {
    lines.push(
      `merge    : ${run.mergeBackStatus}${
        run.mergeBackDetails ? ` \u2014 ${run.mergeBackDetails}` : ''
      }`,
    );
  }
  if (run.error) {
    // Surface a tail of the error \u2014 enough to triage from a
    // phone, full text remains in the web UI.
    const tail = run.error.length > 600 ? '\u2026' + run.error.slice(-600) : run.error;
    lines.push('');
    lines.push('error:');
    lines.push(tail);
  } else if (run.output && run.status !== 'running') {
    const tail =
      run.output.length > 800 ? '\u2026' + run.output.slice(-800) : run.output;
    lines.push('');
    lines.push('output (tail):');
    lines.push(tail);
  }
  await sendMessage(chatId, lines.join('\n'));
}

/**
 * Validate + apply an agent change. Used by both the
 * `/agent <sId>` slash command and the inline-keyboard
 * callback. Mirrors applyProjectChoice() to keep both code
 * paths behaviourally identical.
 */
async function applyAgentChoice(
  chatId: string,
  sId: string,
): Promise<{ ok: boolean; message: string; agentName?: string }> {
  let agentName: string | null = null;
  try {
    const ctx = await getDustClient();
    if (!ctx) throw new Error('Dust not connected');
    const r = await ctx.client.getAgentConfigurations({});
    if (r.isErr()) throw new Error(r.error.message);
    const list = r.value as Array<{ sId: string; name: string }>;
    const match = list.find((a) => a.sId === sId);
    if (!match) throw new Error('agent sId not visible to this user');
    agentName = match.name;
  } catch (e) {
    return {
      ok: false,
      message: `\u274c Agent ${sId} not found: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  await dropBinding(chatId);
  // An explicit /agent pick wins over any project-default agent
  // queued by /project: clear the pending override so the next
  // turn uses the global default we just wrote.
  pendingAgent.delete(chatId);
  await db.appConfig.update({
    where: { id: 1 },
    data: { telegramDefaultAgentSId: sId },
  });
  return {
    ok: true,
    agentName: agentName ?? undefined,
    message:
      `\u2705 Agent set to ${agentName ?? sId}` +
      (agentName ? ` (${sId})` : '') +
      `. The next message starts a fresh conversation with this agent.`,
  };
}

/**
 * Apply a project change for a given chat. Used by both the
 * `/project <name>` slash command and the inline-keyboard
 * callback fired from `/projects` button taps. Centralising the
 * logic keeps both entry points behaviourally identical
 * (drop-and-reset semantics, in-memory pending map) and avoids
 * drift if we tweak the rules later.
 *
 * @param chatId Telegram chat identifier (string form).
 * @param projectName  null \u2192 clear, otherwise a directory name
 *                     under /projects to switch to.
 * @returns Object with a user-facing message and a flag
 *          indicating whether the change was applied (false on
 *          unknown project so the caller can treat it as an
 *          error path, e.g. show_alert on a callback toast).
 */
async function applyProjectChoice(
  chatId: string,
  projectName: string | null,
): Promise<{ ok: boolean; message: string }> {
  if (projectName === null) {
    await dropBinding(chatId);
    pendingProject.delete(chatId);
    // Clearing the project context also drops any project-default
    // agent override; the next conversation falls back to the
    // global telegramDefaultAgentSId.
    pendingAgent.delete(chatId);
    return {
      ok: true,
      message:
        '\u2705 Project cleared. The next message starts a fresh ' +
        'conversation in global mode (no fs tools).',
    };
  }
  // Phase 4 (2026-04-27): accept either the bare leaf name (legacy
  // contract, /project myapp) or the full hierarchical path
  // (/project clients/acme/myapp). resolveProjectByPathOrName tries
  // fsPath first, then falls back to the leaf name. We refuse the
  // bare-leaf form when ambiguous so the user knows to disambiguate
  // — silent first-match would chroot fs tools on the wrong dir.
  const match = await resolveProjectByPathOrName(projectName);
  if (!match) {
    return {
      ok: false,
      message: `\u274c Project "${projectName}" not found. Run /projects for the list.`,
    };
  }
  if (!projectName.includes('/')) {
    const collisions = await db.project.findMany({
      where: { name: projectName },
      select: { fsPath: true, name: true },
    });
    if (collisions.length > 1) {
      const paths = collisions.map((c) => c.fsPath ?? c.name).join(', ');
      return {
        ok: false,
        message:
          `\u274c "${projectName}" is ambiguous (matches: ${paths}). ` +
          `Use the full path, e.g. /project ${collisions[0].fsPath ?? collisions[0].name}.`,
      };
    }
  }
  const canonical = match.fsPath ?? match.name;
  // Switching project resets the conversation: a fresh fs-cli
  // chroot makes any reuse of the previous Dust conv tool
  // history misleading. The binding row will be recreated on
  // the next real user message; until then we remember the
  // project choice in the in-memory pending map so
  // createBinding() picks it up.
  await dropBinding(chatId);
  pendingProject.set(chatId, canonical);

  // Rebase to the project's default agent if it has one. Without
  // this, switching projects would land back on the global
  // telegramDefaultAgentSId \u2014 surprising behaviour when the
  // project is set up with a specialised agent (e.g. an Infra-DevOps
  // assistant for an SRE project, a TypeScript reviewer for a Next
  // app, etc.). The user can still override per-conversation with
  // /agent <sId>, which writes to TelegramBinding.agentSId on the
  // next real message.
  let agentSwitchedNote = '';
  if (match.defaultAgentSId) {
    pendingAgent.set(chatId, match.defaultAgentSId);
    agentSwitchedNote = ` Agent rebased on the project default (${match.defaultAgentSId}).`;
  } else {
    pendingAgent.delete(chatId);
  }

  return {
    ok: true,
    message:
      `\u2705 Project set to ${canonical}. The next message starts ` +
      `a fresh conversation with fs tools chrooted on ` +
      `/projects/${canonical}.${agentSwitchedNote}`,
  };
}

/**
 * /projects browser \u2014 view builders.
 *
 * Telegram doesn't have native folder navigation, so we mimic it
 * with a stack of inline keyboards backed by editMessageText:
 *
 *   Root view  : one button per L1 folder ("\ud83d\udcc1 clients (12)") +
 *                inline projects directly under root (legacy /
 *                un-foldered) + a "global / no project" exit.
 *   L1 view    : one button per project under that L1 (label =
 *                "L2/leaf" so duplicates across L2 are visible) +
 *                "\u2190 back" to root.
 *
 * Re-rendering uses editMessageText with reply_markup to mutate
 * the existing message in place. The user therefore sees a single
 * scrolling-friendly bubble instead of a stack.
 *
 * callback_data scheme (Telegram caps at 64 bytes):
 *   pnav:root            \u2014 redraw the root keyboard
 *   pnav:l1:<name>       \u2014 drill into that L1 folder
 *   proj:<fsPath>        \u2014 select a project (existing contract)
 *   proj:__clear__       \u2014 clear current project (existing)
 *
 * The L1 \"name\" carries through as the key (folder names are
 * validated [a-zA-Z0-9._-]+ by /api/folders so they're safe and
 * short). We truncate defensively at 64 bytes, but a real-world
 * L1 with a 50+ char name would be rejected by the folder API
 * anyway.
 */

const PROJECTS_ROOT_LABEL = 'Pick a project:';

/**
 * Build the root keyboard: L1 folder buttons + "(unfiled)"
 * projects (legacy) + the global-exit button.
 *
 * Returns null when the catalog is empty so the caller can short-
 * circuit with an explanatory message.
 */
async function buildProjectsRootView(
  chatId: string,
): Promise<
  | { text: string; markup: { inline_keyboard: { text: string; callback_data: string }[][] } }
  | null
> {
  const projects = await listProjects();
  if (projects.length === 0) return null;
  const binding = await resolveBinding(chatId);
  const current = binding?.projectName ?? null;

  // Bucket projects under their L1 folder. fsPath shape:
  //   "L1/L2/leaf"  -> bucket "L1"
  //   "L1/leaf"     -> bucket "L1"   (depth-1 oddity, kept for fwd-compat)
  //   "leaf"        -> bucket "(unfiled)"  (un-migrated rows)
  const byL1 = new Map<string, typeof projects>();
  for (const p of projects) {
    const parts = p.relativePath.split('/');
    const l1 = parts.length >= 2 ? parts[0] : '(unfiled)';
    if (!byL1.has(l1)) byL1.set(l1, []);
    byL1.get(l1)!.push(p);
  }
  const l1Names = [...byL1.keys()].sort((a, b) => {
    if (a === '(unfiled)') return 1;
    if (b === '(unfiled)') return -1;
    return a.localeCompare(b);
  });

  const buttons: { text: string; callback_data: string }[][] = [];
  for (const l1 of l1Names) {
    const list = byL1.get(l1)!;
    // For "(unfiled)" we expose projects directly at the root
    // since there's no real folder to drill into. For real L1
    // folders we render a single drill-in button per folder.
    if (l1 === '(unfiled)') {
      for (const p of list) {
        const isCurrent = current === p.relativePath || current === p.name;
        const label = p.name;
        buttons.push([
          {
            text:
              (isCurrent ? '\u2705 ' : '') +
              (label.length > 50 ? label.slice(0, 47) + '\u2026' : label),
            callback_data: `proj:${p.relativePath}`.slice(0, 64),
          },
        ]);
      }
      continue;
    }
    // Highlight the L1 with a checkmark when the current project
    // lives inside it \u2014 lets the user spot their context at a glance.
    const currentInL1 =
      current && (current.startsWith(`${l1}/`) || current === l1);
    const text =
      (currentInL1 ? '\u2705 ' : '') +
      `\ud83d\udcc1 ${l1} (${list.length})`;
    buttons.push([
      {
        text: text.length > 60 ? text.slice(0, 59) + '\u2026' : text,
        callback_data: `pnav:l1:${l1}`.slice(0, 64),
      },
    ]);
  }
  buttons.push([
    {
      text: (current === null ? '\u2705 ' : '') + '\u2014 global (no project) \u2014',
      callback_data: 'proj:__clear__',
    },
  ]);
  return {
    text: PROJECTS_ROOT_LABEL,
    markup: { inline_keyboard: buttons },
  };
}

/**
 * Build the keyboard for a specific L1 folder.
 *
 * Two-tier listing:
 *   - L2 sub-folders are rendered as drill-in buttons "\ud83d\udcc1 <name> (N)"
 *     so a deeply populated L1 stays scannable.
 *   - Projects directly under L1 (depth-1 fsPath "L1/leaf", no L2)
 *     appear inline as project buttons.
 *
 * "\u2190 back" returns to the root view. Returns null when the L1 is
 * empty (e.g. last project moved out while keyboard was open) so
 * the caller can bounce back to root with a fresh state.
 */
async function buildProjectsL1View(
  chatId: string,
  l1: string,
): Promise<
  | { text: string; markup: { inline_keyboard: { text: string; callback_data: string }[][] } }
  | null
> {
  const projects = await listProjects();
  const list = projects.filter((p) => p.relativePath.startsWith(`${l1}/`));
  if (list.length === 0) return null;
  const binding = await resolveBinding(chatId);
  const current = binding?.projectName ?? null;

  // Bucket by L2: depth-3 fsPath = "L1/L2/leaf" -> L2 group;
  // depth-2 fsPath = "L1/leaf" -> rendered inline (no L2 layer).
  const byL2 = new Map<string, typeof list>();
  const direct: typeof list = [];
  for (const p of list) {
    const parts = p.relativePath.split('/');
    if (parts.length >= 3) {
      const l2 = parts[1];
      if (!byL2.has(l2)) byL2.set(l2, []);
      byL2.get(l2)!.push(p);
    } else {
      direct.push(p);
    }
  }

  const buttons: { text: string; callback_data: string }[][] = [];

  // L2 sub-folders first (drill-in). Highlight \u2705 if the current
  // project lives under this L2.
  const l2Names = [...byL2.keys()].sort((a, b) => a.localeCompare(b));
  for (const l2 of l2Names) {
    const sub = byL2.get(l2)!;
    const currentInL2 =
      current && current.startsWith(`${l1}/${l2}/`);
    const text =
      (currentInL2 ? '\u2705 ' : '') +
      `\ud83d\udcc1 ${l2} (${sub.length})`;
    buttons.push([
      {
        text: text.length > 60 ? text.slice(0, 59) + '\u2026' : text,
        // pnav:l2:<l1>/<l2> \u2014 we keep the full L1/L2 pair in the
        // callback to avoid an extra round-trip (the L1 view is
        // stateless re: which root we came from). Telegram caps
        // callback_data at 64 bytes; folder names are validated
        // [a-zA-Z0-9._-]+ so two short folder names always fit.
        callback_data: `pnav:l2:${l1}/${l2}`.slice(0, 64),
      },
    ]);
  }

  // Then projects living directly under L1 (no L2). Surfacing them
  // inline avoids forcing a useless drill-step when the layout is
  // shallow.
  const directSorted = [...direct].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  for (const p of directSorted) {
    const isCurrent = current === p.relativePath || current === p.name;
    const label = p.name;
    buttons.push([
      {
        text:
          (isCurrent ? '\u2705 ' : '') +
          (label.length > 50 ? label.slice(0, 47) + '\u2026' : label),
        callback_data: `proj:${p.relativePath}`.slice(0, 64),
      },
    ]);
  }

  buttons.push([{ text: '\u2190 back', callback_data: 'pnav:root' }]);
  return {
    text: `\ud83d\udcc1 ${l1}`,
    markup: { inline_keyboard: buttons },
  };
}

/**
 * Build the keyboard for a specific L2 folder (drilled in from a
 * given L1). Lists the projects directly under L1/L2 and ships an
 * "\u2190 back" button that returns to the parent L1 view.
 *
 * Returns null when L1/L2 is empty (stale keyboard) so the caller
 * can fall back gracefully.
 */
async function buildProjectsL2View(
  chatId: string,
  l1: string,
  l2: string,
): Promise<
  | { text: string; markup: { inline_keyboard: { text: string; callback_data: string }[][] } }
  | null
> {
  const projects = await listProjects();
  const prefix = `${l1}/${l2}/`;
  const list = projects.filter((p) => p.relativePath.startsWith(prefix));
  if (list.length === 0) return null;
  const binding = await resolveBinding(chatId);
  const current = binding?.projectName ?? null;

  const sorted = [...list].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  const buttons: { text: string; callback_data: string }[][] = [];
  for (const p of sorted) {
    const isCurrent = current === p.relativePath || current === p.name;
    buttons.push([
      {
        text:
          (isCurrent ? '\u2705 ' : '') +
          (p.name.length > 50 ? p.name.slice(0, 47) + '\u2026' : p.name),
        callback_data: `proj:${p.relativePath}`.slice(0, 64),
      },
    ]);
  }
  buttons.push([
    {
      // Back to the parent L1 view (not all the way to root).
      text: `\u2190 ${l1}`,
      callback_data: `pnav:l1:${l1}`.slice(0, 64),
    },
    {
      text: '\u2190\u2190 root',
      callback_data: 'pnav:root',
    },
  ]);
  return {
    // Breadcrumb-ish title so the user knows where they are.
    text: `\ud83d\udcc1 ${l1} / ${l2}`,
    markup: { inline_keyboard: buttons },
  };
}

/**
 * Dispatch a Telegram callback_query (inline keyboard button
 * tap). We always answer the query first to clear the spinner
 * on the client, then act on the encoded `data` field.
 *
 * Recognised callback_data formats:
 *   pnav:root        redraw the /projects root keyboard
 *   pnav:l1:<name>   drill into an L1 folder
 *   proj:<fsPath>    switch to that project
 *   proj:__clear__   clear the project (global mode)
 *
 * Unknown formats are quietly acked + logged so a stale
 * keyboard from a previous deploy doesn't surface a scary
 * error to the user.
 */
export async function handleTelegramCallback(
  cq: TgCallbackQuery,
): Promise<void> {
  try {
    const chatId = cq.message ? String(cq.message.chat.id) : null;
    const data = cq.data ?? '';
    if (!chatId) {
      await answerCallbackQuery(cq.id);
      return;
    }
    // Whitelist: only allow callbacks from the same chat_ids
    // that may chat with the bot. Otherwise an attacker could
    // forge callback_data from a public group (Telegram does
    // forward callbacks even if the bot is muted there).
    const cfg = await getAppConfig();
    if (!isAllowed(chatId, cfg.telegramAllowedChatIds)) {
      console.warn(
        `[telegram] rejected callback from chat_id=${chatId} (not in whitelist)`,
      );
      await answerCallbackQuery(cq.id);
      return;
    }

    // Folder-browser navigation. We mutate the existing message in
    // place via editMessageText so the user gets a single bubble
    // that morphs as they drill down / back up. Failures here are
    // logged but acked silently \u2014 a stale keyboard is not worth
    // a scary error message.
    if (
      data === 'pnav:root' ||
      data.startsWith('pnav:l1:') ||
      data.startsWith('pnav:l2:')
    ) {
      const messageId = cq.message?.message_id ?? null;
      // Build the requested view, with graceful fallbacks when a
      // node has been emptied since the keyboard was rendered:
      //   l2 empty -> bounce up to l1 view
      //   l1 empty -> bounce up to root view
      //   root empty -> nothing to render, leave message as is
      const renderRoot = async () => {
        const v = await buildProjectsRootView(chatId);
        if (v && messageId !== null) {
          await editMessageText(chatId, messageId, v.text, { reply_markup: v.markup });
        }
      };
      const renderL1 = async (l1: string) => {
        const v = await buildProjectsL1View(chatId, l1);
        if (v && messageId !== null) {
          await editMessageText(chatId, messageId, v.text, { reply_markup: v.markup });
        } else {
          await renderRoot();
        }
      };
      try {
        if (data === 'pnav:root') {
          await renderRoot();
        } else if (data.startsWith('pnav:l1:')) {
          const l1 = data.slice('pnav:l1:'.length);
          await renderL1(l1);
        } else {
          // pnav:l2:<l1>/<l2>
          const tail = data.slice('pnav:l2:'.length);
          const slash = tail.indexOf('/');
          if (slash <= 0 || slash === tail.length - 1) {
            // Malformed callback (truncation or stale keyboard from
            // a future deploy). Bounce to root.
            await renderRoot();
          } else {
            const l1 = tail.slice(0, slash);
            const l2 = tail.slice(slash + 1);
            const v = await buildProjectsL2View(chatId, l1, l2);
            if (v && messageId !== null) {
              await editMessageText(chatId, messageId, v.text, { reply_markup: v.markup });
            } else {
              // L2 emptied -> climb back to L1 (or root if L1 is
              // also empty), preserving the user's place in the
              // hierarchy as much as possible.
              await renderL1(l1);
            }
          }
        }
      } catch (e) {
        console.warn(`[telegram] pnav editMessageText failed: ${e instanceof Error ? e.message : e}`);
      }
      await answerCallbackQuery(cq.id);
      return;
    }

    if (data.startsWith('proj:')) {
      const arg = data.slice('proj:'.length);
      const target = arg === '__clear__' ? null : arg;
      const result = await applyProjectChoice(chatId, target);
      // The toast text is capped at ~200 chars by Telegram,
      // and show_alert=false makes it appear as a transient
      // popup near the top of the screen.
      await answerCallbackQuery(cq.id, {
        text: result.ok
          ? target
            ? `Project: ${target}`
            : 'Project cleared'
          : 'Project not found',
      });
      // Also send a confirmation message so the choice is
      // visible in the chat history (toasts disappear).
      await sendMessage(chatId, result.message);
      return;
    }

    if (data.startsWith('agent:')) {
      const sId = data.slice('agent:'.length);
      const result = await applyAgentChoice(chatId, sId);
      await answerCallbackQuery(cq.id, {
        text: result.ok
          ? `Agent: ${result.agentName ?? sId}`
          : 'Agent not found',
      });
      await sendMessage(chatId, result.message);
      return;
    }

    if (data.startsWith('run:')) {
      const id = data.slice('run:'.length);
      // Ack first to clear the spinner, THEN do the (slower) DB
      // read for the detail message.
      await answerCallbackQuery(cq.id);
      await sendRunDetail(chatId, id);
      return;
    }

    if (data.startsWith('chat:')) {
      const id = data.slice('chat:'.length);
      const result = await applyChatChoice(chatId, id);
      await answerCallbackQuery(cq.id, {
        text: result.ok
          ? `Chat: ${result.title ?? id}`
          : 'Conversation not found',
      });
      await sendMessage(chatId, result.message);
      return;
    }

    console.warn(`[telegram] unknown callback_data: ${data}`);
    await answerCallbackQuery(cq.id);
  } catch (e) {
    console.error(
      `[telegram] callback handler error (id=${cq.id}): ${
        e instanceof Error ? (e.stack ?? e.message) : String(e)
      }`,
    );
    // Best-effort ack so the spinner clears even on failure.
    await answerCallbackQuery(cq.id).catch(() => undefined);
  }
}

async function createBinding(
  chatId: string,
  agentSId: string,
  agentName: string | null,
  firstUserContent: string,
  projectName: string | null,
  mcpServerIds: string[] | null,
) {
  const dust = await createDustConversation(
    agentSId,
    firstUserContent,
    null,
    mcpServerIds,
    'cli',
  );
  const conv = await db.conversation.create({
    data: {
      dustConversationSId: dust.dustConversationSId,
      agentSId,
      agentName,
      title:
        firstUserContent.slice(0, 80).replace(/\s+/g, ' ').trim() ||
        'Telegram chat',
      // Tenant: when the user has selected a project via /project,
      // the conversation belongs to that tenant and shows up in
      // the web UI under the right project filter.
      projectName,
      messages: { create: [{ role: 'user', content: firstUserContent }] },
    },
  });
  await db.telegramBinding.create({
    data: { chatId, conversationId: conv.id, agentSId, projectName },
  });
  return { conv, userMessageSId: dust.userMessageSId, dustConversation: dust.conversation };
}

// ---- slash command handlers ----
/**
 * Slash-command registry (#3, 2026-04-29). Pre-refactor a 230-line
 * switch grew an extra case every time a command was added (we are
 * up to 11). The registry table below is the SINGLE place to add /
 * remove a command; `handleCommand()` is now a 4-line dispatcher.
 *
 * Each spec carries:
 *   - names[]      — the primary command and any aliases (e.g.
 *                    /help has /start as an alias). The first
 *                    entry is the canonical name shown in /help.
 *   - description  — single-line help blurb.
 *   - usage?       — optional `<args>` hint appended to the
 *                    command name in /help (e.g. /agent <sId>).
 *   - hidden?      — skip from /help (none currently, kept for
 *                    future internal-only commands).
 *   - handle()     — the actual logic.
 *
 * Behavioural parity: case bodies preserved verbatim. /help is now
 * auto-rendered from this table so adding a command updates the
 * help text with zero extra work — column-aligned at 16 chars to
 * match the pre-#3 hand-crafted layout users are used to.
 */
interface CommandSpec {
  names: string[];
  description: string;
  usage?: string;
  hidden?: boolean;
  handle: (args: string, chatId: string) => Promise<void>;
}

// Forward declaration so the /help spec can read the table.
let COMMAND_SPECS: CommandSpec[];

COMMAND_SPECS = [
  {
    names: ['/new'],
    description: 'start a fresh conversation',
    handle: async (_args, chatId) => {
      // Match the /project behaviour: a /new that lands inside a
      // project should keep the project context and rebase on its
      // defaultAgentSId; outside any project, fall through to the
      // global cfg.telegramDefaultAgentSId on the next message.
      const priorProject = await getActiveProject(chatId);
      await dropBinding(chatId);
      if (priorProject) {
        pendingProject.set(chatId, priorProject);
        const match = await resolveProjectByPathOrName(priorProject);
        if (match?.defaultAgentSId) {
          pendingAgent.set(chatId, match.defaultAgentSId);
        } else {
          // Project has no defaultAgentSId → next message resolves
          // through cfg.telegramDefaultAgentSId.
          pendingAgent.delete(chatId);
        }
      } else {
        pendingProject.delete(chatId);
        pendingAgent.delete(chatId);
      }
      await sendMessage(chatId, '✅ New conversation. Send your message.');
    },
  },
  {
    names: ['/agents', '/agent'],
    description:
      'pick an agent (clickable list); /agent <sId> to switch directly',
    usage: '<sId>',
    handle: async (args, chatId) => {
      const sId = args.trim().split(/\s+/)[0];
      if (!sId) {
        // No arg: render a clickable picker, same UX as
        // /projects. Tap a button → callback fires
        // applyAgentChoice() with the chosen sId.
        await sendAgentPicker(chatId);
        return;
      }
      const result = await applyAgentChoice(chatId, sId);
      await sendMessage(chatId, result.message);
    },
  },
  {
    names: ['/projects'],
    description: 'pick a project (clickable list, grouped by folder)',
    handle: async (_args, chatId) => {
      const view = await buildProjectsRootView(chatId);
      if (!view) {
        await sendMessage(chatId, 'No projects under /projects yet.');
        return;
      }
      await sendMessage(chatId, view.text, view.markup);
    },
  },
  {
    names: ['/project'],
    description:
      'set project context (L1/L2/leaf or bare leaf); empty = clear',
    usage: '<path>',
    handle: async (args, chatId) => {
      const requested = args.trim();
      const result = await applyProjectChoice(chatId, requested || null);
      await sendMessage(chatId, result.message);
    },
  },
  {
    names: ['/chats'],
    description: 'list recent conversations (clickable to enter)',
    handle: async (_args, chatId) => {
      await sendChatsPicker(chatId);
    },
  },
  {
    names: ['/chat'],
    description: 'enter an existing conversation by id (use /chats to pick)',
    usage: '<id>',
    handle: async (args, chatId) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        await sendMessage(
          chatId,
          'Usage: /chat <conversation_id>  (use /chats to pick)',
        );
        return;
      }
      const result = await applyChatChoice(chatId, id);
      await sendMessage(chatId, result.message);
    },
  },
  {
    names: ['/runs'],
    description: 'list recent task runs (clickable for details)',
    handle: async (_args, chatId) => {
      await sendRunsPicker(chatId);
    },
  },
  {
    names: ['/run'],
    description: 'show details of a specific run (use /runs to pick)',
    usage: '<id>',
    handle: async (args, chatId) => {
      const id = args.trim().split(/\s+/)[0];
      if (!id) {
        await sendMessage(chatId, 'Usage: /run <run_id>  (use /runs to pick)');
        return;
      }
      await sendRunDetail(chatId, id);
    },
  },
  {
    names: ['/whoami'],
    description: 'show chat id, agent, project, bound conv',
    handle: async (_args, chatId) => {
      const binding = await resolveBinding(chatId);
      const cfg = await getAppConfig();
      const project =
        binding?.projectName ?? pendingProject.get(chatId) ?? null;
      const agentSId =
        binding?.agentSId ??
        pendingAgent.get(chatId) ??
        cfg.telegramDefaultAgentSId ??
        null;
      // Prefer the cached name on the Conversation row (set at
      // bind time). Fall back to a Dust lookup so the user
      // never sees a bare sId when the agent is resolvable.
      // Dust call is wrapped in try/catch — a transient outage
      // shouldn't break /whoami.
      let agentName: string | null = binding?.conversation?.agentName ?? null;
      if (!agentName && agentSId) {
        try {
          const ctx = await getDustClient();
          if (ctx) {
            const r = await ctx.client.getAgentConfigurations({});
            if (r.isOk()) {
              const list = r.value as Array<{ sId: string; name: string }>;
              agentName =
                list.find((a) => a.sId === agentSId)?.name ?? null;
            }
          }
        } catch {
          /* keep agentName null */
        }
      }
      const agentLine = agentSId
        ? agentName
          ? `${agentName}  (${agentSId})`
          : agentSId
        : '—';
      await sendMessage(
        chatId,
        [
          `chat_id   : ${chatId}`,
          `agent     : ${agentLine}`,
          `project   : ${project ?? '— (global)'}${
            !binding && project ? '  [pending]' : ''
          }`,
          `conv      : ${binding?.conversationId ?? '— (will be created on next message)'}`,
          `dust sId  : ${binding?.conversation?.dustConversationSId ?? '—'}`,
        ].join('\n'),
      );
    },
  },
  {
    names: ['/stop'],
    description: 'abort the current streaming reply',
    handle: async (_args, chatId) => {
      const ac = inFlight.get(chatId);
      if (ac) {
        ac.abort();
        await sendMessage(chatId, '🛑 Stopping...');
      } else {
        await sendMessage(chatId, 'Nothing to stop.');
      }
    },
  },
  {
    names: ['/help', '/start'],
    description: 'this message',
    handle: async (_args, chatId) => {
      // Auto-rendered from COMMAND_SPECS. Column-aligned at 16
      // chars to match the pre-#3 hand-crafted layout.
      const lines: string[] = [
        'KDust bot — type a message to chat with your Dust agent.',
        '',
      ];
      for (const spec of COMMAND_SPECS) {
        if (spec.hidden) continue;
        const head = spec.usage
          ? `${spec.names[0]} ${spec.usage}`
          : spec.names[0];
        lines.push(`${head.padEnd(16, ' ')}${spec.description}`);
      }
      await sendMessage(chatId, lines.join('\n'));
    },
  },
];

// Flat name → spec lookup index. Built once at module load; replaces
// the linear switch dispatch.
const commandIndex = new Map<string, CommandSpec>(
  COMMAND_SPECS.flatMap((s) => s.names.map((n) => [n, s] as const)),
);

async function handleCommand(
  cmd: string,
  args: string,
  chatId: string,
): Promise<boolean> {
  const spec = commandIndex.get(cmd);
  if (!spec) return false;
  await spec.handle(args, chatId);
  return true;
}

/**
 * Main entry point invoked by the poller for every incoming
 * message. Catches all errors and reports them back to the user
 * so the loop stays alive on bad input.
 */
export async function handleTelegramMessage(msg: TgMessage): Promise<void> {
  // Top-level guard: any error inside this handler is logged and
  // swallowed so the poller's offset always advances. Without
  // this wrapper, an exception thrown from handleCommand (which
  // sits OUTSIDE the streaming try/catch below) would propagate
  // up to the poller and leave the offset stuck if anything in
  // the caller chain misbehaves.
  try {
    await handleTelegramMessageInner(msg);
  } catch (e) {
    if ((e as { skipped?: boolean }).skipped) {
      // Already-known cooldown skip; quieter log.
      console.warn(
        `[telegram] update from chat ${msg.chat.id} dropped: in cooldown`,
      );
      return;
    }
    console.error(
      `[telegram] handler error (chat=${msg.chat.id}): ${
        e instanceof Error ? (e.stack ?? e.message) : String(e)
      }`,
    );
  }
}

async function handleTelegramMessageInner(msg: TgMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? '').trim();
  if (!text) return;

  // Hard short-circuit while flood-banned. Advancing the offset
  // (done by the poller) drops the message; better than sending
  // it later when the user has long moved on, AND keeps us from
  // extending the ban by hitting the API.
  if (isInCooldown()) {
    console.warn(
      `[telegram] dropping update from chat=${chatId}: cooldown for ${Math.ceil(
        cooldownRemainingMs() / 1000,
      )}s`,
    );
    return;
  }

  const cfg = await getAppConfig();
  if (!isAllowed(chatId, cfg.telegramAllowedChatIds)) {
    console.warn(
      `[telegram] rejected message from chat_id=${chatId} (not in whitelist)`,
    );
    // Silent reply so an attacker can't enumerate the whitelist.
    // We DO log so the operator notices stray traffic in /logs.
    return;
  }

  // Slash commands take priority over LLM forwarding.
  if (text.startsWith('/')) {
    const space = text.indexOf(' ');
    const cmd = (space === -1 ? text : text.slice(0, space)).toLowerCase();
    const args = space === -1 ? '' : text.slice(space + 1);
    if (await handleCommand(cmd, args, chatId)) return;
  }

  // Resolve target agent. Priority order:
  //   1. existing binding   (sticks until /project or /agent change)
  //   2. pendingAgent       (set by /project when the project has a
  //                          defaultAgentSId; consumed on createBinding)
  //   3. global default     (cfg.telegramDefaultAgentSId)
  const binding = await resolveBinding(chatId);
  const agentSId =
    binding?.agentSId ??
    pendingAgent.get(chatId) ??
    cfg.telegramDefaultAgentSId;
  if (!agentSId) {
    await sendMessage(
      chatId,
      'No default agent configured. Run /agent <sId> first (find the sId in the KDust agents settings or on dust.tt).',
    );
    return;
  }

  // Abort any previous in-flight stream for this chat. Users
  // re-typing a question while the agent is still answering
  // expect the new turn to take over.
  const previous = inFlight.get(chatId);
  if (previous) {
    previous.abort();
    inFlight.delete(chatId);
  }

  await sendChatAction(chatId, 'typing').catch(() => {
    /* non-fatal */
  });

  // Resolve project context (sticky on the binding, falling back
  // to the pending choice from a `/project` issued before any
  // conversation existed). Then ensure the per-project MCP
  // servers (fs-cli + task-runner-chat) so the agent gets its
  // file system / orchestration tools on this turn.
  const projectName =
    binding?.projectName ?? pendingProject.get(chatId) ?? null;
  const mcpServerIds = await resolveMcpServerIds(projectName);

  try {
    let stream: { conversation: import('@dust-tt/client').ConversationPublicType; userMessageSId: string; conversationId: string };
    if (!binding) {
      const created = await createBinding(
        chatId,
        agentSId,
        null,
        text,
        projectName,
        mcpServerIds,
      );
      // Pending choices consumed; the binding row now carries
      // both the project tenant and the resolved agent.
      pendingProject.delete(chatId);
      pendingAgent.delete(chatId);
      stream = {
        conversation: created.dustConversation,
        userMessageSId: created.userMessageSId,
        conversationId: created.conv.id,
      };
    } else {
      // Existing binding: post a follow-up message on the bound
      // Dust conversation. We refresh the conversation object
      // (postUserMessage already does this internally and
      // returns it on the result).
      const dustConvSId = binding.conversation.dustConversationSId;
      if (!dustConvSId) {
        // Defensive: a binding should always reference a Dust
        // conv. Drop and retry as a fresh binding.
        await dropBinding(chatId);
        const created = await createBinding(
          chatId,
          agentSId,
          null,
          text,
          projectName,
          mcpServerIds,
        );
        pendingProject.delete(chatId);
        pendingAgent.delete(chatId);
        stream = {
          conversation: created.dustConversation,
          userMessageSId: created.userMessageSId,
          conversationId: created.conv.id,
        };
      } else {
        const r = await postUserMessage(
          dustConvSId,
          agentSId,
          text,
          mcpServerIds,
          'cli',
        );
        await db.message.create({
          data: {
            conversationId: binding.conversationId,
            role: 'user',
            content: text,
          },
        });
        stream = {
          conversation: r.conversation,
          userMessageSId: r.userMessageSId,
          conversationId: binding.conversationId,
        };
      }
    }

    // Send a placeholder message we'll edit as tokens stream in.
    // Empty body would 400, so put a single character.
    const placeholder = await sendMessage(chatId, '…');
    const placeholderId = placeholder.message_id;

    const ac = new AbortController();
    inFlight.set(chatId, ac);

    let buffer = '';
    let lastEditAt = 0;
    let lastSent = '';
    const flush = async (final: boolean) => {
      const now = Date.now();
      if (!final && now - lastEditAt < EDIT_INTERVAL_MS) return;
      // Telegram throws 400 when the new text equals the previous
      // one ("message is not modified"). Skip edit when nothing
      // changed, but still update the timestamp so we don't spin.
      const text = buffer.length > 0 ? buffer : '\u2026';
      if (text === lastSent) {
        lastEditAt = now;
        return;
      }
      lastEditAt = now;
      lastSent = text;
      // Render markdown \u2192 Telegram-HTML so bold / code / links
      // appear formatted instead of as their raw markdown
      // source. The converter is robust to mid-stream chunks
      // (unclosed constructs leak through as plain text), but a
      // pathological input could still trip Telegram's HTML
      // parser \u2014 in that case we fall back to plain text so the
      // user always sees SOMETHING, never an empty edit.
      const html = markdownToTelegramHtml(text);
      try {
        await editMessageText(chatId, placeholderId, html, {
          parse_mode: 'HTML',
        });
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === 429) {
          lastEditAt = now + 2000;
        } else if (
          code === 400 &&
          /parse|entities|tag/i.test(
            e instanceof Error ? e.message : String(e),
          )
        ) {
          // HTML parse error \u2014 retry the same content as plain
          // text. Mark the buffer as plain so subsequent diffs
          // don't keep failing the same way.
          try {
            await editMessageText(chatId, placeholderId, text);
          } catch (e2) {
            console.warn(
              `[telegram] editMessageText fallback: ${
                e2 instanceof Error ? e2.message : e2
              }`,
            );
          }
        } else {
          console.warn(
            `[telegram] editMessageText: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    };

    const startedAt = Date.now();
    const { content, stats } = await streamAgentReply(
      stream.conversation,
      stream.userMessageSId,
      ac.signal,
      (kind, data) => {
        if (kind === 'token') {
          buffer += data;
          // Fire-and-forget; we'll await flush(true) at the end.
          void flush(false);
        } else if (kind === 'error') {
          buffer += `\n\n⚠️ ${data}`;
        }
      },
    );
    buffer = content || buffer || '(empty reply)';
    await flush(true);

    // Persist the agent reply on the local Conversation so the
    // web UI shows the same history.
    await db.message.create({
      data: {
        conversationId: stream.conversationId,
        role: 'agent',
        content,
        streamStats: JSON.stringify(stats.eventCounts),
        toolCalls: stats.toolCalls,
        toolNames: JSON.stringify(stats.toolNames),
        durationMs: stats.durationMs,
      },
    });
    await db.telegramBinding.update({
      where: { chatId },
      data: { lastActivityAt: new Date() },
    });
    console.log(
      `[telegram] chat=${chatId} replied in ${Date.now() - startedAt}ms tools=${stats.toolCalls}`,
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      await sendMessage(chatId, '🛑 Stopped.').catch(() => undefined);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] chat=${chatId} failed: ${msg}`);
    await sendMessage(chatId, `❌ ${msg.slice(0, 500)}`).catch(() => undefined);
  } finally {
    inFlight.delete(chatId);
  }
}
