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
 *   /new     — drop binding, next message starts a fresh conv
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
  if (agents.length === 0) {
    await sendMessage(chatId, 'No agents visible to this user.');
    return;
  }
  // Sort alphabetically for stable, predictable order.
  agents.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  const cfg = await getAppConfig();
  const binding = await resolveBinding(chatId);
  const currentSId =
    binding?.agentSId ?? cfg.telegramDefaultAgentSId ?? null;
  // 1 column, mark the current selection with a check.
  // Telegram caps inline_keyboard payloads at ~10kB; well under
  // for typical workspaces. If a workspace has >100 agents we
  // would need pagination \u2014 out of scope for v1.
  const buttons = agents.map((a) => [
    {
      text:
        (currentSId === a.sId ? '\u2705 ' : '') +
        (a.name.length > 50 ? a.name.slice(0, 47) + '\u2026' : a.name),
      callback_data: `agent:${a.sId}`.slice(0, 64),
    },
  ]);
  await sendMessage(chatId, 'Pick an agent:', {
    inline_keyboard: buttons,
  });
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
    return {
      ok: true,
      message:
        '\u2705 Project cleared. The next message starts a fresh ' +
        'conversation in global mode (no fs tools).',
    };
  }
  const projects = await listProjects();
  const match = projects.find((p) => p.name === projectName);
  if (!match) {
    return {
      ok: false,
      message: `\u274c Project "${projectName}" not found. Run /projects for the list.`,
    };
  }
  // Switching project resets the conversation: a fresh fs-cli
  // chroot makes any reuse of the previous Dust conv tool
  // history misleading. The binding row will be recreated on
  // the next real user message; until then we remember the
  // project choice in the in-memory pending map so
  // createBinding() picks it up.
  await dropBinding(chatId);
  pendingProject.set(chatId, match.name);
  return {
    ok: true,
    message:
      `\u2705 Project set to ${match.name}. The next message starts ` +
      `a fresh conversation with fs tools chrooted on ` +
      `/projects/${match.name}.`,
  };
}

/**
 * Dispatch a Telegram callback_query (inline keyboard button
 * tap). We always answer the query first to clear the spinner
 * on the client, then act on the encoded `data` field.
 *
 * Recognised callback_data formats:
 *   proj:<name>      switch to that project
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
async function handleCommand(
  cmd: string,
  args: string,
  chatId: string,
): Promise<boolean> {
  switch (cmd) {
    case '/start':
    case '/help': {
      await sendMessage(
        chatId,
        [
          'KDust bot — type a message to chat with your Dust agent.',
          '',
          '/new            start a fresh conversation',
          '/agents         pick an agent (clickable list)',
          '/agent <sId>    switch agent directly (also resets the conversation)',
          '/projects       pick a project (clickable list)',
          '/project <name> set the project context (fs tools chroot here)',
          '/project        clear project (global mode, no fs tools)',
          '/whoami         show chat id, agent, project, bound conv',
          '/stop           abort the current streaming reply',
          '/help           this message',
        ].join('\n'),
      );
      return true;
    }
    case '/projects': {
      const projects = await listProjects();
      if (projects.length === 0) {
        await sendMessage(chatId, 'No projects under /projects yet.');
        return true;
      }
      const binding = await resolveBinding(chatId);
      const current = binding?.projectName ?? null;
      // Build a 1-column inline keyboard (one button per
      // project). Telegram caps callback_data at 64 bytes; we
      // prefix with `proj:` so the dispatcher can route the
      // callback unambiguously, and we trust project names to
      // be short directory identifiers (no risk of overflow at
      // KDust\u2019s scale, but we truncate defensively).
      const buttons = projects.map((p) => [
        {
          text:
            (current === p.name ? '\u2705 ' : '') +
            (p.name.length > 50 ? p.name.slice(0, 47) + '\u2026' : p.name),
          callback_data: `proj:${p.name}`.slice(0, 64),
        },
      ]);
      // Add a "Clear / global" button at the bottom so the
      // user can drop the project context with one tap.
      buttons.push([
        {
          text: (current === null ? '\u2705 ' : '') + '\u2014 global (no project) \u2014',
          callback_data: 'proj:__clear__',
        },
      ]);
      await sendMessage(chatId, 'Pick a project:', {
        inline_keyboard: buttons,
      });
      return true;
    }
    case '/project': {
      const requested = args.trim();
      const result = await applyProjectChoice(chatId, requested || null);
      await sendMessage(chatId, result.message);
      return true;
    }
    case '/new': {
      await dropBinding(chatId);
      await sendMessage(chatId, '✅ New conversation. Send your message.');
      return true;
    }
    case '/agents':
    case '/agent': {
      const sId = args.trim().split(/\s+/)[0];
      if (!sId) {
        // No arg: render a clickable picker, same UX as
        // /projects. Tap a button \u2192 callback fires
        // applyAgentChoice() with the chosen sId.
        await sendAgentPicker(chatId);
        return true;
      }
      const result = await applyAgentChoice(chatId, sId);
      await sendMessage(chatId, result.message);
      return true;
    }
    case '/whoami': {
      const binding = await resolveBinding(chatId);
      const cfg = await getAppConfig();
      const project =
        binding?.projectName ?? pendingProject.get(chatId) ?? null;
      const agentSId = binding?.agentSId ?? cfg.telegramDefaultAgentSId ?? null;
      // Prefer the cached name on the Conversation row (set at
      // bind time). Fall back to a Dust lookup so the user
      // never sees a bare sId when the agent is resolvable.
      // Dust call is wrapped in try/catch \u2014 a transient outage
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
        : '\u2014';
      await sendMessage(
        chatId,
        [
          `chat_id   : ${chatId}`,
          `agent     : ${agentLine}`,
          `project   : ${project ?? '\u2014 (global)'}${
            !binding && project ? '  [pending]' : ''
          }`,
          `conv      : ${binding?.conversationId ?? '\u2014 (will be created on next message)'}`,
          `dust sId  : ${binding?.conversation?.dustConversationSId ?? '\u2014'}`,
        ].join('\n'),
      );
      return true;
    }
    case '/stop': {
      const ac = inFlight.get(chatId);
      if (ac) {
        ac.abort();
        await sendMessage(chatId, '🛑 Stopping...');
      } else {
        await sendMessage(chatId, 'Nothing to stop.');
      }
      return true;
    }
  }
  return false;
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

  // Resolve target agent: existing binding > AppConfig default.
  const binding = await resolveBinding(chatId);
  const agentSId = binding?.agentSId ?? cfg.telegramDefaultAgentSId;
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
    let stream: { conversation: unknown; userMessageSId: string; conversationId: string };
    if (!binding) {
      const created = await createBinding(
        chatId,
        agentSId,
        null,
        text,
        projectName,
        mcpServerIds,
      );
      // Pending choice consumed; the binding row now carries it.
      pendingProject.delete(chatId);
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
      const text = buffer.length > 0 ? buffer : '…';
      if (text === lastSent) {
        lastEditAt = now;
        return;
      }
      lastEditAt = now;
      lastSent = text;
      try {
        await editMessageText(chatId, placeholderId, text);
      } catch (e) {
        // 429 = rate limit; back off the next interval.
        const code = (e as { code?: number }).code;
        if (code === 429) lastEditAt = now + 2000;
        else
          console.warn(
            `[telegram] editMessageText: ${e instanceof Error ? e.message : e}`,
          );
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
