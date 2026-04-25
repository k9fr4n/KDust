import ChatClient from '../_ChatClient';

/**
 * /chat/[id] — deep-link to a specific conversation.
 *
 * Thin server-component shell that forwards `params.id` to the
 * shared client component as the initial conversation to load.
 * Counterpart to /chat/page.tsx (no id case). Franck 2026-04-25
 * 11:43.
 */
export default async function ChatDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ChatClient initialConversationId={id} />;
}
