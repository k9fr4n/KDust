import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { CURRENT_PROJECT_COOKIE } from '@/lib/current-project';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/conversations/:id/open
 *
 * Sets the current-project cookie to match the conversation's project (so the
 * /chat layout guard lets the user through) and returns the target URL.
 *
 * Why POST, not GET:
 * Next.js <Link> may prefetch GET URLs on hover/visibility. Since this route
 * has a side-effect (mutates a cookie), a prefetch of conv A followed by a
 * click on conv B would leave the cookie pointing at A's project, and the
 * user would be redirected to the wrong project's chat. Forcing POST means
 * the cookie is only written in response to an explicit click.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  return NextResponse.json({
    ok: true,
    projectName: conv.projectName ?? null,
    redirect: `/chat?id=${id}`,
  });
}
