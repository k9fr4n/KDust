// src/lib/cron/runner/phases/run-agent.ts
//
// Phase "runAgent" — Step F of ADR-0006.
//
// Phase [5] of the original runJob() pipeline + the prompt-only
// short-circuit (legacy [5b]). This is by far the heaviest single
// phase: ~250 lines covering Dust conversation creation, stream
// consumption with throttled DB flushes, abort handling, kill-timer
// management, conversation audit-trail persistence, and (when
// job.pushEnabled is false) full run completion.
//
// Discriminated return value:
//
//   { ok: false, runId }
//     pushEnabled=false short-circuit. The run is COMPLETE — a
//     'success' TaskRun row is already written, the Teams card
//     posted, the lastStatus updated. The caller must `return
//     runId;` immediately and not enter phases [6]..[10].
//     Pre-refactor: phase [5b] (Franck 2026-04-19).
//
//   { ok: true, agentText, agentStats }
//     Healthy continuation toward phase [6] (diff measurement).
//     The conversation audit-trail row is already in DB.
//
// Why these concerns belong together:
//   The Dust conversation lifecycle (create + stream + persist +
//   short-circuit) is one transactional unit from the user's
//   perspective: any one of these steps failing leaves the run
//   in the SAME state from the audit-trail and Teams-report
//   point of view. Splitting them across files would force four
//   different modules to share the conv handle, AbortController,
//   and partial-flush throttle — a worse seam than what we have.
//
// What is NOT in this phase (and stays in runner.ts for now):
//   - `agentText` declaration (kept at function scope because the
//     outer catch block reads it for the failure Teams card)
//   - `notify(…)` invocation imports the runner's bound notifier
//     (see runner/notify.ts) — the prompt-only branch calls it
//     directly. Step J will move the success-path notify out
//     uniformly.

import type { Project } from '@prisma/client';
import { db } from '../../../db';
import {
  createDustConversation,
  streamAgentReply,
  type StreamStats,
} from '../../../dust/chat';
import type { ResolvedBranchPolicy } from '../../../branch-policy';
import type { RunPhase } from '../../phases';
import type { AbortReason } from '../abort';
import { abortReasonDetail } from '../abort';
import { buildAutomationPrompt } from '../prompt';
import { resolveRunTimeoutMs } from '../timeout';
import { registerActiveRun, unregisterActiveRun } from '../registry';
import type { NotifyFn } from '../notify';

export interface RunAgentArgs {
  /** TaskRun id used for live-flush updates and abort registry. */
  runId: string;
  /** Original Task row, fields read from many places below. */
  job: {
    id: string;
    name: string;
    agentSId: string;
    agentName: string | null;
    pushEnabled: boolean;
    // Forwarded to buildAutomationPrompt:
    prompt: string;
    branchMode: string;
    branchPrefix: string | null;
    baseBranch: string | null;
    protectedBranches: string | null;
    dryRun: boolean;
    maxDiffLines: number;
    taskRunnerEnabled: boolean;
    commandRunnerEnabled: boolean;
  };
  /** Effective prompt: opts.promptOverride ?? job.prompt. */
  effectivePrompt: string;
  /** Resolved policy (B1/B2 applied) — fed to buildAutomationPrompt. */
  policy: ResolvedBranchPolicy;
  /** Project fsPath, stored on Conversation.projectName. */
  projectFsPath: string;
  /** Parent project row — used for the prompt-only Teams card. */
  project: Project;
  /** MCP server ids from phase [4], passed to createDustConversation. */
  mcpServerIds: string[] | null;
  /** Wall-clock when the run started — for the prompt-only duration. */
  startedAt: number;
  /** Phase setter bound to this TaskRun. */
  setPhase: (phase: RunPhase, message: string) => Promise<unknown>;
  /** Bound notifier (Teams + log buffer). See ../notify.ts NotifyFn. */
  notify: NotifyFn;
}

export type RunAgentResult =
  | { ok: false; runId: string }
  | { ok: true; agentText: string; agentStats: StreamStats | null };

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const {
    runId,
    job,
    effectivePrompt,
    policy,
    projectFsPath,
    project,
    mcpServerIds,
    startedAt,
    setPhase,
    notify,
  } = args;

  await setPhase('agent', `Agent ${job.agentName ?? job.agentSId} is thinking…`);
  // Conversation title shown in the Dust UI. No "[cron]" prefix
  // (Franck 2026-04-21 11:44): the marker was redundant — KDust
  // conversations are already filterable by their origin=cli tag
  // and the noise polluted the Dust conversation list.
  const convTitle = `${job.name} @ ${new Date().toISOString()}`;
  // Enrich the prompt with the KDust automation-context footer when
  // pushEnabled is true. When false, send the prompt as-is (see
  // buildAutomationPrompt above). Per Franck 2026-04-19 00:36.
  // Note: buildAutomationPrompt reads `prompt` off the passed object,
  // so we shadow job.prompt with effectivePrompt for the footer to
  // wrap the overridden prompt when invoked via task-runner.
  const agentPrompt = buildAutomationPrompt({ ...job, prompt: effectivePrompt }, policy);
  const conv = await createDustConversation(job.agentSId, agentPrompt, convTitle, mcpServerIds, 'cli');
  // Stamp the TaskRun with the Dust conversation sId ASAP so the
  // /run page can show a "Chat" link even if the run later fails
  // mid-stream. Fire-and-forget — not worth aborting for.
  db.taskRun
    .update({
      where: { id: runId },
      data: { dustConversationSId: conv.dustConversationSId },
    })
    .catch(() => {});
  // Create the local Conversation row early (Franck 2026-04-24
  // 18:51). Previously this happened only AFTER the agent stream
  // completed (~1-10 min later), so the /run/:id "Open chat"
  // button was hidden for the entire duration of the run. Now we
  // persist the conv + user message immediately; the agent
  // message is appended at the end of the stream. If the run
  // aborts mid-stream, the conversation still shows the user
  // prompt + whatever partial context existed — consistent with
  // what the user sees in Dust directly. Fire-and-forget by
  // design: any DB hiccup here must not block the run.
  db.conversation
    .upsert({
      where: { dustConversationSId: conv.dustConversationSId },
      create: {
        dustConversationSId: conv.dustConversationSId,
        agentSId: job.agentSId,
        agentName: job.agentName ?? null,
        title: convTitle,
        // Conversation.projectName stores the project's fsPath
        // post-migration (the column name is historical — kept
        // for back-compat). See app/api/projects/[id]/route.ts.
        projectName: projectFsPath,
        messages: { create: [{ role: 'user', content: agentPrompt }] },
      },
      update: {
        // Same conv re-used across multi-turn task is not our
        // current model, but be idempotent anyway.
        agentName: job.agentName ?? undefined,
        title: convTitle,
        projectName: projectFsPath,
      },
    })
    .catch((e) => {
      console.warn(`[runner] early conversation upsert failed: ${e}`);
    });
  const ac = new AbortController();
  // Register so the HTTP cancel endpoint can abort from outside this scope.
  registerActiveRun(runId, ac);
  // Wall-clock runtime cap. Resolution order + clamp range live
  // in ./runner/timeout.ts (kept testable on its own, called from
  // here once per run).
  const KILL_TIMER_MS = await resolveRunTimeoutMs(job);
  const killTimer = setTimeout(
    () => ac.abort({ kind: 'timeout', ms: KILL_TIMER_MS } satisfies AbortReason),
    KILL_TIMER_MS,
  );
  let streamErr: string | null = null;
  let agentText = '';

  // Periodically flush the partial agent output to DB so the /task/:id
  // page can show real-time streaming text (without needing an SSE route
  // of its own). Throttled to ~500ms to avoid hammering SQLite.
  //
  // Thinking capture (Franck 2026-04-24 18:51): Dust streams chain-
  // of-thought tokens as generation_tokens with
  // classification='chain_of_thought'. They're delivered through
  // the same onEvent callback under kind='cot'. We accumulate
  // them in `thinking` and flush alongside `partial` so the /run
  // detail page can surface the reasoning in a collapsible
  // section. Same 500ms throttle; a single flush writes both
  // columns to minimise SQLite write amplification.
  let partial = '';
  let thinking = '';
  let lastFlush = Date.now();
  const flushPartial = () => {
    db.taskRun
      .update({
        where: { id: runId },
        data: {
          output: partial,
          thinkingOutput: thinking ? thinking : null,
        },
      })
      .catch(() => { /* ignore */ });
  };
  let agentStats: StreamStats | null = null;
  try {
    const reply = await streamAgentReply(
      conv.conversation,
      conv.userMessageSId,
      ac.signal,
      (kind, payload) => {
        if (kind === 'error') streamErr = String(payload);
        if (kind === 'token') {
          partial += payload;
          const now = Date.now();
          if (now - lastFlush > 500) {
            lastFlush = now;
            flushPartial();
          }
        } else if (kind === 'cot') {
          // Chain-of-thought fragment. Same throttled-flush
          // policy as regular tokens — not worth a separate
          // timer since both columns share one DB row.
          thinking += payload;
          const now = Date.now();
          if (now - lastFlush > 500) {
            lastFlush = now;
            flushPartial();
          }
        }
      },
    );
    agentText = reply.content;
    agentStats = reply.stats;
    // Final flush so the last tokens are visible before we move to [6].
    partial = agentText;
    flushPartial();
  } finally {
    clearTimeout(killTimer);
    unregisterActiveRun(runId);
  }
  if (ac.signal.aborted) {
    const reason = ac.signal.reason as AbortReason | undefined;
    throw Object.assign(new Error(abortReasonDetail(reason)), {
      aborted: true,
      abortReason: reason,
    });
  }
  if (streamErr) throw new Error(`agent stream error: ${streamErr}`);
  if (!agentText.trim()) agentText = '(agent returned an empty response)';

  // Persist conversation (audit trail).
  //
  // The Conversation row + user message were created at the
  // BEGINNING of the Dust call (Franck 2026-04-24 18:51) so the
  // "Open chat" button on /run/:id is live from second one. Here
  // we only need to append the agent message with the final
  // content and the stream stats. Kept robust against the rare
  // case where the early upsert failed (e.g. DB hiccup): we
  // upsert again with just the conv fields, then append the
  // agent message either way.
  try {
    await db.conversation.upsert({
      where: { dustConversationSId: conv.dustConversationSId },
      create: {
        dustConversationSId: conv.dustConversationSId,
        agentSId: job.agentSId,
        agentName: job.agentName ?? null,
        title: convTitle,
        projectName: projectFsPath,
        // If we land here via the "create" branch, the early
        // upsert didn't happen — recreate the user message so
        // the audit trail still shows both sides of the
        // exchange.
        messages: {
          create: [
            { role: 'user', content: agentPrompt },
            {
              role: 'agent',
              content: agentText,
              streamStats: agentStats
                ? JSON.stringify(agentStats.eventCounts)
                : null,
              toolCalls: agentStats?.toolCalls ?? 0,
              toolNames: JSON.stringify(agentStats?.toolNames ?? []),
              durationMs: agentStats?.durationMs ?? null,
            },
          ],
        },
      },
      update: {
        // Normal path: row already exists with the user message.
        // Just append the agent message. We don't guard against
        // duplicate agent messages because a given run only
        // appends once here (no retry loop at this layer).
        messages: {
          create: [
            {
              role: 'agent',
              content: agentText,
              streamStats: agentStats
                ? JSON.stringify(agentStats.eventCounts)
                : null,
              toolCalls: agentStats?.toolCalls ?? 0,
              toolNames: JSON.stringify(agentStats?.toolNames ?? []),
              durationMs: agentStats?.durationMs ?? null,
            },
          ],
        },
      },
    });
  } catch (e) {
    console.warn(`[cron] could not persist conv: ${(e as Error).message}`);
  }

  // [5b] Prompt-only short-circuit -----------------------------------------
  // When pushEnabled=false, the task is a recurring prompt: we
  // captured the agent reply and persisted the conversation; we
  // must NOT touch git. Any files the agent happened to write via
  // fs-cli remain in the working tree (next sync on a different
  // task run will reset them — that is the expected behavior).
  // Mark the TaskRun as success and exit before the diff/commit/
  // push pipeline. Introduced 2026-04-19 with the pushEnabled flag.
  if (!job.pushEnabled) {
    const durationMs = Date.now() - startedAt;
    await db.taskRun.update({
      where: { id: runId },
      data: {
        status: 'success',
        phase: 'done' satisfies RunPhase,
        phaseMessage: 'Prompt-only (push disabled)',
        output: agentText,
        finishedAt: new Date(),
      },
    });
    await db.task.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastStatus: 'success' },
    });
    await notify(
      `\uD83D\uDCAC KDust task : ${job.name}`,
      `Prompt-only run on ${project.name} (push disabled)`,
      'success',
      [
        { name: 'Project', value: project.name },
        { name: 'Mode', value: 'prompt-only' },
        { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
      ],
      agentText.slice(0, 4000),
    );
    console.log(`[cron] success (prompt-only) job="${job.name}" duration=${durationMs}ms`);
    return { ok: false, runId };
  }

  return { ok: true, agentText, agentStats };
}
