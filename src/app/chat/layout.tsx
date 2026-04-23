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
  // Padding cancel (Franck 2026-04-23 21:48). RootLayout wraps
  // every page in <main class="px-4 lg:px-6 py-6">. The chat
  // surface wants the full viewport width so the message area,
  // composer, and the merged toolbar reach the browser edges.
  // We negate the root padding with inverse margins and size the
  // wrapper explicitly to "viewport minus the sticky Nav (h-14)".
  //
  // Why negative margins rather than editing RootLayout:
  // touching the root affects /conversations, /agents, /projects,
  // /admin, / \u2026 which all rely on that same breathing room.
  // Cancelling locally keeps the diff scoped to /chat.
  return (
    <div className="-mx-4 lg:-mx-6 -my-6 h-[calc(100dvh-3.5rem)] min-h-0">
      {children}
    </div>
  );
}
