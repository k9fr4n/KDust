import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { createDustConversation } from '@/lib/dust/chat';
import { getCurrentProjectName } from '@/lib/current-project';
import { badRequest } from "@/lib/api/responses";

export const runtime = 'nodejs';

export async function GET() {
  const project = await getCurrentProjectName();
  // Fetch conversations + current DustSession.workspaceId in
  // parallel. Workspace id is used by the /chat UI to build
  // correct https://dust.tt/w/<wsSId>/\u2026 links; without it we'd
  // fall back to 'w/0' which 404s on a real workspace like
  // afoH8Y2BIz.
  const [conversations, dustSession] = await Promise.all([
    db.conversation.findMany({
      where: project ? { projectName: project } : undefined,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        // Include the Dust sId so the UI can:
        //   \u2022 display it in the header (the short id users
        //     recognise from dust.tt, e.g. ZZ4Vo645fo)
        //   \u2022 build a correct open-in-dust link
        // Absent rows (Conversation created locally before first
        // Dust message) return null; the UI falls back to the
        // local cuid in that window.
        dustConversationSId: true,
        title: true,
        agentName: true,
        agentSId: true,
        updatedAt: true,
        projectName: true,
        pinned: true,
      },
      take: 100,
    }),
    db.dustSession.findUnique({
      where: { id: 1 },
      select: { workspaceId: true },
    }),
  ]);
  return NextResponse.json({
    conversations,
    workspaceId: dustSession?.workspaceId ?? null,
  });
}

const CreateSchema = z.object({
  agentSId: z.string().min(1),
  agentName: z.string().optional(),
  content: z.string().min(1),
  title: z.string().optional(),
  mcpServerIds: z.array(z.string()).optional(),
  /**
   * Pre-uploaded Dust file ids (from /api/files/upload) attached
   * to this first message as content fragments. fileMetas carries
   * the original filenames for a nicer fragment title surfaced in
   * the agent's context.
   */
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

// Same shape as in [id]/messages/route.ts. Kept duplicated to
// avoid a shared utility import just for 10 lines.
function buildAttachmentSuffix(
  metas: Array<{ sId: string; name: string; contentType?: string }> | undefined,
): string {
  if (!metas || metas.length === 0) return '';
  const lines = metas.map((f) => {
    const isImage = (f.contentType ?? '').startsWith('image/');
    if (isImage) return `![${f.name}](${f.sId})`;
    return `[\ud83d\udcce ${f.name}](/api/files/${f.sId})`;
  });
  return '\n\n' + lines.join('\n');
}

export async function POST(req: Request) {
  const parsed = CreateSchema.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());

  const project = await getCurrentProjectName();
  const { agentSId, agentName, content, title, mcpServerIds, fileIds, fileMetas } =
    parsed.data;

  const dust = await createDustConversation(
    agentSId,
    content,
    title,
    mcpServerIds,
    'cli',
    fileIds,
    fileMetas,
  );

  const derivedTitle = title && title.trim().length > 0
    ? title
    : content.slice(0, 80).replace(/\s+/g, ' ');

  const conv = await db.conversation.create({
    data: {
      dustConversationSId: dust.dustConversationSId,
      agentSId,
      agentName: agentName ?? null,
      title: derivedTitle,
      projectName: project,
      messages: {
        create: [
          {
            role: 'user',
            content: content + buildAttachmentSuffix(fileMetas),
          },
        ],
      },
    },
  });

  return NextResponse.json({
    id: conv.id,
    dustConversationSId: dust.dustConversationSId,
    userMessageSId: dust.userMessageSId,
  });
}
