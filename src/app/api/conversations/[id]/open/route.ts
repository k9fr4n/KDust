import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { CURRENT_PROJECT_COOKIE } from '@/lib/current-project';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/conversations/:id/open
 *
 * Sets the current-project cookie to match the conversation's project (so the
 * /chat layout guard lets the user through), then redirects to /chat?id=:id.
 * Used by dashboard "Recent conversations" links so a user can jump directly
 * into a conv even from the "All projects" view.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conv = await db.conversation.findUnique({
    where: { id },
    select: { projectName: true },
  });
  if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const store = await cookies();
  if (conv.projectName) {
    store.set(CURRENT_PROJECT_COOKIE, conv.projectName, {
      path: '/',
      sameSite: 'lax',
      httpOnly: false,
    });
  } else {
    // Global conv -> clear any project cookie
    store.delete(CURRENT_PROJECT_COOKIE);
  }
  return NextResponse.redirect(new URL(`/chat?id=${id}`, _req.url));
}
