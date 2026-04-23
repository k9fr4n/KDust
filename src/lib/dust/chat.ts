import { getDustClient } from './client';

export interface StartMessageResult {
  dustConversationSId: string;
  userMessageSId: string;
  conversation: any; // ConversationPublicType (pour streamAgentAnswerEvents)
}

/**
 * Non-programmatic message origins only. Dust's billing policy splits
 * message origins in two buckets:
 *
 *   PROGRAMMATIC (billed as API / `-m` equivalent, consumes credits):
 *     - 'api'
 *     - 'cli_programmatic'       (dust-cli `--message` / `-m`)
 *     - 'triggered_programmatic'
 *
 *   HUMAN USAGE (counted against the user's seat, NOT billed as API):
 *     - 'web'        \u2190 web UI chat
 *     - 'cli'        \u2190 dust-cli interactive TUI
 *     - 'triggered'  \u2190 a schedule / workflow fired (human-like usage)
 *     - 'extension', 'slack', 'teams', \u2026
 *
 * We **blacklist** the programmatic variants at the type level so no
 * future refactor can re-introduce the `-m` billing equivalent by
 * accident. Callers must pick a value from `NonBilledOrigin`.
 */
// Policy 2026-04-18: KDust only ever emits 'cli'.
// - 'web' is rejected by the API since 2026-04-18 (non-web clients forbidden).
// - 'cli_programmatic' / 'api' / 'triggered_programmatic' land in the
//   billed-API bucket (same as dust -m). Not wanted — all KDust runs
//   are human-triggered, even the scheduled ones.
// Matches the Dust CLI v0.4.5 interactive TUI (human usage bucket).
export type NonBilledOrigin = 'cli';

/**
 * At runtime, defense-in-depth: if somebody bypasses the type system
 * (e.g. an `as any` cast or a string coming from the wire), we refuse
 * to forward programmatic origins to Dust and fall back to 'web'.
 */
// Runtime guard: if any caller somehow passes a non-'cli' string
// (bug / wire input / as-any cast), log it loudly and coerce back to
// 'cli'. This keeps the billing bucket locked to the human side.
const FORBIDDEN_ORIGINS = new Set([
  'api',
  'cli_programmatic',
  'triggered_programmatic',
  'web',
]);

function safeOrigin(o: string | undefined | null): NonBilledOrigin {
  if (o && o !== 'cli') {
    console.warn(
      `[chat] coercing origin="${o}" -> 'cli' (only human bucket allowed${
        FORBIDDEN_ORIGINS.has(o) ? '; explicitly forbidden' : ''
      })`,
    );
  }
  return 'cli';
}

function userContext(
  mcpServerIds?: string[] | null,
  origin: NonBilledOrigin = 'cli',
) {
  return {
    username: 'kdust',
    timezone: 'Europe/Paris',
    email: null,
    fullName: 'KDust',
    profilePictureUrl: null,
    // Always 'cli' (human usage bucket, matches Dust CLI interactive
    // TUI). Verified against dust-cli v0.4.5 dist/index.js.
    // Previously omitted (2026-04-18 morning) after Dust started
    // rejecting origin="web" with 400; explicit 'cli' is the
    // correct fix confirmed by inspecting the official CLI source.
    origin: safeOrigin(origin),
    clientSideMCPServerIds:
      mcpServerIds && mcpServerIds.length > 0 ? mcpServerIds : null,
    selectedMCPServerViewIds: null,
    lastTriggerRunAt: null,
  };
}

/** Crée une nouvelle conversation Dust avec un premier message utilisateur. */
export async function createDustConversation(
  agentSId: string,
  content: string,
  title?: string | null,
  mcpServerIds?: string[] | null,
  /**
   * Message origin. Restricted to NON-programmatic values so KDust is
   * never billed like the CLI's `-m` flag. Defaults to 'web' (matches
   * the /chat UI); the cron runner overrides with 'triggered' to
   * signal schedule-driven but still human-billed usage.
   */
  origin: NonBilledOrigin = 'cli',
  /**
   * Pre-uploaded Dust file ids (from POST /api/files/upload) to
   * attach as content fragments to the first user message. Each
   * fid is packaged as a `{fileId, title}` entry; Dust handles the
   * server-side wire-up so the agent can reference them.
   */
  fileIds?: string[] | null,
  /**
   * Optional metadata for the files \u2014 used to set a human-readable
   * title on each content fragment. If absent, we fall back to
   * 'Attachment'. Keep it optional so callers without that info
   * still work.
   */
  fileMetas?: Array<{ sId: string; name: string }> | null,
): Promise<StartMessageResult> {
  const ctx = await getDustClient();
  if (!ctx) throw new Error('Dust not connected');

  console.log(
    `[chat] createConversation agentSId=${agentSId} origin=${origin} mcpServerIds=${JSON.stringify(mcpServerIds ?? null)}`,
  );

  // Attachments (Franck 2026-04-23 16:59): for each pre-uploaded
  // Dust file id, build a content fragment that Dust will attach
  // to the conversation alongside the user message. Title is the
  // filename if the caller passed one; falls back to 'Attachment'.
  const contentFragments =
    fileIds && fileIds.length > 0
      ? fileIds.map((fid) => {
          const meta = fileMetas?.find((m) => m.sId === fid);
          return {
            fileId: fid,
            title: meta?.name ?? 'Attachment',
          };
        })
      : undefined;

  const res = await ctx.client.createConversation({
    title: title ?? null,
    visibility: 'unlisted',
    message: {
      content,
      mentions: [{ configurationId: agentSId }],
      context: userContext(mcpServerIds, origin),
    },
    contentFragments,
    blocking: false,
  });
  if (res.isErr()) throw new Error(`Dust createConversation: ${res.error.message}`);
  const { conversation, message } = res.value;
  return {
    dustConversationSId: conversation.sId,
    userMessageSId: message!.sId,
    conversation,
  };
}

/** Poste un message utilisateur supplémentaire dans une conversation Dust existante. */
export async function postUserMessage(
  dustConversationSId: string,
  agentSId: string,
  content: string,
  mcpServerIds?: string[] | null,
  /** See createDustConversation for origin billing policy. */
  origin: NonBilledOrigin = 'cli',
  /** Pre-uploaded Dust file ids to attach. See createDustConversation. */
  fileIds?: string[] | null,
  /** Optional filename metadata; used for human-readable fragment titles. */
  fileMetas?: Array<{ sId: string; name: string }> | null,
): Promise<StartMessageResult> {
  const ctx = await getDustClient();
  if (!ctx) throw new Error('Dust not connected');

  console.log(
    `[chat] postUserMessage conv=${dustConversationSId} agentSId=${agentSId} origin=${origin} mcpServerIds=${JSON.stringify(mcpServerIds ?? null)} fileIds=${JSON.stringify(fileIds ?? null)}`,
  );

  // Attachments: Dust requires content fragments to exist before
  // the user message is posted so they're threaded onto the same
  // turn. Post them sequentially; sequential is fine because the
  // user typically attaches 1-3 files and we already serialised
  // the upload itself in /api/files/upload.
  if (fileIds && fileIds.length > 0) {
    for (const fid of fileIds) {
      const meta = fileMetas?.find((m) => m.sId === fid);
      const cfRes = await ctx.client.postContentFragment({
        conversationId: dustConversationSId,
        contentFragment: { fileId: fid, title: meta?.name ?? 'Attachment' },
      });
      if (cfRes.isErr()) {
        throw new Error(`Dust postContentFragment(${fid}): ${cfRes.error.message}`);
      }
    }
  }

  const res = await ctx.client.postUserMessage({
    conversationId: dustConversationSId,
    message: {
      content,
      mentions: [{ configurationId: agentSId }],
      context: userContext(mcpServerIds, origin),
    },
  });
  if (res.isErr()) throw new Error(`Dust postUserMessage: ${res.error.message}`);
  const userMessage = res.value;

  // On refetch la conversation pour avoir l'objet complet attendu par streamAgentAnswerEvents
  const convRes = await ctx.client.getConversation({ conversationId: dustConversationSId });
  if (convRes.isErr()) throw new Error(`Dust getConversation: ${convRes.error.message}`);

  return {
    dustConversationSId,
    userMessageSId: userMessage.sId,
    conversation: convRes.value,
  };
}

/**
 * Observability payload surfaced when the stream ends. Persisted on
 * the corresponding agent Message row by the callers, so /settings/usage
 * can aggregate per-day / per-tool / per-conversation.
 *
 * `eventCounts` mirrors the console log's event-counts map exactly
 * (every event type Dust emitted during this turn with its cardinality).
 * It's a superset of the specialised counters (`toolCalls`, `genEvents`)
 * which are just pre-extracted for index-friendly SUM queries.
 */
export interface StreamStats {
  eventCounts: Record<string, number>;
  toolCalls: number;
  toolNames: string[];
  genEvents: number; // alias of eventCounts.generation_tokens for convenience
  durationMs: number;
}

/**
 * Stream les événements de l'agent en réponse à un message utilisateur.
 * Appelle `onToken` pour chaque delta de texte et retourne la réponse finale complète.
 *
 * Returns the final text AND a StreamStats object capturing the event
 * traffic observed during the stream. The stats are advisory — they
 * are NOT the authoritative LLM token count (Dust doesn't expose
 * usage metadata on this endpoint) but they give a faithful picture
 * of what the agent did: # of tool calls, which tools, stream
 * duration, per-event-type cardinality.
 */
export async function streamAgentReply(
  conversation: any,
  userMessageSId: string,
  signal: AbortSignal,
  onEvent: (
    kind: 'token' | 'cot' | 'error' | 'done' | 'tool_call' | 'agent_message_id',
    data: string,
  ) => void,
): Promise<{ content: string; stats: StreamStats }> {
  const ctx = await getDustClient();
  if (!ctx) throw new Error('Dust not connected');

  const streamRes = await ctx.client.streamAgentAnswerEvents({
    conversation,
    userMessageId: userMessageSId,
    signal,
  });
  if (streamRes.isErr())
    throw new Error(`Dust streamAgentAnswerEvents: ${(streamRes.error as any).message}`);

  let finalContent = '';
  let agentMessageSIdEmitted = false;
  const seenTypes = new Map<string, number>();
  // Distinct MCP tool names (preserves first-seen order for the UI).
  const toolNamesSet = new Set<string>();
  const startedAt = Date.now();
  const buildStats = (): StreamStats => ({
    eventCounts: Object.fromEntries(seenTypes.entries()),
    toolCalls: seenTypes.get('tool_call_started') ?? 0,
    toolNames: Array.from(toolNamesSet),
    genEvents: seenTypes.get('generation_tokens') ?? 0,
    durationMs: Date.now() - startedAt,
  });
  const maybeEmitAgentMessageId = (ev: any) => {
    if (agentMessageSIdEmitted) return;
    const mid = ev?.messageId ?? ev?.message?.sId;
    if (typeof mid === 'string' && mid.length > 0) {
      agentMessageSIdEmitted = true;
      onEvent('agent_message_id', mid);
    }
  };

  for await (const event of streamRes.value.eventStream) {
    if (signal.aborted) break;
    if (!event) continue;

    const et = (event as any).type;
    seenTypes.set(et, (seenTypes.get(et) ?? 0) + 1);
    // Debug: log every event type once (and tool-related events always) to diagnose MCP wiring
    if (et?.startsWith('tool_') || et === 'agent_action_success' || seenTypes.get(et) === 1) {
      console.log(`[chat/stream] event=${et}`, JSON.stringify(event).slice(0, 500));
    }

    // Any event that references the agent message gives us its sId.
    // Emit once so the client/cancel endpoint can target it.
    maybeEmitAgentMessageId(event);

    switch (et) {
      case 'generation_tokens': {
        const ev: any = event;
        // Dust streams 4 classifications: tokens, chain_of_thought,
        // opening_delimiter, closing_delimiter. The delimiters also carry text
        // (typically markdown wrappers around tool calls / citations) and must
        // be appended to the output, otherwise word boundaries get merged
        // ("le README" -> "leREADME").
        if (
          ev.classification === 'tokens' ||
          ev.classification === 'opening_delimiter' ||
          ev.classification === 'closing_delimiter'
        ) {
          finalContent += ev.text;
          onEvent('token', ev.text);
        } else if (ev.classification === 'chain_of_thought') {
          onEvent('cot', ev.text);
        }
        break;
      }
      case 'tool_approve_execution': {
        // Auto-approve MCP tool calls so the agent can actually use the fs tools.
        // Without this, the agent waits for approval forever and aborts.
        const ev: any = event;
        onEvent(
          'tool_call',
          JSON.stringify({
            tool: ev.metadata?.toolName ?? ev.toolName ?? 'tool',
            params: ev.inputs ?? ev.metadata?.inputs ?? null,
          }),
        );
        try {
          await ctx.client.validateAction({
            conversationId: ev.conversationId,
            messageId: ev.messageId,
            actionId: ev.actionId,
            approved: 'approved',
          });
        } catch (err) {
          onEvent(
            'error',
            `Failed to approve tool action: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        break;
      }
      case 'agent_message_success': {
        const ev: any = event;
        if (ev.message?.content) finalContent = ev.message.content;
        console.log(
          '[chat/stream] done. event counts:',
          Object.fromEntries(seenTypes.entries()),
        );
        onEvent('done', finalContent);
        return { content: finalContent, stats: buildStats() };
      }
      case 'agent_error':
      case 'user_message_error': {
        const ev: any = event;
        onEvent('error', ev.error?.message ?? 'agent error');
        throw new Error(ev.error?.message ?? 'agent error');
      }
    }
  }
  onEvent('done', finalContent);
  return { content: finalContent, stats: buildStats() };
}
