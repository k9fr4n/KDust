import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { postUserMessage } from '@/lib/dust/chat';

export const runtime = 'nodejs';

const Body = z.object({
  content: z.string().min(1),
  mcpServerIds: z.array(z.string()).optional(),
  /** See POST /api/conversation for the files shape. */
  fileIds: z.array(z.string().regex(/^fil_/)).optional(),
  fileMetas: z
    .array(
      z.object({
        sId: z.string(),
        name: z.string(),
        contentType: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Build the markdown suffix appended to the locally persisted
 * user message so chat reloads show the attachments (Franck
 * 2026-04-23 17:16). Image mime types render as inline thumbnails
 * via the <ChatImage /> renderer (src rewritten by MessageMarkdown
 * to our /api/files proxy); other files show as a download link to
 * the same proxy.
 */
function buildAttachmentSuffix(
  metas: Array<{ sId: string; name: string; contentType?: string }> | undefined,
): string {
  if (!metas || metas.length === 0) return '';
  const lines = metas.map((f) => {
    const isImage = (f.contentType ?? '').startsWith('image/');
    if (isImage) {
      // Markdown image; MessageMarkdown's img renderer will rewrite
      // the bare `fil_xxx` src to /api/files/fil_xxx and render via
      // ChatImage (thumbnail + lightbox + download).
      return `![${f.name}](${f.sId})`;
    }
    // Non-image: link to the proxy, force-download param so the
    // user gets a real save dialog. Files rendered this way still
    // live on Dust \u2014 we don't copy them locally.
    return `[\ud83d\udcce ${f.name}](/api/files/${f.sId})`;
  });
  return '\n\n' + lines.join('\n');
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });

  const conv = await db.conversation.findUnique({ where: { id } });
  if (!conv || !conv.dustConversationSId)
    return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const { content, mcpServerIds, fileIds, fileMetas } = parsed.data;
  const res = await postUserMessage(
    conv.dustConversationSId,
    conv.agentSId,
    content,
    mcpServerIds,
    'cli',
    fileIds,
    fileMetas,
  );

  // Persist attachment references as markdown appended to content
  // so reloads render the same thumbnails / links the composer
  // showed at send time (Franck 2026-04-23 17:16). Proper file
  // tracking would need a schema migration; markdown is enough
  // for the UI.
  await db.message.create({
    data: {
      conversationId: id,
      role: 'user',
      content: content + buildAttachmentSuffix(fileMetas),
      // See POST /api/conversation: stamp the Dust user-message sId
      // so the pull-on-open sync skips this row instead of trying
      // to backfill it.
      dustMessageSId: res.userMessageSId,
    },
  });
  await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } });

  return NextResponse.json({
    userMessageSId: res.userMessageSId,
    dustConversationSId: res.dustConversationSId,
  });
}
