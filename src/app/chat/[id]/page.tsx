import { db } from '@/lib/db';
import ChatClient from '../_ChatClient';

/**
 * /chat/[id] — deep-link to a specific conversation.
 *
 * Thin server-component shell that forwards `params.id` to the
 * shared client component as the initial conversation to load.
 * Counterpart to /chat/page.tsx (no id case). Franck 2026-04-25
 * 11:43.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> },
): Promise<import('next').Metadata> {
  const { id } = await params;
  // The route param may be either the internal Conversation.id or
  // the upstream Dust sId — accept both so the tab title resolves
  // for every deep link.
  const conv = await db.conversation.findFirst({
    where: { OR: [{ id }, { dustConversationSId: id }] },
    select: { title: true },
  });
  return { title: conv?.title?.trim() ? conv.title : 'Chat' };
}

export default async function ChatDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ChatClient initialConversationId={id} />;
}
