import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { postUserMessage } from '@/lib/dust/chat';

export const runtime = 'nodejs';

const Body = z.object({
  content: z.string().min(1),
  mcpServerIds: z.array(z.string()).optional(),
  /** See POST /api/conversations for the files shape. */
  fileIds: z.array(z.string().regex(/^fil_/)).optional(),
  fileMetas: z
    .array(z.object({ sId: z.string(), name: z.string() }))
    .optional(),
});

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

  // Persist a hint about attached files on the local Message row by
  // appending a small marker to content (Franck 2026-04-23 16:59).
  // Proper file tracking would need a schema migration (FileAttachment
  // table); the marker is enough for the UI to show the names on
  // reload, and the actual Dust content fragment carries the real
  // data server-side.
  const attachmentSuffix =
    fileMetas && fileMetas.length > 0
      ? '\n\n_Attachments: ' + fileMetas.map((f) => f.name).join(', ') + '_'
      : '';
  await db.message.create({
    data: { conversationId: id, role: 'user', content: content + attachmentSuffix },
  });
  await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } });

  return NextResponse.json({
    userMessageSId: res.userMessageSId,
    dustConversationSId: res.dustConversationSId,
  });
}
