import { getDustClient } from './client';

export interface StartMessageResult {
  dustConversationSId: string;
  userMessageSId: string;
  conversation: any; // ConversationPublicType (pour streamAgentAnswerEvents)
}

function userContext(mcpServerIds?: string[] | null) {
  return {
    username: 'kdust',
    timezone: 'Europe/Paris',
    email: null,
    fullName: 'KDust',
    profilePictureUrl: null,
    origin: 'api' as const,
    clientSideMCPServerIds: mcpServerIds && mcpServerIds.length > 0 ? mcpServerIds : null,
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
): Promise<StartMessageResult> {
  const ctx = await getDustClient();
  if (!ctx) throw new Error('Dust not connected');

  console.log(
    `[chat] createConversation agentSId=${agentSId} mcpServerIds=${JSON.stringify(mcpServerIds ?? null)}`,
  );

  const res = await ctx.client.createConversation({
    title: title ?? null,
    visibility: 'unlisted',
    message: {
      content,
      mentions: [{ configurationId: agentSId }],
      context: userContext(mcpServerIds),
    },
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
): Promise<StartMessageResult> {
  const ctx = await getDustClient();
  if (!ctx) throw new Error('Dust not connected');

  console.log(
    `[chat] postUserMessage conv=${dustConversationSId} agentSId=${agentSId} mcpServerIds=${JSON.stringify(mcpServerIds ?? null)}`,
  );

  const res = await ctx.client.postUserMessage({
    conversationId: dustConversationSId,
    message: {
      content,
      mentions: [{ configurationId: agentSId }],
      context: userContext(mcpServerIds),
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
 * Stream les événements de l'agent en réponse à un message utilisateur.
 * Appelle `onToken` pour chaque delta de texte et retourne la réponse finale complète.
 */
export async function streamAgentReply(
  conversation: any,
  userMessageSId: string,
  signal: AbortSignal,
  onEvent: (
    kind: 'token' | 'cot' | 'error' | 'done' | 'tool_call' | 'agent_message_id',
    data: string,
  ) => void,
): Promise<string> {
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
        return finalContent;
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
  return finalContent;
}
