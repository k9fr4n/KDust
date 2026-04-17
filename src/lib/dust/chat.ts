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
  onEvent: (kind: 'token' | 'cot' | 'error' | 'done', data: string) => void,
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

  for await (const event of streamRes.value.eventStream) {
    if (signal.aborted) break;
    if (!event) continue;

    switch ((event as any).type) {
      case 'generation_tokens': {
        const ev: any = event;
        if (ev.classification === 'tokens') {
          finalContent += ev.text;
          onEvent('token', ev.text);
        } else if (ev.classification === 'chain_of_thought') {
          onEvent('cot', ev.text);
        }
        break;
      }
      case 'agent_message_success': {
        const ev: any = event;
        if (ev.message?.content) finalContent = ev.message.content;
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
