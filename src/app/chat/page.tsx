import ChatClient from './_ChatClient';

/**
 * /chat — fresh chat surface (no conversation pre-selected).
 *
 * Thin server-component shell that delegates to the shared
 * client component with initialConversationId=null. The matching
 * dynamic route /chat/[id]/page.tsx passes the params.id instead.
 * Both shells exist so the address bar reflects the active
 * conversation without a query string. Franck 2026-04-25 11:43.
 */
export default function ChatRootPage() {
  return <ChatClient initialConversationId={null} />;
}
