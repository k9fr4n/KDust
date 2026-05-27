import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { CURRENT_PROJECT_COOKIE } from '@/lib/current-project';
import { buildProjectUrl } from '@/lib/project-url';
import { notFound } from "@/lib/api/responses";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/conversation/:id/open
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
  if (!conv) return notFound('not_found');

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
  // Redirect to the scope-prefixed chat URL so the ChatClient mounts
  // with the right hierarchy node resolved from the URL by
  // getCurrentScope() — without this the legacy `/chat/<id>` lands
  // with no URL scope and falls back to the cookie, which only
  // resolves project leaves (3 segments). Conversations attached to
  // a folder (projectName='<l1>/<l2>') would mount as root mode,
  // losing breadcrumbs and skipping fs-cli/task-runner ensure.
  // Franck 2026-05-27 bug fix.
  const redirect = conv.projectName
    ? buildProjectUrl(conv.projectName, `chat/${id}`)
    : `/chat/${id}`;
  return NextResponse.json({
    ok: true,
    projectName: conv.projectName ?? null,
    redirect,
  });
}
