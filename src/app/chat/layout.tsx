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
  // Padding cancel (Franck 2026-04-23 21:48, updated 2026-05-21).
  // RootLayout wraps every page in
  //   <main class="pl-14"><div class="px-4 lg:px-6 py-6">…</div></main>
  // The chat surface wants the full viewport width (minus the
  // sidebar's pl-14) so message area, composer and merged toolbar
  // reach the browser edges. We negate the inner div's px/py and
  // size the wrapper to the full dynamic viewport height (the new
  // chrome no longer steals 3.5rem at the top).
  //
  // Why negative margins rather than editing RootLayout: touching
  // the root affects /conversation, /agents, /projects, /admin, /
  // \u2026 which all rely on that same breathing room. Cancelling
  // locally keeps the diff scoped to /chat.
  // Mobile top bar (Franck 2026-05-21) eats 3rem at the very top
  // via `pt-12` on <main>. The chat shell wants the full remaining
  // viewport: `h-[calc(100dvh-3rem)] md:h-dvh`.
  return (
    <div className="-mx-4 lg:-mx-6 -my-6 h-[calc(100dvh-3rem)] md:h-dvh min-h-0">
      {children}
    </div>
  );
}
