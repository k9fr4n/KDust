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
  type TgMessage,
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
          '/agent <sId>    switch agent (also resets the conversation)',
          '/projects       list available projects',
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
      const lines = projects.map((p) =>
        binding?.projectName === p.name ? `• ${p.name}  (current)` : `• ${p.name}`,
      );
      await sendMessage(
        chatId,
        ['Projects:', ...lines, '', 'Use /project <name> to switch.'].join('\n'),
      );
      return true;
    }
    case '/project': {
      const requested = args.trim();
      if (requested === '') {
        // Clear: drop binding + pending choice. Next message
        // starts in global mode (no fs tools).
        await dropBinding(chatId);
        pendingProject.delete(chatId);
        await sendMessage(
          chatId,
          '\u2705 Project cleared. The next message starts a fresh conversation in global mode (no fs tools).',
        );
        return true;
      }
      const projects = await listProjects();
      const match = projects.find((p) => p.name === requested);
      if (!match) {
        await sendMessage(
          chatId,
          `\u274c Project "${requested}" not found. Run /projects for the list.`,
        );
        return true;
      }
      // Switching project resets the conversation: a fresh fs-cli
      // chroot makes any reuse of the previous Dust conv tool
      // history misleading (paths from the old project would
      // still be in context). The binding row will be recreated
      // on the next real user message; until then we remember
      // the project choice in the in-memory pending map so
      // createBinding() picks it up. The map is process-local
      // (not persisted) which is fine: on a restart the user can
      // simply re-run /project. Persisting it would require a
      // schema change since TelegramBinding has a mandatory
      // conversationId FK.
      await dropBinding(chatId);
      pendingProject.set(chatId, match.name);
      await sendMessage(
        chatId,
        `\u2705 Project set to ${match.name}. The next message starts a fresh conversation with fs tools chrooted on /projects/${match.name}.`,
      );
      return true;
    }
    case '/new': {
      await dropBinding(chatId);
      await sendMessage(chatId, '✅ New conversation. Send your message.');
      return true;
    }
    case '/agent': {
      const sId = args.trim().split(/\s+/)[0];
      if (!sId) {
        await sendMessage(chatId, 'Usage: /agent <agent_sId>');
        return true;
      }
      // Validate via Dust; cheap guard against typos.
      try {
        const ctx = await getDustClient();
        if (!ctx) throw new Error('Dust not connected');
        // Validate the sId against the visible agent list. Cheaper
        // than calling a single-agent endpoint AND avoids drift
        // when the SDK renames it between versions.
        const r = await ctx.client.getAgentConfigurations({});
        if (r.isErr()) throw new Error(r.error.message);
        const list = r.value as Array<{ sId: string }>;
        if (!list.some((a) => a.sId === sId)) {
          throw new Error('agent sId not visible to this user');
        }
      } catch (e) {
        await sendMessage(
          chatId,
          `❌ Agent ${sId} not found: ${e instanceof Error ? e.message : String(e)}`,
        );
        return true;
      }
      await dropBinding(chatId);
      // Stash the chosen agent on a fresh placeholder binding so
      // the next user message picks it up. Conversation row is
      // created lazily on first real message (no Dust call yet).
      await db.appConfig.update({
        where: { id: 1 },
        data: { telegramDefaultAgentSId: sId },
      });
      await sendMessage(
        chatId,
        `✅ Agent set to ${sId}. The next message starts a fresh conversation with this agent.`,
      );
      return true;
    }
    case '/whoami': {
      const binding = await resolveBinding(chatId);
      const cfg = await getAppConfig();
      const project =
        binding?.projectName ?? pendingProject.get(chatId) ?? null;
      await sendMessage(
        chatId,
        [
          `chat_id   : ${chatId}`,
          `agent     : ${binding?.agentSId ?? cfg.telegramDefaultAgentSId ?? '\u2014'}`,
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
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? '').trim();
  if (!text) return;

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
