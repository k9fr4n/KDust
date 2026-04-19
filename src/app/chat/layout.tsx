/**
 * /chat layout — project scope is OPTIONAL.
 *
 * Until Franck 2026-04-19 17:48 this layout redirected to the
 * dashboard whenever no project cookie was set ("All Projects").
 * We removed that guard so users can hold a project-less chat
 * session:
 *   - no project cookie        → new conversations are created
 *     with Conversation.projectName = null (supported by the
 *     schema, column is String?)
 *   - fs/git tools              → auto-disabled server-side for
 *     null-project convs (see src/lib/dust/chat.ts MCP mount)
 *   - ProjectSwitcher still visible — user can opt back into a
 *     project at any time; switching mid-conv is handled by the
 *     existing "conversation project != current project" sync
 *     branch in /chat/page.tsx (~L168).
 *
 * Rendered as a passthrough server component (no props, no data
 * fetching) so Next can still stream the client /chat/page.
 */
export const dynamic = 'force-dynamic';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
