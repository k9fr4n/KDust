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
  toolInvocationsToJson,
  generatedFilesToJson,
  timelineToJson,
  type StreamStats,
} from '../../../dust/chat';
import { getDustClient } from '../../../dust/client';
import { readAttachmentBytes } from '../../../task-attachments';
import type { ResolvedBranchPolicy } from '../../../branch-policy';
import type { RunPhase } from '../../phases';
import type { AbortReason } from '../abort';
import { abortReasonDetail } from '../abort';
import { buildAutomationPrompt } from '../prompt';
import { resolveRunTimeoutMs } from '../timeout';
import { registerActiveRun, unregisterActiveRun } from '../registry';
import type { NotifyFn } from '../notify';

/**
 * Format a Date in the given IANA timezone as
 * "YYYY-MM-DD HH:mm:ss <tz>". Uses the `sv-SE` locale because it
 * produces an ISO-like ordering with `-` and `:` separators
 * (en-CA / en-GB give similar but slightly different shapes;
 * sv-SE is the established "ISO-ish locale" trick).
 *
 * Falls back to `toISOString()` if `Intl.DateTimeFormat` throws on
 * an invalid timezone — defensive against a future hand-edited row
 * slipping through validation.
 */
function formatLocalTimestamp(d: Date, tz: string): string {
  try {
    const s = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
    return `${s} ${tz}`;
  } catch {
    return d.toISOString();
  }
}

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
    // Forwarded to resolveRunTimeoutMs (./runner/timeout.ts).
    // Per-task wall-clock cap; null = inherit AppConfig default.
    maxRuntimeMs: number | null;
    commandRunnerEnabled: boolean;
    /**
     * IANA timezone of the task (Task.timezone, NOT NULL, default
     * "Europe/Paris"). Used to format the human-facing timestamp
     * embedded in the Dust conversation title — `toISOString()`
     * was misleading because it always rendered UTC even though
     * the schedule and the user's mental model are local.
     */
    timezone: string;
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

  // ADR-0016: skill discovery is uniform across task and chat
  // mode -- the agent calls list_skills via the skills MCP server
  // (registered by setup-mcp when TaskSkill has any binding).
  // No catalogue injection in the prompt; the tool description on
  // list_skills is what cues the agent to call it. Matches the
  // existing task-runner pattern (list_tasks).

  await setPhase('agent', `Agent ${job.agentName ?? job.agentSId} is thinking…`);
  // Conversation title shown in the Dust UI. No "[cron]" prefix
  // (Franck 2026-04-21 11:44): the marker was redundant — KDust
  // conversations are already filterable by their origin=cli tag
  // and the noise polluted the Dust conversation list.
  //
  // Timestamp formatted in the task's local timezone (Franck
  // 2026-05-11): `toISOString()` rendered UTC, which contradicted
  // both the schedule (interpreted in Task.timezone) and the
  // user's mental model. `sv-SE` locale yields an ISO-like
  // "YYYY-MM-DD HH:mm:ss" shape; we suffix the IANA name to keep
  // the title self-describing across multi-TZ deployments.
  const convTitle = `${job.name} @ ${formatLocalTimestamp(new Date(), job.timezone)}`;
  // Enrich the prompt with the KDust automation-context footer when
  // pushEnabled is true. When false, send the prompt as-is (see
  // buildAutomationPrompt above). Per Franck 2026-04-19 00:36.
  // Note: buildAutomationPrompt reads `prompt` off the passed object,
  // so we shadow job.prompt with effectivePrompt for the footer to
  // wrap the overridden prompt when invoked via task-runner.
  const agentPrompt = buildAutomationPrompt({ ...job, prompt: effectivePrompt }, policy);

  // Task attachments (Franck 2026-05-09). Fetch the persistent file
  // list and re-upload each blob to Dust so the agent receives them
  // as content fragments on the first user message. Dust file ids
  // are short-lived (per-conversation), so persisting bytes locally
  // and re-uploading at run-time is the only way to keep them alive
  // across cron ticks. Failures here are FATAL for the run: the
  // user attached the file expecting it to be there.
  const attachmentRows = await db.taskAttachment.findMany({
    where: { taskId: job.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      filename: true,
      contentType: true,
      sizeBytes: true,
      storagePath: true,
    },
  });
  let attachmentFileIds: string[] | undefined;
  let attachmentFileMetas: Array<{ sId: string; name: string }> | undefined;
  if (attachmentRows.length > 0) {
    const dust = await getDustClient();
    if (!dust) throw new Error('Dust not connected (task has attachments)');
    attachmentFileIds = [];
    attachmentFileMetas = [];
    for (const att of attachmentRows) {
      const bytes = await readAttachmentBytes(att.storagePath);
      // Build a File from the buffer so the SDK can stream it back
      // with the original filename + content-type. contentType was
      // already normalised at upload time (see normaliseContentType
      // in src/lib/dust/content-type.ts) so it matches Dust's union.
      const fileObject = new File([bytes], att.filename, { type: att.contentType });
      const r = await dust.client.uploadFile({
        contentType: att.contentType as Parameters<typeof dust.client.uploadFile>[0]['contentType'],
        fileName: att.filename,
        fileSize: att.sizeBytes,
        useCase: 'conversation',
        fileObject,
      });
      if (r.isErr()) {
        throw new Error(
          `attachment upload to Dust failed (${att.filename}): ${r.error?.message ?? 'unknown'}`,
        );
      }
      attachmentFileIds.push(r.value.sId);
      attachmentFileMetas.push({ sId: r.value.sId, name: att.filename });
    }
    console.log(
      `[runner] task=${job.id} re-uploaded ${attachmentFileIds.length} attachment(s) to Dust`,
    );
  }

  const conv = await createDustConversation(
    job.agentSId,
    agentPrompt,
    convTitle,
    mcpServerIds,
    'cli',
    attachmentFileIds ?? null,
    attachmentFileMetas ?? null,
  );
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
              toolInvocations: agentStats
                ? toolInvocationsToJson(agentStats.toolInvocations)
                : null,
              generatedFiles: agentStats
                ? generatedFilesToJson(agentStats.generatedFiles)
                : null,
              timeline: agentStats
                ? timelineToJson(agentStats.timeline)
                : null,
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
              toolInvocations: agentStats
                ? toolInvocationsToJson(agentStats.toolInvocations)
                : null,
              generatedFiles: agentStats
                ? generatedFilesToJson(agentStats.generatedFiles)
                : null,
              timeline: agentStats
                ? timelineToJson(agentStats.timeline)
                : null,
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

    // [5b.1] Deferred chain successor dispatch for prompt-only runs
    // (ADR-0009 amendment, 2026-05-05c). The prompt-only branch
    // short-circuits the full pipeline (no diff/commit/push/
    // notify-success), so it never reached the dispatch site in
    // runner.ts. Many chain orchestrators (windows-resource etc.)
    // run pushEnabled=false and rely on enqueue_followup to chain
    // forward; without this call their successor stays stuck in
    // pendingFollowupTaskId forever.
    //
    // Dynamic import to avoid an import cycle
    // run-agent.ts -> runner.ts -> run-agent.ts.
    try {
      const { dispatchPendingFollowup } = await import('../../runner');
      await dispatchPendingFollowup(runId, job.name);
    } catch (e) {
      console.error(
        `[cron] prompt-only followup dispatch failed for run=${runId}: ${(e as Error)?.message ?? e}`,
      );
    }

    return { ok: false, runId };
  }

  return { ok: true, agentText, agentStats };
}
